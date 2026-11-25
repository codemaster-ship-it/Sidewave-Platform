import { canPlay, collection, creditPacks, eligible, features, plans, tracks } from './content.js';

const icons = {
  logo: '<path d="M22 18c0 2.2-1.8 4-4 4H6c-2.2 0-4-1.8-4-4V14c0-1.1.9-2 2-2h2c.6 0 1-.4 1-1V7c0-2.2 1.8-4 4-4s4 1.8 4 4v1c0 .6.4 1 1 1h8c2.2 0 4 1.8 4 4v4z"/><path d="M8 20v-6M11 20v-9M14 20v-4M17 20v-8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  home: '<path d="m3 10 9-7 9 7v10H3zm6 10v-7h6v7"/>',
  people: '<circle cx="9" cy="8" r="3"/><path d="M3 21v-2c0-3 2-5 5-5h2c3 0 5 2 5 5v2m2-16a3 3 0 0 1 0 6m1 3c2 0 3 2 3 5"/>',
  photo: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m21 17-6-6-8 9"/>',
  music: '<path d="M9 17V6l11-2v11"/><ellipse cx="6" cy="17" rx="3" ry="2.5"/><ellipse cx="17" cy="15" rx="3" ry="2.5"/>',
  settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="2.5" fill="currentColor"/><circle cx="15" cy="17" r="2.5" fill="currentColor"/>',
  credit: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18m-14 5h3"/>',
  search: '<circle cx="10.5" cy="10.5" r="5.5"/><path d="m15 15 5 5"/>',
  play: '<path fill="currentColor" stroke="none" d="M8 4.5v15l12-7.5z"/>',
  pause: '<path d="M9 5v14m6-14v14" stroke-width="3"/>',
  heart: '<path d="M20.5 5.8a5 5 0 0 0-7.1 0L12 7.2l-1.4-1.4a5 5 0 1 0-7.1 7.1L12 21l8.5-8.1a5 5 0 0 0 0-7.1Z"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="m6 6 12 12m0-12L6 18"/>',
  more: '<path d="M5 12h.01M12 12h.01M19 12h.01" stroke-width="3.5"/>',
  left: '<path d="m15 6-6 6 6 6"/>',
  next: '<path fill="currentColor" stroke="none" d="M5 5v14l11-7z"/><path d="M19 6v12"/>',
  previous: '<path fill="currentColor" stroke="none" d="M19 5v14L8 12z"/><path d="M5 6v12"/>',
  volume: '<path d="M4 10v4h4l5 4V6l-5 4zm12-1a4 4 0 0 1 0 6m2-9a8 8 0 0 1 0 12"/>',
  mute: '<path d="M4 10v4h4l5 4V6l-5 4zm12 0 4 4m0-4-4 4"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  wave: '<path d="M4 11v2m4-6v10m4-13v16m4-11v6m4-4v2"/>'
};

const icon = id => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + icons[id] + '</svg>';
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const layout = document.querySelector('#layout');
const dialog = document.querySelector('#dialog');
const audio = document.querySelector('#audio');
const player = document.querySelector('#player');
const toast = document.querySelector('#toast');
const price = cents => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(cents / 100);
const dateLabel = input => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(input));
const clock = seconds => Math.floor(seconds / 60) + ':' + String(Math.floor(seconds % 60)).padStart(2, '0');
const names = { home: 'Home', community: 'Stream', photos: 'Moments', music: 'Tracks', account: 'Settings', billing: 'Go Pro', member: 'Profile', search: 'Search' };
const userRoute = username => 'member/' + esc(username);

const state = { account: null, payments: false, connecting: true, failure: '', data: null, error: '', current: null, search: '', photoMode: 'all' };
let epoch = 0;
let busy = false;
let hideToast;
let photoObjectUrl;
let checkoutAttempt;
const currentRoute = () => location.hash.slice(1) || 'home';
const page = () => currentRoute().split('/')[0];

function flash(message) {
  clearTimeout(hideToast);
  toast.textContent = message;
  toast.hidden = false;
  hideToast = setTimeout(() => { toast.hidden = true; }, 4300);
}

