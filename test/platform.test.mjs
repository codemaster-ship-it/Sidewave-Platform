import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import test, { after, before } from 'node:test';
import { MongoClient } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server-core';
import sharp from 'sharp';
import Stripe from 'stripe';
import { createApp } from '../server.mjs';
import { canPlay, plans, tracks } from '../dist/content.js';

const externalUri = process.env.MONGODB_TEST_URI;
const range = { Range: 'bytes=0-255' };
const password = 'fixture-passphrase-only-2026';
let testMongo;

before(async () => {
  if (!externalUri) testMongo = await MongoMemoryReplSet.create();
});
after(async () => { await testMongo?.stop(); });

async function serverFor(t, stripeConfig) {
  const uri = externalUri || testMongo.getUri();
  const database = 'sidewave_test_' + randomUUID().replaceAll('-', '');
  const temporary = createServer().listen(0, '127.0.0.1');
  await once(temporary, 'listening');
  const port = temporary.address().port;
  await new Promise(resolve => temporary.close(resolve));
  const origin = 'http://127.0.0.1:' + port;
  const app = await createApp({ mongoUri: uri, database, appOrigin: origin, stripeConfig });
  const mongo = new MongoClient(uri);
  t.after(async () => {
    await app.close();
    try { await mongo.db(database).dropDatabase(); } finally { await mongo.close(); }
  });
  app.server.listen(port, '127.0.0.1');
  await once(app.server, 'listening');
  function browser(cookie = '') {
    return async (path, body, status = 200, headers = {}) => {
      const options = { headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers } };
      if (body !== undefined) {
        options.method = 'POST';
        options.headers.Origin ??= origin;
        if (body instanceof FormData) options.body = body;
        else if (typeof body === 'string') options.body = body;
        else {
          options.body = JSON.stringify(body);
          options.headers['Content-Type'] = 'application/json';
        }
      }
      const response = await fetch(origin + path, options);
      assert.equal(response.status, status, path + ' returned ' + response.status + ' ' + (response.status >= 400 ? await response.clone().text() : ''));
      return response;
    };
  }
  return { browser, db: mongo.db(database) };
}

function asUser(browser, response) {
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  return browser(cookie.split(';')[0]);
}

test('the three tiers and audio entitlements use the product catalog', () => {
  assert.deepEqual(plans.map(plan => plan.id), ['free', 'pro', 'studio']);
  assert.equal(canPlay(null, tracks[0]), true);
  assert.equal(canPlay({ plan: 'free', unlocked: [] }, tracks[1]), false);
  assert.equal(canPlay({ plan: 'pro', unlocked: [] }, tracks[1]), true);
  assert.equal(canPlay({ plan: 'free', unlocked: [tracks[1].id] }, tracks[1]), true);
});

test('signed-in users share real posts and photos with approved connections', async t => {
  const { browser } = await serverFor(t);
  const guest = browser();
  const author = asUser(browser, await guest('/api/signup', { name: 'Test Author', username: 'test_author', password }));
  const viewer = asUser(browser, await guest('/api/signup', { name: 'Test Viewer', username: 'test_viewer', password }));
  await guest('/api/signup', { name: 'Duplicate', username: 'TEST_AUTHOR', password }, 409);
  await guest('/api/posts', { text: 'Sign-in boundary' }, 401);
  await author('/api/posts', { text: 'Origin check' }, 403, { Origin: 'https://example.invalid' });

  const entry = await (await author('/api/posts', { text: 'A note to the community.' }, 201)).json();
  const added = new FormData();
  added.append('photo', new Blob([await readFile(new URL('../dist/media/lake.jpg', import.meta.url))], { type: 'image/jpeg' }), 'lake.jpg');
  added.append('caption', 'Lakeside');
  const photo = await (await author('/api/photos', added, 201)).json();
  const original = await guest('/api/photo/' + photo.id);
  assert.equal(original.headers.get('content-type'), 'image/jpeg');
  assert.equal((await sharp(Buffer.from(await original.arrayBuffer())).metadata()).exif, undefined);
  assert.equal((await (await guest('/api/feed?kind=post')).json()).items[0].id, entry.id);

  await author('/api/settings', { name: 'Test Author', bio: 'A private profile bio.', visibility: 'private' });
  assert.equal((await (await viewer('/api/member/test_author')).json()).member.bio, null);
  assert.deepEqual((await (await viewer('/api/feed?kind=post')).json()).items, []);
  await viewer('/api/photo/' + photo.id, undefined, 404);
  await viewer('/api/connect', { username: 'test_author', action: 'request' });
  await guest('/api/photo/' + photo.id, undefined, 404);
  await author('/api/connect', { username: 'test_viewer', action: 'approve' });
  assert.equal((await (await viewer('/api/member/test_author')).json()).member.bio, 'A private profile bio.');
  assert.equal((await (await viewer('/api/feed?kind=photo')).json()).items[0].text, 'Lakeside');
  await viewer('/api/photo/' + photo.id);
  await viewer('/api/favorites', { id: photo.id, saved: true });
  assert.equal((await (await viewer('/api/feed?kind=photo&saved=1')).json()).items[0].id, photo.id);
  await viewer('/api/remove', { id: photo.id }, 404);
  await author('/api/connect', { username: 'test_viewer', action: 'remove' });
  assert.deepEqual((await (await viewer('/api/feed?kind=photo&saved=1')).json()).items, []);
  await viewer('/api/photo/' + photo.id, undefined, 404);
  await author('/api/remove', { id: photo.id });
  await author('/api/photo/' + photo.id, undefined, 404);

  const preview = await guest('/api/audio/night-transit', undefined, 206, range);
  assert.equal((await preview.arrayBuffer()).byteLength, 256);
  await viewer('/api/audio/night-transit?version=full', undefined, 403);
  await viewer('/api/flags', { id: 'listeningHistory', enabled: true }, 403);
  await author('/api/logout', {});
  assert.equal((await (await author('/api/session')).json()).account, null);
  const returned = asUser(browser, await guest('/api/login', { username: 'test_author', password }));
  assert.equal((await (await returned('/api/member/test_author')).json()).member.own, true);
  await returned('/api/checkout', { id: 'credits25' }, 503);
});

