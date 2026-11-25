import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { MongoClient } from 'mongodb';
import sharp from 'sharp';
import { canPlay, collection, eligible, features, tracks } from './dist/content.js';
import { billingFromEnv, makeBilling } from './billing.mjs';

const derive = promisify(scrypt);
const passwordOptions = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const placeholderSalt = randomBytes(16).toString('hex');
const placeholderHash = randomBytes(64);
const sessionLife = 7 * 86400;
const usernamePattern = /^[a-z0-9][a-z0-9_-]{2,23}$/;
const uidPattern = /^[a-f0-9-]{36}$/;
const photoLimit = 5 * 1024 * 1024;
const mime = { html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', jpg: 'image/jpeg', mp3: 'audio/mpeg', svg: 'image/svg+xml' };
const staticPaths = new Map([['/', 'index.html'], ['/style.css', 'style.css'], ['/app.js', 'app.js'], ['/content.js', 'content.js'], ['/favicon.svg', 'favicon.svg'], ['/og-image.svg', 'og-image.svg']]);
for (const id of ['lake', 'shore', 'ridge', 'dawn', 'night']) staticPaths.set('/media/' + id + '.jpg', 'media/' + id + '.jpg');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function respond(res, status, data, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(data));
}

function setSecurityHeaders(res, https) {
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; media-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (https) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

function checkOrigin(req, origin) {
  if (req.headers.origin !== origin) throw new HttpError(403, 'Start this action from tunecloud.');
}

async function bodyBytes(req, maximum) {
  if (Number(req.headers['content-length'] ?? 0) > maximum) {
    req.resume();
    throw new HttpError(413, 'That upload is too large.');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maximum) {
      req.resume();
      throw new HttpError(413, 'That upload is too large.');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new HttpError(415, 'Expected JSON.');
  const bytes = await bodyBytes(req, 8192);
  let value;
  try { value = JSON.parse(bytes.toString()); } catch { throw new HttpError(400, 'Enter valid data.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Enter valid data.');
  return value;
}

function limitRequests() {
  const windows = new Map();
  return (key, maximum) => {
    const now = Date.now();
    if (windows.size >= 4000) {
      for (const [id, window] of windows) if (window.until <= now) windows.delete(id);
      if (windows.size >= 4000 && !windows.has(key)) throw new HttpError(429, 'Try again in a minute.');
    }
    let window = windows.get(key);
    if (!window || window.until <= now) {
      window = { until: now + 60_000, count: 0 };
      windows.set(key, window);
    }
    if (++window.count > maximum) throw new HttpError(429, 'Try again in a minute.');
  };
}

const digest = token => createHash('sha256').update(token).digest('hex');
const planFor = account => account.activeUntil instanceof Date && account.activeUntil > new Date() ? account.plan : 'free';
const serialize = account => ({
  username: account.username, name: account.name, bio: account.bio, visibility: account.visibility,
  plan: planFor(account), credits: account.credits, flags: account.flags,
  unlocked: account.unlocked, favorites: account.favorites, history: account.history,
  billingProfile: Boolean(account.stripeCustomer)
});

function stringField(input, maximum) {
  if (typeof input !== 'string' || input.trim().length > maximum) throw new HttpError(400, 'Check the length of the text and try again.');
  return input.trim();
}

function pageCursor(params) {
  const before = params.get('before');
  if (!before) return {};
  const [stamp, id] = before.split('_');
  const date = new Date(Number(stamp));
  if (isNaN(date.getTime()) || !uidPattern.test(id ?? '')) throw new HttpError(400, 'Invalid page cursor.');
  return { $or: [{ createdAt: { $lt: date } }, { createdAt: date, _id: { $lt: id } }] };
}

function sendBytes(req, res, bytes, type, cache = 'no-cache') {
  const headers = { 'Content-Type': type, 'Cache-Control': cache };
  const requestedRange = type === 'audio/mpeg' && req.headers.range;
  if (requestedRange) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(requestedRange);
    const start = match?.[1] ? Number(match[1]) : Math.max(0, bytes.length - Number(match?.[2]));
    const end = match?.[1] && match[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1;
    if (!match || !Number.isSafeInteger(start) || start < 0 || start > end) {
      res.writeHead(416, { ...headers, 'Content-Range': 'bytes */' + bytes.length });
      return res.end();
    }
    res.writeHead(206, { ...headers, 'Accept-Ranges': 'bytes', 'Content-Range': 'bytes ' + start + '-' + end + '/' + bytes.length, 'Content-Length': end - start + 1 });
    return res.end(req.method === 'HEAD' ? undefined : bytes.subarray(start, end + 1));
  }
  res.writeHead(200, { ...headers, 'Content-Length': bytes.length, ...(type === 'audio/mpeg' ? { 'Accept-Ranges': 'bytes' } : {}) });
  res.end(req.method === 'HEAD' ? undefined : bytes);
}

async function normalizePhoto(file, size) {
  const bytes = Buffer.from(await file.arrayBuffer());
  const jpeg = bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const webp = bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (!jpeg && !png && !webp) throw new HttpError(415, 'Choose a JPEG, PNG, or WebP photo.');
  try {
    return await sharp(bytes, { limitInputPixels: 24_000_000 })
      .rotate().resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' }).jpeg({ quality: 85 }).toBuffer({ resolveWithObject: true });
  } catch {
    throw new HttpError(400, 'This photo could not be opened. Try a JPEG, PNG, or WebP under 24 megapixels.');
  }
}

export async function createApp({ mongoUri, database = 'tunecloud', appOrigin = 'http://localhost:3000', stripeConfig = null }) {
  if (!mongoUri) throw new Error('Set MONGODB_URI before starting tunecloud.');
  const origin = new URL(appOrigin).origin;
  const https = origin.startsWith('https:');
  if (!https && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname)) throw new Error('Use HTTPS for a deployed APP_ORIGIN.');
  const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 6000, promoteBuffers: true });
  const db = client.db(database);
  const accounts = db.collection('accounts');
  const sessions = db.collection('sessions');
  const entries = db.collection('entries');
  const relations = db.collection('connections');
  const orders = db.collection('credit_orders');

  try {
    await client.connect();
    if (stripeConfig) {
      const topology = await db.admin().command({ hello: 1 });
      if (!topology.setName && topology.msg !== 'isdbgrid') throw new Error('Stripe fulfillment requires a MongoDB replica set or Atlas.');
    }
    await Promise.all([
      accounts.createIndex({ username: 1 }, { unique: true }),
      accounts.createIndex({ stripeCustomer: 1 }, { unique: true, sparse: true }),
      sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      entries.createIndex({ kind: 1, createdAt: -1, _id: -1 }),
      entries.createIndex({ authorId: 1, kind: 1, createdAt: -1, _id: -1 }),
      relations.createIndex({ ownerId: 1, viewerId: 1 }, { unique: true }),
      relations.createIndex({ viewerId: 1, status: 1 }),
      orders.createIndex({ accountId: 1, createdAt: -1 })
    ]);
  } catch (error) { await client.close(); throw error; }

  const billing = makeBilling({ config: stripeConfig, client, accounts, orders, origin, HttpError });
  const rate = limitRequests();
  const cookieName = https ? '__Host-tunecloud' : 'tunecloud';
  const cookie = (token, maxAge) => cookieName + '=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAge + (https ? '; Secure' : '');
  let pendingHashes = 0;
  let uploads = 0;

  async function currentSession(req) {
    const token = req.headers.cookie?.split(/;\s*/).find(item => item.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
    return token && /^[a-f0-9]{64}$/.test(token) ? sessions.findOne({ _id: digest(token), expiresAt: { $gt: new Date() } }) : null;
  }

  async function issueSession(res, previous, account) {
    const token = randomBytes(32).toString('hex');
    await sessions.insertOne({ _id: digest(token), accountId: account._id, expiresAt: new Date(Date.now() + sessionLife * 1000) });
    if (previous) await sessions.deleteOne({ _id: previous._id });
    respond(res, 200, { account: serialize(account) }, { 'Set-Cookie': cookie(token, sessionLife) });
  }

  async function authenticate(req, res, action) {
    checkOrigin(req, origin);
    const body = await readJson(req);
    const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!usernamePattern.test(username) || !password.length || Buffer.byteLength(password) > 256) throw new HttpError(400, 'Enter a valid username and password.');
    rate('attempt:' + (req.socket.remoteAddress ?? 'local'), 75);
    rate('auth:' + username, 8);
    if (pendingHashes >= 5) throw new HttpError(429, 'Try signing in again shortly.');
    pendingHashes++;
    try {
      const previous = await currentSession(req);
      if (action === '/api/signup') {
        const name = stringField(body.name, 45);
        if (name.length < 2 || password.length < 12) throw new HttpError(400, 'Enter a display name and a password of at least 12 characters.');
        const salt = randomBytes(16).toString('hex');
        const hash = (await derive(password, salt, 64, passwordOptions)).toString('hex');
        const account = { _id: randomUUID(), username, name, salt, hash, bio: '', visibility: 'public', plan: 'free',
          credits: 0, unlocked: [], favorites: [], history: [], flags: { listeningHistory: false, highResolution: false } };
        try { await accounts.insertOne(account); } catch (error) {
          if (error.code === 11000) throw new HttpError(409, 'That username is already in use.');
          throw error;
        }
        return issueSession(res, previous, account);
      }
      const account = await accounts.findOne({ username });
      const actual = await derive(password, account?.salt ?? placeholderSalt, 64, passwordOptions);
      if (!timingSafeEqual(account ? Buffer.from(account.hash, 'hex') : placeholderHash, actual) || !account) throw new HttpError(401, 'Username or password is incorrect.');
      return issueSession(res, previous, account);
    } finally { pendingHashes--; }
  }

  async function writeAccount(res, id, update) {
    const saved = await accounts.findOneAndUpdate({ _id: id }, update, { returnDocument: 'after' });
    respond(res, 200, { account: serialize(saved) });
  }

  async function relationship(owner, account) {
    if (!account || owner._id === account._id) return null;
    return relations.findOne({ ownerId: owner._id, viewerId: account._id });
  }

  async function canView(owner, viewer) {
    return owner && (owner.visibility === 'public' || owner._id === viewer?._id || (await relationship(owner, viewer))?.status === 'approved');
  }

  async function authorFor(username) {
    if (!usernamePattern.test(username)) throw new HttpError(404, 'Member not found.');
    const author = await accounts.findOne({ username }, { projection: { username: 1, name: 1, bio: 1, visibility: 1 } });
    if (!author) throw new HttpError(404, 'Member not found.');
    return author;
  }

  async function feed(params, viewer) {
    const kind = params.get('kind') ?? 'post';
    if (!['post', 'photo'].includes(kind)) throw new HttpError(400, 'Choose posts or photos.');
    const match = { kind, ...pageCursor(params) };
    if (params.has('member')) match.authorId = (await authorFor(params.get('member')))._id;
    if (params.has('saved')) {
      match.kind = 'photo';
      match._id = { $in: viewer?.favorites.filter(id => uidPattern.test(id)) ?? [] };
    }
    const viewerId = viewer?._id ?? '';
    const rows = await entries.aggregate([
      { $match: match }, { $sort: { createdAt: -1, _id: -1 } },
      { $project: { kind: 1, text: 1, createdAt: 1, authorId: 1, width: 1, height: 1 } },
      { $lookup: { from: 'accounts', localField: 'authorId', foreignField: '_id', as: 'author',
        pipeline: [{ $project: { username: 1, name: 1, visibility: 1 } }] } },
      { $unwind: '$author' },
      { $lookup: { from: 'connections', localField: 'authorId', foreignField: 'ownerId', as: 'grant',
        pipeline: [{ $match: { viewerId, status: 'approved' } }, { $limit: 1 }] } },
      { $match: { $or: [{ 'author.visibility': 'public' }, { authorId: viewerId }, { 'grant.0': { $exists: true } }] } },
      { $limit: 19 }
    ]).toArray();
    const page = rows.slice(0, 18);
    const last = page.at(-1);
    return {
      items: page.map(item => ({
        id: item._id, kind: item.kind, text: item.text, date: item.createdAt,
        author: { username: item.author.username, name: item.author.name }, own: item.authorId === viewerId,
        ...(item.kind === 'photo' ? { width: item.width, height: item.height } : {})
      })),
      next: rows.length === 19 ? last.createdAt.getTime() + '_' + last._id : null
    };
  }

  async function uploadPhoto(req, res, account) {
    const contentType = req.headers['content-type'] ?? '';
    if (!contentType.startsWith('multipart/form-data;')) throw new HttpError(415, 'Choose an image to upload.');
    if (uploads >= 4) throw new HttpError(429, 'Uploads are busy. Try again shortly.');
    rate('upload:' + account._id, 8);
    uploads++;
    try {
      const raw = await bodyBytes(req, photoLimit + 32_768);
      let form;
      try { form = await new Request(origin, { method: 'POST', headers: { 'Content-Type': contentType }, body: raw }).formData(); } catch {
        throw new HttpError(400, 'The photo upload could not be read.');
      }
      const file = form.get('photo');
      if (!(file instanceof File) || !file.size || file.size > photoLimit) throw new HttpError(400, 'Upload one image, up to 5 MB.');
      const text = stringField(form.get('caption') ?? '', 280);
      const size = eligible(planFor(account), 'studio') && account.flags.highResolution ? 1800 : 1200;
      const { data, info } = await normalizePhoto(file, size);
      const id = randomUUID();
      await entries.insertOne({ _id: id, authorId: account._id, kind: 'photo', text, createdAt: new Date(), width: info.width, height: info.height, image: data });
      return respond(res, 201, { id });
    } finally { uploads--; }
  }

  async function handle(req, res) {
    setSecurityHeaders(res, https);
    const url = new URL(req.url, origin);
    const path = url.pathname;
    const read = ['GET', 'HEAD'].includes(req.method);
    if (staticPaths.has(path) && read) {
      const file = staticPaths.get(path);
      return sendBytes(req, res, await readFile(new URL('./dist/' + file, import.meta.url)), mime[file.split('.').at(-1)]);
    }
    if (!path.startsWith('/api/') || (!read && req.method !== 'POST')) throw new HttpError(404, 'Page not found.');
    if (path === '/api/stripe/webhook' && req.method === 'POST' && billing) {
      await billing.webhook(await bodyBytes(req, 262_144), req.headers['stripe-signature']);
      return respond(res, 200, { received: true });
    }
    if (req.method === 'POST' && ['/api/signup', '/api/login'].includes(path)) return authenticate(req, res, path);

    const session = await currentSession(req);
    const account = session && await accounts.findOne({ _id: session.accountId }, { projection: { salt: 0, hash: 0 } });
    if (read && path === '/api/session') return respond(res, 200, { account: account ? serialize(account) : null, payments: Boolean(billing) });
    if (read && path === '/api/feed') return respond(res, 200, await feed(url.searchParams, account));
    if (read && path === '/api/members') {
      const query = (url.searchParams.get('q') ?? '').trim().toLowerCase();
      if (!/^[a-z0-9_-]{1,24}$/.test(query)) return respond(res, 200, { members: [] });
      const rows = await accounts.find({ username: new RegExp('^' + query) }, { projection: { name: 1, username: 1, visibility: 1, _id: 0 } }).sort({ username: 1 }).limit(12).toArray();
      return respond(res, 200, { members: rows });
    }
    if (read && path.startsWith('/api/member/')) {
      const owner = await authorFor(path.slice('/api/member/'.length));
      const connection = await relationship(owner, account);
      const own = account?._id === owner._id;
      const visible = own || owner.visibility === 'public' || connection?.status === 'approved';
      return respond(res, 200, { member: { username: owner.username, name: owner.name, bio: visible ? owner.bio : null,
        visibility: owner.visibility, connection: connection?.status ?? null, own, visible } });
    }
    if (read && path.startsWith('/api/photo/')) {
      const id = path.slice('/api/photo/'.length);
      if (!uidPattern.test(id)) throw new HttpError(404, 'Photo unavailable.');
      const info = await entries.findOne({ _id: id, kind: 'photo' }, { projection: { authorId: 1 } });
      const owner = info && await accounts.findOne({ _id: info.authorId }, { projection: { visibility: 1 } });
      if (!await canView(owner, account)) throw new HttpError(404, 'Photo unavailable.');
      const item = await entries.findOne({ _id: id, kind: 'photo', authorId: owner._id }, { projection: { image: 1 } });
      if (!item) throw new HttpError(404, 'Photo unavailable.');
      return sendBytes(req, res, item.image, 'image/jpeg', 'private, no-store');
    }
    if (read && path.startsWith('/api/audio/')) {
      const track = tracks.find(item => item.id === path.slice('/api/audio/'.length));
      if (!track) throw new HttpError(404, 'Track unavailable.');
      const full = url.searchParams.get('version') === 'full';
      if (full && !canPlay(account ? serialize(account) : null, track)) throw new HttpError(403, 'Unlock the track or join Plus to listen.');
      const recording = track.credits === 0 ? './dist/media/afterglow.mp3'
        : full ? './private-media/' + track.id + '.mp3' : './dist/media/' + track.id + '-preview.mp3';
      return sendBytes(req, res, await readFile(new URL(recording, import.meta.url)), 'audio/mpeg', 'private, no-store');
    }

    if (!account) throw new HttpError(401, 'Sign in to continue.');
    const ownerId = account._id;
    if (read && path === '/api/connections') {
      const incoming = await relations.aggregate([
        { $match: { ownerId } }, { $sort: { createdAt: -1 } }, { $limit: 120 },
        { $lookup: { from: 'accounts', localField: 'viewerId', foreignField: '_id', as: 'person', pipeline: [{ $project: { username: 1, name: 1 } }] } },
        { $unwind: '$person' }
      ]).toArray();
      return respond(res, 200, { connections: incoming.map(item => ({ username: item.person.username, name: item.person.name, status: item.status })) });
    }
    if (read && path === '/api/receipts') {
      const receipts = await orders.find({ accountId: ownerId }, { projection: { _id: 0, credits: 1, total: 1, currency: 1, createdAt: 1 } })
        .sort({ createdAt: -1 }).limit(20).toArray();
      return respond(res, 200, { receipts });
    }

    if (req.method !== 'POST') throw new HttpError(404, 'Page not found.');
    checkOrigin(req, origin);
    if (path === '/api/photos') return uploadPhoto(req, res, account);
    const body = await readJson(req);

    switch (path) {
      case '/api/logout':
        await sessions.deleteOne({ _id: session._id });
        return respond(res, 200, { account: null }, { 'Set-Cookie': cookie('', 0) });
      case '/api/settings': {
        const name = stringField(body.name, 45);
        const bio = stringField(body.bio, 160);
        if (name.length < 2 || !['public', 'private'].includes(body.visibility)) throw new HttpError(400, 'Enter a name and visibility setting.');
        return writeAccount(res, ownerId, { $set: { name, bio, visibility: body.visibility } });
      }
      case '/api/flags': {
        const feature = features.find(item => item.id === body.id);
        if (!feature || typeof body.enabled !== 'boolean') throw new HttpError(400, 'Choose an available feature.');
        if (body.enabled && !eligible(planFor(account), feature.plan)) throw new HttpError(403, 'Upgrade your plan to turn on this feature.');
        const patch = { ['flags.' + feature.id]: body.enabled };
        if (feature.id === 'listeningHistory' && !body.enabled) patch.history = [];
        return writeAccount(res, ownerId, { $set: patch });
      }
      case '/api/posts': {
        rate('post:' + ownerId, 12);
        const text = stringField(body.text, 500);
        if (!text) throw new HttpError(400, 'Write something before publishing.');
        const id = randomUUID();
        await entries.insertOne({ _id: id, authorId: ownerId, kind: 'post', text, createdAt: new Date() });
        return respond(res, 201, { id });
      }
      case '/api/remove': {
        if (typeof body.id !== 'string' || !uidPattern.test(body.id)) throw new HttpError(404, 'Item not found.');
        const result = await entries.deleteOne({ _id: body.id, authorId: ownerId });
        if (!result.deletedCount) throw new HttpError(404, 'Item not found.');
        return respond(res, 200, { removed: true });
      }
      case '/api/connect': {
        const member = await authorFor(typeof body.username === 'string' ? body.username : '');
        if (member._id === ownerId) throw new HttpError(400, 'Choose another member.');
        if (body.action === 'request') {
          rate('connection:' + ownerId, 20);
          try {
            await relations.updateOne({ ownerId: member._id, viewerId: ownerId }, { $setOnInsert: { status: 'pending', createdAt: new Date() } }, { upsert: true });
          } catch (error) { if (error.code !== 11000) throw error; }
        } else if (body.action === 'withdraw') {
          await relations.deleteOne({ ownerId: member._id, viewerId: ownerId });
        } else if (body.action === 'approve') {
          const result = await relations.updateOne({ ownerId, viewerId: member._id }, { $set: { status: 'approved' } });
          if (!result.matchedCount) throw new HttpError(404, 'This request is no longer available.');
        } else if (body.action === 'remove') {
          await relations.deleteOne({ ownerId, viewerId: member._id });
        } else throw new HttpError(400, 'Choose a connection action.');
        return respond(res, 200, { saved: true });
      }
      case '/api/favorites': {
        const id = typeof body.id === 'string' && body.id;
        if (!id || typeof body.saved !== 'boolean') throw new HttpError(400, 'Choose a photo.');
        if (body.saved) {
          if (!collection.some(photo => id === 'field-' + photo.id)) {
            if (!uidPattern.test(id)) throw new HttpError(404, 'Photo unavailable.');
            const item = await entries.findOne({ _id: id, kind: 'photo' }, { projection: { authorId: 1 } });
            const owner = item && await accounts.findOne({ _id: item.authorId }, { projection: { visibility: 1 } });
            if (!await canView(owner, account)) throw new HttpError(404, 'Photo unavailable.');
          }
          const saved = await accounts.findOneAndUpdate({ _id: ownerId, $or: [{ 'favorites.499': { $exists: false } }, { favorites: id }] },
            { $addToSet: { favorites: id } }, { returnDocument: 'after' });
          if (!saved) throw new HttpError(409, 'Remove a favorite before saving another.');
          return respond(res, 200, { account: serialize(saved) });
        }
        return writeAccount(res, ownerId, { $pull: { favorites: id } });
      }
      case '/api/unlock': {
        const track = tracks.find(item => item.id === body.id && item.credits > 0);
        if (!track) throw new HttpError(404, 'Track unavailable.');
        if (canPlay(serialize(account), track)) return respond(res, 200, { account: serialize(account) });
        const updated = await accounts.findOneAndUpdate({ _id: ownerId, credits: { $gte: track.credits }, unlocked: { $ne: track.id } },
          { $inc: { credits: -track.credits }, $addToSet: { unlocked: track.id } }, { returnDocument: 'after' });
        const latest = updated ?? await accounts.findOne({ _id: ownerId });
        if (!canPlay(serialize(latest), track)) throw new HttpError(409, 'You need more credits to unlock this track.');
        return respond(res, 200, { account: serialize(latest) });
      }
      case '/api/listened': {
        const track = tracks.find(item => item.id === body.id);
        if (!track || !eligible(planFor(account), 'pro') || !account.flags.listeningHistory) return respond(res, 200, { account: serialize(account) });
        const updated = await accounts.findOneAndUpdate({ _id: ownerId, 'flags.listeningHistory': true, activeUntil: { $gt: new Date() } },
          { $push: { history: { $each: [{ id: track.id, at: new Date() }], $position: 0, $slice: 30 } } }, { returnDocument: 'after' });
        return respond(res, 200, { account: serialize(updated ?? await accounts.findOne({ _id: ownerId })) });
      }
      case '/api/checkout':
      case '/api/portal': {
        if (!billing) throw new HttpError(503, 'Payments are currently unavailable.');
        rate('billing:' + ownerId, 8);
        const url = path === '/api/checkout' ? await billing.openCheckout(account, body.id, body.requestId) : await billing.openPortal(account);
        return respond(res, 200, { url });
      }
      default: throw new HttpError(404, 'Page not found.');
    }
  }

  const server = createServer({ requestTimeout: 25_000, headersTimeout: 10_000 }, (req, res) => {
    handle(req, res).catch(error => {
      if (res.destroyed) return;
      if (res.headersSent) { res.destroy(); return; }
      if (!(error instanceof HttpError)) console.error('tunecloud request failed', error.name, error.code ?? '');
      respond(res, error instanceof HttpError ? error.status : 500, { error: error instanceof HttpError ? error.message : 'Something went wrong. Try again.' });
    });
  });
  return { server, close: async () => {
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await client.close();
  } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  const stripeConfig = billingFromEnv();
  let app;
  let localMongo;

  async function close() {
    try {
      await app?.close();
    } finally {
      await localMongo?.stop({ doCleanup: false });
    }
  }

  try {
    let mongoUri = process.env.MONGODB_URI;
    if (!mongoUri) {
      if (stripeConfig) throw new Error('Set MONGODB_URI to a MongoDB replica set or Atlas to enable Stripe.');
      const dbPath = fileURLToPath(new URL('./.sidewave-data/', import.meta.url));
      await mkdir(dbPath, { recursive: true, mode: 0o700 });
      const { MongoMemoryServer } = await import('mongodb-memory-server-core');
      console.log('Starting local MongoDB (the first run may download MongoDB).');
      localMongo = await MongoMemoryServer.create({ instance: { dbPath, ip: '127.0.0.1', storageEngine: 'wiredTiger' } });
      mongoUri = localMongo.getUri();
    }

    app = await createApp({ mongoUri, database: process.env.MONGODB_DATABASE,
      appOrigin: process.env.APP_ORIGIN ?? 'http://localhost:' + port, stripeConfig });
    app.server.listen(port, process.env.BIND_HOST ?? '127.0.0.1');
    await once(app.server, 'listening');
  } catch (error) {
    await close();
    throw error;
  }

  let closing;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      closing ??= close().catch(error => {
        console.error('tunecloud shutdown failed:', error.message);
        process.exitCode = 1;
      });
    });
  }
  console.log('tunecloud is listening on port ' + app.server.address().port);
}