async function api(path, body) {
  const multipart = body instanceof FormData;
  const response = await fetch('/api/' + path, body === undefined ? { cache: 'no-store' } : {
    method: 'POST', ...(multipart ? {} : { headers: { 'Content-Type': 'application/json' } }),
    body: multipart ? body : JSON.stringify(body)
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'Please try again.');
  return value;
}

function button(label, action, type = '', glyph = '', attrs = '') {
  return `<button type="button" class="button ${type}" data-action="${action}" ${attrs}>${glyph ? icon(glyph) : ''}${label}</button>`;
}

function link(label, route, type = '', glyph = '') {
  return `<a class="button ${type}" href="#${route}">${glyph ? icon(glyph) : ''}${label}</a>`;
}

function initials(name) {
  return String(name).trim().split(/\s+/).slice(0, 2).map(word => esc(word[0]?.toUpperCase())).join('');
}

function avatar(name, size = '') {
  return '<span class="avatar ' + size + '" aria-hidden="true">' + initials(name) + '</span>';
}

function heading(title, description, action = '') {
  return `<header class="page-heading"><div><h1>${title}</h1><p>${description}</p></div>${action}</header>`;
}

function nav(label, route, glyph) {
  return `<a class="nav-link" href="#${route}"${page() === route ? ' aria-current="page"' : ''}>${icon(glyph)}<span>${label}</span></a>`;
}

function render() {
  const focusedAction = layout.contains(document.activeElement) && document.activeElement.dataset.action;
  const route = page();
  const pages = { home, community, photos, music, billing, account, member, search };
  const body = state.connecting ? '<section class="panel"><p role="status">Connecting to tunecloud…</p></section>'
    : state.failure ? '<section class="panel"><h1>Connection unavailable</h1><p>' + esc(state.failure) + '</p>' + button('Retry', 'retry', 'primary') + '</section>'
    : state.error ? '<section class="panel"><h1>' + (names[route] || 'tunecloud') + '</h1><p>' + esc(state.error) + '</p>' + button('Retry', 'refresh') + '</section>'
    : Object.hasOwn(pages, route) ? pages[route]() : home();
  layout.innerHTML = `<div class="shell">
    <aside class="sidebar">
      <a class="logo" href="#home"><span>${icon('logo')}</span>tunecloud</a>
      <nav aria-label="Main navigation">
        ${nav('Home', 'home', 'home')}
        <div class="nav-label">Discover</div>
        ${nav('Stream', 'community', 'people')}${nav('Moments', 'photos', 'photo')}${nav('Tracks', 'music', 'music')}
        <div class="nav-label">Account</div>
        ${nav('Go Pro', 'billing', 'credit')}${nav('Settings', 'account', 'settings')}
      </nav>
      <div class="sidebar-bottom">${state.account
        ? '<a href="#' + userRoute(state.account.username) + '" class="profile-link">' + avatar(state.account.name) + '<span><strong>' + esc(state.account.name) + '</strong><small>@' + esc(state.account.username) + '</small></span></a>'
        : '<p>Join tunecloud to start posting, saving photos, and connecting with members.</p>' + button('Create account', 'signup', 'primary wide')}</div>
    </aside>
    <div class="main-shell">
      <header class="topbar">
        <span class="breadcrumb">${names[route] || 'Home'}</span>
        <form class="search-form" data-form="search">${icon('search')}<input type="search" name="query" aria-label="Search members by username" placeholder="Search members" value="${esc(state.search)}" required></form>
        <div class="top-actions">${state.account
          ? '<a class="profile-mini" href="#' + userRoute(state.account.username) + '" aria-label="My profile">' + avatar(state.account.name) + '</a>'
          : button('Log in', 'login', 'plain') + button('Join tunecloud', 'signup', 'primary compact')}</div>
      </header>
      <main id="content" tabindex="-1">${body}</main>
    </div></div>`;
  if (focusedAction) [...layout.querySelectorAll('[data-action]')].find(element => element.dataset.action === focusedAction)?.focus({ preventScroll: true });
}

function featured() {
  return `<section class="hero">
    <div class="hero-copy"><span class="hero-label">${icon('wave')} Featured on Tracks</span>
      <h1>Afterglow</h1>
      <p>Warm synths and a slow pulse from Circuit Atlas.</p>
      <div class="actions">${button('Play track', 'play/afterglow', 'lime', 'play')}${link('Browse tracks', 'music', 'hero-link')}</div>
    </div><span class="hero-album">AN OPEN WINDOW <span>·</span> CIRCUIT ATLAS</span>
  </section>`;
}

function titleRow(title, action = '') {
  return '<div class="section-title"><h2>' + title + '</h2>' + action + '</div>';
}

function home() {
  return `<div class="dashboard">
    <div class="stack gap">
      ${featured()}
      <section>${titleRow('From the stream', link('Open Stream', 'community', 'text'))}
        ${state.data?.feed?.items.length ? state.data.feed.items.slice(0, 2).map(post).join('') :
          `<article class="panel empty"><div class="feature-icon lilac">${icon('people')}</div><div><h3>Start a conversation</h3><p>Share something with the tunecloud community.</p></div>${link('Open feed', 'community', 'secondary')}</article>`}
      </section>
      <section>${titleRow('Moments', link('Open Moments', 'photos', 'text'))}<div class="photo-grid small-grid">${collection.map(photo => photoCard(photo, true)).join('')}</div></section>
    </div>
    <aside class="stack gap right-rail">
      <section class="panel tight">
        ${titleRow('Now Playing', link('All tracks', 'music', 'text'))}
        ${tracks.map(track => trackRow(track, true)).join('')}
      </section>
      <section class="panel explorer">
        <h2>Explore tunecloud</h2>
        <a href="#community"><span class="feature-icon lilac">${icon('people')}</span><span><strong>Stream</strong><small>Posts and profiles</small></span></a>
        <a href="#photos"><span class="feature-icon sage">${icon('photo')}</span><span><strong>Moments</strong><small>Moments and collections</small></span></a>
        <a href="#music"><span class="feature-icon peach">${icon('music')}</span><span><strong>Tracks</strong><small>Tracks and previews</small></span></a>
      </section>
    </aside></div>`;
}

function post(item) {
  return `<article class="panel post">
    <header><a class="identity" href="#${userRoute(item.author.username)}">${avatar(item.author.name)}<span><strong>${esc(item.author.name)}</strong><small>@${esc(item.author.username)} · ${dateLabel(item.date)}</small></span></a>
    ${item.own ? button(icon('more'), 'remove/' + item.id, 'icon quiet', '', 'aria-label="Manage post"') : ''}</header>
    <p>${esc(item.text)}</p></article>`;
}

function composer() {
  return state.account ? `<form class="panel post composer" data-form="post">
    <label class="field"><span>New post</span><textarea name="text" rows="3" maxlength="500" placeholder="Share an update…" required></textarea></label>
    <div class="form-end"><span class="muted">${state.account.visibility === 'private' ? 'Followers only' : 'Public'}</span><button class="button primary">Post update</button></div></form>`
    : `<article class="panel empty"><div><h3>Join the stream</h3><p>Sign in to post and connect with members.</p></div>${button('Create account', 'signup', 'primary')}</article>`;
}

function community() {
  const items = state.data?.feed?.items ?? [];
  return heading('Stream', 'Updates from across the tunecloud community.')
    + '<div class="feed-column stack">' + composer() + (items.length ? items.map(post).join('') : '<p class="empty-note">No posts yet. New public updates will appear here.</p>')
    + (state.data?.feed?.next ? button('Load more posts', 'more', 'secondary') : '') + '</div>';
}

function photoCard(item, editorial = false) {
  const id = editorial ? 'field-' + item.id : item.id;
  const src = editorial ? '/media/' + item.id + '.jpg' : '/api/photo/' + id;
  const saved = state.account?.favorites.includes(id);
  const caption = editorial ? item.title : item.text;
  return `<article class="photo-card">
    <button type="button" class="photo-open" data-action="photo/${id}" aria-label="Open ${esc(caption || 'photo')}"><img src="${src}" loading="lazy" alt="${esc(editorial ? item.alt : caption || 'Member photo')}"></button>
    <div class="photo-meta"><div><strong>${esc(caption || 'Untitled')}</strong><small>${editorial ? 'Moments' : '<a href="#' + userRoute(item.author.username) + '">@' + esc(item.author.username) + '</a>'}</small></div>
    <div class="photo-actions">${button(icon('heart'), 'favorite/' + id, 'icon quiet' + (saved ? ' saved' : ''), '', 'aria-label="' + (saved ? 'Remove favorite' : 'Save photo') + '" aria-pressed="' + Boolean(saved) + '"')}${item.own ? button(icon('more'), 'remove/' + id, 'icon quiet', '', 'aria-label="Manage photo"') : ''}</div></div></article>`;
}

function photos() {
  const saved = state.photoMode === 'saved';
  const items = state.data?.feed?.items ?? [];
  const field = saved ? collection.filter(photo => state.account?.favorites.includes('field-' + photo.id)) : collection;
  return heading('Moments', 'Photos and moments from the community.', button('Share a moment', 'upload', 'primary', 'plus'))
    + `<div class="tabs">${button('Discover', 'photos/all', saved ? 'plain' : 'selected')}${button('Saved photos', 'photos/saved', saved ? 'selected' : 'plain')}</div>
    ${field.length ? '<section class="stack"><h2>' + (saved ? 'Saved from Moments' : 'Moments') + '</h2><div class="photo-grid">' + field.map(photo => photoCard(photo, true)).join('') + '</div></section>' : ''}
    <section class="section stack"><h2>${saved ? 'Saved from the community' : 'Community photos'}</h2>
    ${items.length ? '<div class="photo-grid">' + items.map(item => photoCard(item)).join('') + '</div>' : '<p class="empty-note">' + (saved ? 'Save a photo to find it here.' : 'Be the first to share a photo.') + '</p>'}
    ${state.data?.feed?.next ? button('Load more photos', 'more', 'secondary') : ''}</section>`;
}

function trackRow(track, compact = false) {
  const access = canPlay(state.account, track);
  const label = access ? 'Play ' + track.title : 'Play ' + track.title + ' preview';
  return `<div class="track${compact ? ' compact-track' : ''}">
    <img src="/media/${track.artwork}.jpg" alt="" loading="lazy"><div><strong>${track.title}</strong><small>${track.artist}${compact ? '' : ' · ' + track.album}</small></div>
    ${compact ? '' : '<span class="track-length">' + (access ? clock(track.length) : '0:12 preview') + '</span>'}
    ${!access && !compact ? button('Unlock · ' + track.credits + ' credits', 'unlock/' + track.id, 'secondary credit-button') : ''}
    ${button(icon('play'), 'play/' + track.id, 'icon track-play', '', 'aria-label="' + label + '"')}
  </div>`;
}

function music() {
  return heading('Tracks', 'Original tracks from the tunecloud catalog.')
    + featured() + '<section class="panel section"><h2>All tracks</h2>' + tracks.map(track => trackRow(track)).join('') + '</section>'
    + (state.account && eligible(state.account.plan, 'plus') && state.account.flags.listeningHistory ? '<section class="section panel"><h2>Listening history</h2>' +
      (state.account.history.length ? state.account.history.map(entry => {
        const track = tracks.find(item => item.id === entry.id);
        return track ? '<div class="list-row"><strong>' + track.title + '</strong><small>' + dateLabel(entry.at) + '</small></div>' : '';
      }).join('') : '<p class="muted">Tracks you play appear here.</p>') + '</section>' : '');
}

function billing() {
  return heading('Go Pro', 'Choose a plan or buy credits to unlock full tracks.')
    + (!state.payments ? '<p class="info">Checkout is currently unavailable. Free accounts can browse and share content.</p>' : '')
    + `<div class="plan-grid">${plans.map(plan => {
      const active = (state.account?.plan || 'free') === plan.id;
      return `<article class="plan panel ${plan.id === 'plus' ? 'featured-plan' : ''}">
        <div class="plan-title"><h2>${plan.label}</h2>${active ? '<span class="pill">Current plan</span>' : ''}</div>
        <div class="amount">${price(plan.cents)}<small> / month</small></div><ul>${plan.features.map(item => '<li>' + icon('check') + item + '</li>').join('')}</ul>
        ${plan.cents && !active ? (state.account && state.account.plan !== 'free'
          ? button('Manage subscription', 'portal', 'secondary', '', state.payments ? '' : 'disabled')
          : button('Choose ' + plan.label, 'checkout/' + plan.id, 'primary', '', state.payments ? '' : 'disabled')) : ''}
      </article>`;
    }).join('')}</div>
    ${state.account?.billingProfile ? '<div class="actions">' + button('Manage billing', 'portal', 'secondary', '', state.payments ? '' : 'disabled') + '</div>' : ''}
    <section class="section stack">
      ${titleRow('Credits', state.account ? '<div class="actions inline"><span class="pill">' + state.account.credits + ' credits available</span>' + button('Refresh balance', 'sync-account', 'text') + '</div>' : '')}
      <div class="plan-grid">${creditPacks.map(pack => `<article class="plan panel"><h3>${pack.credits} credits</h3><p>${price(pack.cents)} USD</p>${button('Buy credits', 'checkout/' + pack.id, 'secondary', '', state.payments ? '' : 'disabled')}</article>`).join('')}</div>
    </section>
    ${state.account ? '<section class="section panel"><h2>Purchase history</h2>' + (state.data?.receipts?.length ? state.data.receipts.map(receipt => '<div class="list-row"><strong>+' + receipt.credits + ' credits</strong><span>' + dateLabel(receipt.createdAt) + '</span></div>').join('') : '<p class="muted">Your purchases appear here.</p>') + '</section>' : ''}`;
}

function account() {
  const me = state.account;
  if (!me) return heading('Your profile', 'Set up your profile and choose who can see your content.') + '<div class="panel actions">' + button('Create account', 'signup', 'primary') + button('Sign in', 'login', 'secondary') + '</div>';
  const connections = state.data?.connections ?? [];
  return heading('Settings', 'Manage your profile, connections, and preferences.', button('Sign out', 'logout', 'secondary'))
    + `<div class="settings-grid"><section class="panel"><h2>Profile</h2>
      <form class="stack" data-form="settings">
        <label class="field">Display name<input name="name" value="${esc(me.name)}" minlength="2" maxlength="45" required></label>
        <label class="field">Bio<textarea name="bio" rows="2" maxlength="160">${esc(me.bio)}</textarea></label>
        <label class="field">Profile visibility<select name="visibility"><option value="public"${me.visibility === 'public' ? ' selected' : ''}>Public</option><option value="private"${me.visibility === 'private' ? ' selected' : ''}>Followers only</option></select></label>
        <p class="muted">Your username and display name appear in search. The visibility setting applies to your bio, posts, and photos.</p>
        <button class="button primary">Save profile</button>
      </form></section>
      <div class="stack"><section class="panel"><h2>Connections</h2>
        ${connections.length ? connections.map(item => `<div class="list-row"><a href="#${userRoute(item.username)}">${esc(item.name)}<small>@${esc(item.username)}</small></a><div class="actions">
          ${item.status === 'pending' ? button('Approve', 'approve/' + esc(item.username), 'primary compact') : '<span class="pill">Approved</span>'}
          ${button(item.status === 'pending' ? 'Decline' : 'Remove', 'drop/' + esc(item.username), 'secondary compact')}</div></div>`).join('') : '<p class="muted">Connection requests appear here.</p>'}
      </section><section class="panel"><h2>Features</h2>
        ${features.map(feature => {
          const access = eligible(me.plan, feature.plan);
          const enabled = access && me.flags[feature.id];
          return `<div class="list-row"><div><strong>${feature.name}</strong><small>${feature.description}</small></div>
            ${access ? button(enabled ? 'On' : 'Off', 'flag/' + feature.id, 'secondary', '', 'aria-label="' + feature.name + '" aria-pressed="' + enabled + '"') : '<span class="pill">' + plans.find(plan => plan.id === feature.plan).label + '</span>'}</div>`;
        }).join('')}
      </section></div></div>`;
}

function member() {
  const profile = state.data?.member;
  if (!profile) return heading('Profile', 'Loading profile…');
  const action = profile.own ? link('Edit profile', 'account', 'secondary')
    : profile.connection ? button(profile.connection === 'approved' ? 'Disconnect' : 'Cancel request', 'withdraw/' + esc(profile.username), 'secondary')
      : button('Request connection', 'connect/' + esc(profile.username), 'primary', 'plus');
  const entries = state.data.feed?.items ?? [];
  const pictures = state.data.photos?.items ?? [];
  return `<section class="panel member-header">${avatar(profile.name, 'large')}
    <div><h1>${esc(profile.name)}</h1><p>@${esc(profile.username)} ${profile.visibility === 'private' ? ' · Private profile' : ''}</p>
    ${profile.bio ? '<p>' + esc(profile.bio) + '</p>' : ''}</div>${action}</section>
    ${profile.visible ? '<section class="section stack"><h2>Posts</h2>' + (entries.length ? entries.map(post).join('') : '<p class="muted">No posts yet.</p>') +
      (state.data.feed.next ? button('Load more posts', 'profile-posts', 'secondary') : '') + '</section><section class="section stack"><h2>Photos</h2>' +
      (pictures.length ? '<div class="photo-grid">' + pictures.map(item => photoCard(item)).join('') + '</div>' : '<p class="muted">No photos yet.</p>') +
      (state.data.photos.next ? button('Load more photos', 'profile-photos', 'secondary') : '') + '</section>'
      : '<section class="panel section empty">' + icon('lock') + '<div><h2>Private profile</h2><p>Follow to see their posts and moments</p></div></section>'}`;
}

function search() {
  const results = state.data?.members;
  return heading('Find people', state.search ? 'Usernames starting with “' + esc(state.search) + '”' : 'Enter a username in the search bar.')
    + (results?.length ? '<div class="panel">' + results.map(person => '<a class="list-row identity" href="#' + userRoute(person.username) + '">' + avatar(person.name) + '<span><strong>' + esc(person.name) + '</strong><small>@' + esc(person.username) + '</small></span></a>').join('') + '</div>'
    : '<p class="empty-note">' + (results ? 'No people found.' : 'Search results appear here.') + '</p>');
}

async function refresh() {
  const version = ++epoch;
  state.error = '';
  const route = page();
  let data = {};
  try {
    if (['home', 'community'].includes(route)) data.feed = await api('feed?kind=post');
    if (route === 'photos') data.feed = await api('feed?kind=photo' + (state.photoMode === 'saved' ? '&saved=1' : ''));
    if (route === 'billing' && state.account) data = await api('receipts');
    if (route === 'account' && state.account) data = await api('connections');
    if (route === 'search' && state.search) data = await api('members?q=' + encodeURIComponent(state.search));
    if (route === 'member') {
      const username = encodeURIComponent(currentRoute().split('/')[1] ?? '');
      ({ member: data.member } = await api('member/' + username));
      if (data.member.visible) [data.feed, data.photos] = await Promise.all([api('feed?kind=post&member=' + username), api('feed?kind=photo&member=' + username)]);
    }
  } catch (error) {
    if (version === epoch) state.error = error.message;
  }
  if (version !== epoch) return;
  state.data = data;
  render();
}

function modal(title, body) {
  dialog.innerHTML = '<div class="dialog-title"><h2 id="dialog-title">' + title + '</h2>' + button(icon('close'), 'close', 'icon quiet', '', 'aria-label="Close dialog"') + '</div>' + body;
  if (!dialog.open) dialog.showModal();
}

function auth(mode = 'login') {
  const create = mode === 'signup';
  modal(create ? 'Create your account' : 'Welcome back', `<form class="stack" data-form="${mode}">
    ${create ? '<label class="field">Display name<input name="name" required minlength="2" maxlength="45" autocomplete="name"></label>' : ''}
    <label class="field">Username<input name="username" required minlength="3" maxlength="24" pattern="[a-zA-Z0-9][a-zA-Z0-9_\\-]{2,23}" autocomplete="username" autocapitalize="off"></label>
    <label class="field">Password<input name="password" type="password" maxlength="128" ${create ? 'minlength="12" autocomplete="new-password" placeholder="At least 12 characters"' : 'autocomplete="current-password"'} required></label>
    <p class="error" data-error role="alert" hidden></p><button class="button primary wide">${create ? 'Create account' : 'Log in'}</button>
    </form><div class="form-end">${create ? button('Already have an account? Log in', 'login', 'text') : button('New to tunecloud? Create an account', 'signup', 'text')}</div>`);
}

function openPhoto(id) {
  const editorial = collection.find(item => 'field-' + item.id === id);
  const photo = editorial ?? [...(state.data?.feed?.items ?? []), ...(state.data?.photos?.items ?? [])].find(item => item.id === id);
  if (!photo) return;
  modal(esc(editorial ? photo.title : photo.text || 'Photo'), '<img class="full-photo" src="' + (editorial ? '/media/' + photo.id + '.jpg' : '/api/photo/' + id) + '" alt="' + esc(editorial ? photo.alt : photo.text || 'Member photo') + '">');
}

function uploadDialog() {
  modal('Share a photo', `<form class="stack" data-form="upload">
    <label class="field">Photo<input name="photo" type="file" accept="image/jpeg,image/png,image/webp" required></label>
    <p class="muted">JPEG, PNG, or WebP, up to 5 MB.</p>
    <img id="upload-preview" alt="Selected photo" hidden>
    <label class="field">Caption<textarea name="caption" maxlength="280" rows="2"></textarea></label>
    <p class="muted">${state.account.visibility === 'private' ? 'Visible to followers only.' : 'This moment will appear on your public profile.'}</p>
    <p class="error" data-error role="alert" hidden></p>
    <button class="button primary">Post moment</button></form>`);
}

function drawPlayer() {
  if (!state.current) { player.hidden = true; document.body.classList.remove('has-player'); return; }
  const { track, full } = state.current;
  player.hidden = false;
  document.body.classList.add('has-player');
  player.innerHTML = `<div class="now-playing"><img src="/media/${track.artwork}.jpg" alt=""><div><strong>${track.title}</strong><small>${track.artist}${full ? '' : ' · Preview'}</small></div></div>
  <div class="player-middle"><div class="player-buttons">
    ${button(icon('previous'), 'previous', 'icon quiet', '', 'aria-label="Previous track"')}
    ${button(icon(audio.paused ? 'play' : 'pause'), 'toggle-audio', 'icon primary', '', 'aria-label="' + (audio.paused ? 'Play' : 'Pause') + '"')}
    ${button(icon('next'), 'next', 'icon quiet', '', 'aria-label="Next track"')}
  </div><div class="seek"><span id="elapsed">0:00</span><input id="seek" type="range" min="0" max="0" step="0.1" value="0" aria-label="Playback position"><span id="duration">0:00</span></div></div>
  <div class="player-right">${button(icon(audio.muted ? 'mute' : 'volume'), 'mute', 'icon quiet', '', 'aria-label="' + (audio.muted ? 'Unmute' : 'Mute') + '"')}
  ${button(icon('close'), 'stop', 'icon quiet', '', 'aria-label="Close player"')}</div>`;
  progressAudio();
}

function progressAudio() {
  if (!state.current) return;
  const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
  const seek = document.querySelector('#seek');
  seek.max = duration;
  seek.value = audio.currentTime;
  document.querySelector('#elapsed').textContent = clock(audio.currentTime);
  document.querySelector('#duration').textContent = clock(duration);
}

async function play(id) {
  const track = tracks.find(item => item.id === id);
  if (!track) return;
  const full = canPlay(state.account, track);
  state.current = { track, full };
  audio.src = '/api/audio/' + track.id + (full ? '?version=full' : '');
  drawPlayer();
  try {
    await audio.play();
    if (state.account && eligible(state.account.plan, 'plus') && state.account.flags.listeningHistory) {
      await api('listened', { id }).then(data => { if (data.account.username === state.account?.username) state.account = data.account; }).catch(() => {});
    }
  } catch { flash('This track could not be played. Check your membership and try again.'); }
}

async function loadMore(field = 'feed') {
  const previous = state.data?.[field];
  if (!previous?.next) return;
  const start = epoch;
  const kind = field === 'photos' || page() === 'photos' ? 'photo' : 'post';
  const params = new URLSearchParams({ kind, before: previous.next });
  if (page() === 'photos' && state.photoMode === 'saved') params.set('saved', '1');
  if (page() === 'member') params.set('member', state.data.member.username);
  const next = await api('feed?' + params);
  if (start === epoch) {
    state.data[field] = { items: [...previous.items, ...next.items], next: next.next };
    render();
  }
}

async function action(name) {
  const [key, id] = name.split('/');
  if (key === 'close') return dialog.close();
  if (key === 'refresh') return refresh();
  if (key === 'retry') return init();
  if (key === 'sync-account') { ({ account: state.account } = await api('session')); return refresh(); }
  if (key === 'login' || key === 'signup') return auth(key);
  if (key === 'photo') return openPhoto(id);
  if (key === 'play') return play(id);
  if (key === 'toggle-audio') return audio.paused ? audio.play() : audio.pause();
  if (key === 'mute') { audio.muted = !audio.muted; return drawPlayer(); }
  if (key === 'stop') { audio.pause(); audio.removeAttribute('src'); audio.load(); state.current = null; return drawPlayer(); }
  if (key === 'next' || key === 'previous') {
    const index = tracks.findIndex(track => track.id === state.current.track.id);
    return play(tracks[(index + (key === 'next' ? 1 : -1) + tracks.length) % tracks.length].id);
  }
  if (key === 'more' || key === 'profile-posts' || key === 'profile-photos') return loadMore(key === 'profile-photos' ? 'photos' : 'feed');
  if (key === 'photos') { state.photoMode = id; state.data = null; return refresh(); }
  if (!state.account) return auth();
  if (key === 'upload') return uploadDialog();
  if (key === 'logout') {
    await api('logout', {});
    state.account = null;
    if (state.current?.track.credits > 0 && state.current.full) await action('stop');
    flash('Signed out.');
    return refresh();
  }
  if (key === 'flag') ({ account: state.account } = await api('flags', { id, enabled: !state.account.flags[id] }));
  if (key === 'favorite') {
    const saved = !state.account.favorites.includes(id);
    ({ account: state.account } = await api('favorites', { id, saved }));
    flash(saved ? 'Moment saved.' : 'Moment removed from saved.');
    if (page() !== 'photos' || state.photoMode !== 'saved') return render();
  }
  if (['connect', 'withdraw', 'approve', 'drop'].includes(key)) {
    await api('connect', { username: id, action: ({ connect: 'request', drop: 'remove' })[key] ?? key });
    flash(({ connect: 'Follow request sent.', withdraw: 'Follow canceled.', approve: 'Follow approved.', drop: 'Follow removed.' })[key]);
  }
  if (key === 'remove') {
    return modal('Remove this?', '<p>It will be removed from your profile and the feed.</p><div class="actions">' + button('Remove', 'confirm-remove/' + id, 'danger') + button('Cancel', 'close', 'secondary') + '</div>');
  }
  if (key === 'confirm-remove') {
    await api('remove', { id });
    dialog.close();
    flash('Removed.');
  }
  if (key === 'unlock') {
    const track = tracks.find(item => item.id === id);
    return modal('Unlock ' + track.title, '<p>This will use ' + track.credits + ' credits. The full track will be added to your library.</p><div class="actions">'
      + (state.account.credits >= track.credits ? button('Unlock track', 'confirm-unlock/' + id, 'primary') : '<a class="button primary" href="#billing" data-action="close-link">Get credits</a>') + '</div>');
  }
  if (key === 'confirm-unlock') {
    ({ account: state.account } = await api('unlock', { id }));
    dialog.close();
    flash('Track unlocked.');
  }
  if (key === 'checkout' || key === 'portal') {
    if (key === 'checkout' && checkoutAttempt?.id !== id) checkoutAttempt = { id, requestId: crypto.randomUUID() };
    const { url } = await api(key, key === 'checkout' ? checkoutAttempt : {});
    if (typeof url !== 'string' || !['checkout.stripe.com', 'billing.stripe.com'].includes(new URL(url).hostname) || !url.startsWith('https://')) throw new Error('Checkout is currently unavailable.');
    location.assign(url);
    return;
  }
  return refresh();
}

async function submit(form) {
  const data = new FormData(form);
  const kind = form.dataset.form;
  if (kind === 'search') {
    state.search = data.get('query').trim();
    if (page() === 'search') return refresh();
    location.hash = 'search';
    return;
  }
  if (kind === 'login' || kind === 'signup') {
    ({ account: state.account } = await api(kind, Object.fromEntries(data)));
    dialog.close();
    flash(kind === 'signup' ? 'Welcome to tunecloud.' : 'Signed in.');
  }
  if (kind === 'post') { await api('posts', Object.fromEntries(data)); flash('Update posted.'); }
  if (kind === 'settings') { ({ account: state.account } = await api('settings', Object.fromEntries(data))); flash('Profile saved.'); }
  if (kind === 'upload') { await api('photos', data); dialog.close(); state.photoMode = 'all'; flash('Photo published.'); }
  return refresh();
}

document.addEventListener('click', async event => {
  if (event.target.closest('.skip')) { event.preventDefault(); document.querySelector('#content').focus(); return; }
  const target = event.target.closest('[data-action]');
  if (!target) return;
  if (target.dataset.action === 'close-link') return dialog.close();
  if (busy) return;
  busy = true;
  try { await action(target.dataset.action); } catch (error) { flash(error.message); }
  finally { busy = false; }
});

document.addEventListener('submit', async event => {
  const form = event.target.closest('[data-form]');
  if (!form) return;
  event.preventDefault();
  if (busy) return;
  busy = true;
  const submitButton = form.querySelector('button[type="submit"], button:not([type])');
  if (submitButton) submitButton.disabled = true;
  try { await submit(form); } catch (error) {
    const message = form.querySelector('[data-error]');
    if (message) { message.textContent = error.message; message.hidden = false; } else flash(error.message);
  } finally { busy = false; if (submitButton) submitButton.disabled = false; }
});

dialog.addEventListener('change', event => {
  if (event.target.name !== 'photo') return;
  const preview = dialog.querySelector('#upload-preview');
  if (photoObjectUrl) URL.revokeObjectURL(photoObjectUrl);
  const file = event.target.files[0];
  photoObjectUrl = file && file.size <= 5 * 1024 * 1024 ? URL.createObjectURL(file) : null;
  preview.hidden = !photoObjectUrl;
  if (photoObjectUrl) preview.src = photoObjectUrl;
});

dialog.addEventListener('close', () => {
  if (photoObjectUrl) URL.revokeObjectURL(photoObjectUrl);
  photoObjectUrl = null;
});
player.addEventListener('input', event => {
  if (event.target.id === 'seek' && Number.isFinite(audio.duration)) audio.currentTime = Number(event.target.value);
});
audio.addEventListener('timeupdate', progressAudio);
audio.addEventListener('loadedmetadata', progressAudio);
audio.addEventListener('play', drawPlayer);
audio.addEventListener('pause', drawPlayer);
audio.addEventListener('ended', drawPlayer);

window.addEventListener('hashchange', () => {
  if (currentRoute() === 'content') { document.querySelector('#content')?.focus(); return; }
  state.data = null;
  state.error = '';
  render();
  refresh();
  window.scrollTo(0, 0);
  document.querySelector('#content')?.focus({ preventScroll: true });
});

async function init() {
  state.failure = '';
  state.connecting = true;
  render();
  try {
    const session = await api('session');
    state.account = session.account;
    state.payments = session.payments;
    if (new URLSearchParams(location.search).get('payment') === 'return') {
      history.replaceState(null, '', '/#billing');
      flash('Welcome back. Your purchase will appear after payment confirmation.');
    }
  } catch { state.failure = 'tunecloud could not connect to its server.'; }
  state.connecting = false;
  if (state.failure) render();
  else await refresh();
}

init();