test('signed billing events reconcile once and a credit unlock survives a plan cancellation', async t => {
  const sdk = new Stripe('sk_test_fixture_value');
  const secret = 'whsec_fixture_value';
  const prices = { credits25: 'price_pack25', credits100: 'price_pack100', credits250: 'price_pack250', pro: 'price_pro', studio: 'price_studio' };
  const customer = 'cus_fixture';
  const checkoutId = 'cs_test_fixture';
  let checkout;
  let subscriptions = [];
  const stripe = {
    webhooks: sdk.webhooks,
    customers: { create: async () => ({ id: customer }) },
    prices: { retrieve: async () => ({ active: true, currency: 'usd', unit_amount: 300, type: 'one_time' }) },
    subscriptions: { list: () => ({ data: subscriptions, async *[Symbol.asyncIterator]() { yield* subscriptions; } }) },
    checkout: { sessions: {
      create: async input => {
        assert.deepEqual(input.line_items, [{ price: prices.credits25, quantity: 1 }]);
        checkout = { ...input, id: checkoutId, status: 'complete', payment_status: 'paid', amount_total: 300, currency: 'usd' };
        return { ...checkout, url: 'https://checkout.stripe.com/c/pay/cs_test_fixture' };
      },
      retrieve: async () => checkout,
      listLineItems: async () => ({ data: [{ price: { id: prices.credits25 }, quantity: 1 }], has_more: false })
    } }
  };
  const { browser } = await serverFor(t, { stripe, secret, prices });
  const guest = browser();
  const buyer = asUser(browser, await guest('/api/signup', { name: 'Test Buyer', username: 'test_buyer', password }));
  await buyer('/api/checkout', { id: 'credits25', requestId: randomUUID() });
  const payment = { id: 'evt_fixture', type: 'checkout.session.completed', data: { object: checkout } };
  function signed(event) {
    const json = JSON.stringify(event);
    const signature = sdk.webhooks.generateTestHeaderString({ payload: json, secret });
    return guest('/api/stripe/webhook', json, 200, { 'Stripe-Signature': signature, 'Content-Type': 'application/json' });
  }
  await guest('/api/stripe/webhook', JSON.stringify(payment), 400, { 'Stripe-Signature': 'invalid' });
  await Promise.all([signed(payment), signed(payment)]);
  const receipts = (await (await buyer('/api/receipts')).json()).receipts;
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].credits, 25);

  const event = { id: 'evt_fixture_subscription', type: 'customer.subscription.updated', data: { object: { customer } } };
  subscriptions = [{ status: 'active', items: { data: [{ price: { id: prices.pro }, current_period_end: Math.floor(Date.now() / 1000) + 3600 }] } }];
  await signed(event);
  assert.equal((await (await buyer('/api/session')).json()).account.plan, 'pro');
  await buyer('/api/flags', { id: 'listeningHistory', enabled: true });
  await buyer('/api/listened', { id: 'glass-horizon' });
  assert.equal((await (await buyer('/api/session')).json()).account.history[0].id, 'glass-horizon');
  await buyer('/api/audio/glass-horizon?version=full', undefined, 206, range);

  subscriptions = [];
  await signed({ ...event, type: 'customer.subscription.deleted' });
  await buyer('/api/audio/glass-horizon?version=full', undefined, 403);
  const purchases = await Promise.all([buyer('/api/unlock', { id: 'glass-horizon' }), buyer('/api/unlock', { id: 'glass-horizon' })]);
  for (const result of purchases) assert.equal((await result.json()).account.credits, 15);
  await buyer('/api/audio/glass-horizon?version=full', undefined, 206, range);
});
