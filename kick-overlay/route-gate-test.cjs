// Route-gate regression harness for content.js.
//
// Owner report (2026-10-26): going to a Twitch channel sub-route
// (twitch.tv/<channel>/clips) "breaks the layout — the player stays fixed at
// the top of the page". The overlay is a position:fixed layer that mirrors a
// player rect, and both Twitch and YouTube KEEP a ghost <video> in the DOM
// after an SPA navigation, so the layer kept mirroring a player that the new
// route does not show. Measured on the guest harness: after SPA ->
// /rodil/clips the wrap was still display:block at the old rect, over the
// clips grid.
//
// This harness runs the REAL content.js against a stubbed DOM and asserts the
// route contract (which routes own a mirrored player) plus the two behavioural
// consequences: hide immediately on a route change, and never mount on a
// non-player route. `node route-gate-test.cjs` (no frameworks).
'use strict';
const fs = require('fs');
const assert = require('assert');

// ---- stubs ----------------------------------------------------------------
const mkClassList = (owner) => {
  const set = new Set();
  const sync = () => { owner.className = [...set].join(' '); };
  return {
    add(...c) { c.forEach((x) => set.add(x)); sync(); },
    remove(...c) { c.forEach((x) => set.delete(x)); sync(); },
    contains: (c) => set.has(c),
    toggle(c, force) {
      const on = force === undefined ? !set.has(c) : !!force;
      if (on) set.add(c); else set.delete(c);
      sync();
      return on;
    },
  };
};

const el = (tag) => {
  const node = {
    tag,
    tagName: (tag || 'div').toUpperCase(),
    nodeType: 1,
    innerHTML: '',
    style: {},
    dataset: {},
    className: '',
    attrs: {},
    isConnected: true,
    removed: 0,
    children: [],
    listeners: {},
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    removeChild(c) { return c; },
    remove() { this.removed++; this.isConnected = false; },
    addEventListener() {},
    removeEventListener() {},
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 60 }),
    getClientRects: () => [],
    querySelector: () => el('div'),
    querySelectorAll: () => [],
    contains: () => false,
  };
  node.classList = mkClassList(node);
  return node;
};

// A page <video>. Hidden ones report no client rects, like the real DOM.
const videoEl = (rect, { hidden = false } = {}) => ({
  ...el('video'),
  paused: false,
  readyState: 4,
  currentTime: 10,
  muted: false,
  getClientRects: () => (hidden ? [] : [{}]),
  getBoundingClientRect: () => rect,
  pause() { this.paused = true; },
  play() { this.paused = false; return Promise.resolve(); },
});

const pageVideos = [];
const pageSel = new Map();
const doc = {
  head: { appendChild() {} },
  documentElement: el('html'),
  body: el('body'),
  hidden: false,
  hasFocus: () => true,
  fullscreenElement: null,
  createElement: (t) => el(t),
  getElementById: () => null,
  querySelector: (sel) => pageSel.get(sel) || null,
  querySelectorAll: (sel) => (sel === 'video' ? pageVideos : []),
  addEventListener() {},
  removeEventListener() {},
};

global.window = global;
global.document = doc;
global.location = {
  pathname: '/rodil', search: '', hash: '', hostname: 'www.twitch.tv',
  href: 'https://www.twitch.tv/rodil',
};
const navStub = { userAgent: 'node' };
global.addEventListener = (t, l) => { if (t === 'message') msgListeners.push(l); };
global.removeEventListener = () => {};
const msgListeners = [];
global.setTimeout = setTimeout;
global.clearTimeout = clearTimeout;
global.innerWidth = 1280;
global.innerHeight = 720;
global.MutationObserver = class { observe() {} disconnect() {} };
global.getComputedStyle = () => ({ height: '', maxHeight: '', position: 'static' });
global.requestAnimationFrame = (f) => setTimeout(f, 0);
global.fetch = () => Promise.reject(new Error('stub-fetch'));
global.chrome = {
  runtime: {
    sendMessage: (m, cb) => cb && cb({ ok: true }),
    lastError: null,
    onMessage: { addListener() {} },
    getURL: (p) => 'chrome-extension://test/' + p,
  },
  storage: {
    local: {
      get: (k, cb) => setTimeout(() => cb && cb({ 'ko.v2': { enabled: true, player: 'kick' } }), 0),
      set: (o, cb) => cb && cb(),
    },
    onChanged: { addListener() {} },
  },
  action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
  tabs: { query: () => Promise.resolve([]) },
};

const src = fs.readFileSync('content.js', 'utf8');
const api = new Function(
  'window', 'document', 'location', 'navigator',
  src + '\n;return {KO, probe, apply, rectTick, teardown, overlayTargetRoute, twitchVideo, currentSlug};',
)(global, doc, global.location, navStub);
const { KO } = api;

const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const setLoc = (href) => {
  const u = new URL(href);
  location.href = href;
  location.pathname = u.pathname;
  location.search = u.search;
  location.hostname = u.hostname;
};
const check = (label, cond, extra) => {
  if (!cond) {
    console.error(`FAIL ${label}${extra ? ' — ' + JSON.stringify(extra) : ''}`);
    process.exitCode = 1;
    throw new Error(label);
  }
  console.log(`PASS ${label}`);
};

(async () => {
  await settle(350); // init() + boot apply() settle

  // ---- 1: route contract ---------------------------------------------------
  setLoc('https://www.twitch.tv/rodil');
  check('/rodil is a player route', api.overlayTargetRoute() === true);
  setLoc('https://www.twitch.tv/rodil/');
  check('/rodil/ (trailing slash) is a player route', api.overlayTargetRoute() === true);
  for (const p of [
    '/rodil/clips', '/rodil/videos', '/rodil/about', '/rodil/schedule',
    '/rodil/chat', '/clip/FunnyClip', '/directory/games', '/search?term=x',
    '/following', '/popout/rodil/chat', '/',
  ]) {
    setLoc('https://www.twitch.tv' + p);
    check(`${p} is NOT a player route`, api.overlayTargetRoute() === false);
  }
  // Top-level pages that merely look like a channel never resolve a slug.
  for (const p of ['/clip/FunnyClip', '/directory/games', '/search?term=x', '/following', '/']) {
    setLoc('https://www.twitch.tv' + p);
    check(`${p} resolves no channel slug`, api.currentSlug() === null);
  }
  // A channel sub-route still binds the channel (mapping), it just owns no
  // player — the gate is what stops the layer, not the slug.
  setLoc('https://www.twitch.tv/rodil/clips');
  check('/rodil/clips still resolves the channel slug', api.currentSlug() === 'rodil');
  setLoc('https://www.youtube.com/watch?v=abcdefghijk');
  check('/watch?v=<id> is a YouTube player route', api.overlayTargetRoute() === true);
  setLoc('https://www.youtube.com/watch');
  check('/watch without v is not', api.overlayTargetRoute() === false);
  setLoc('https://www.youtube.com/live/abcdefghijk');
  check('/live/<id> is a player route', api.overlayTargetRoute() === true);
  setLoc('https://youtu.be/abcdefghijk');
  check('youtu.be/<id> is a player route', api.overlayTargetRoute() === true);
  for (const p of ['/', '/@somehandle', '/channel/UCxxxxxxxxxxxxxxxxxxxxxx', '/shorts/abcdefghijk', '/feed/subscriptions', '/results?search_query=x']) {
    setLoc('https://www.youtube.com' + p);
    check(`${p} is NOT a YouTube player route`, api.overlayTargetRoute() === false);
  }

  // ---- 2: no mount on a non-player route (fresh load) ----------------------
  // Twitch keeps the ghost player in the DOM on the clips route: the old code
  // followed it and mounted the layer.
  setLoc('https://www.twitch.tv/rodil/clips');
  pageVideos.length = 0;
  pageVideos.push(videoEl({ left: 700, top: 100, width: 1000, height: 560 }));
  KO.wrap = null;
  KO.player = 'kick';
  KO.slug = 'rodil';
  KO.kickSlug = 'rodil';
  KO.activeUrl = 'https://ivs.example/live';
  KO.kickState = { state: 'Playing' };
  KO.kickProbeAt = Date.now();
  await api.probe();
  check('a live kick layer is NOT mounted on /rodil/clips', KO.wrap === null);

  // ---- 3: shown overlay hides immediately on the route change --------------
  setLoc('https://www.twitch.tv/rodil');
  const wrap = el('div');
  wrap.id = 'ko-wrap';
  wrap.classList.add('ko-kick');
  KO.wrap = wrap;
  KO.player = 'kick';
  KO.slug = 'rodil';
  KO.kickSlug = 'rodil';
  KO.activeUrl = 'https://ivs.example/live';
  KO.kickState = { state: 'Playing' };
  KO.kickProbeAt = Date.now();
  KO.twDeleted = false;
  await api.probe();
  check('the layer is shown on the channel root', KO.wrap.style.display === 'block');
  api.rectTick();
  check('rect loop places the layer on the player rect',
    KO.wrap.style.width === '1000px' && KO.wrap.classList.contains('ko-placed'),
    { style: KO.wrap.style, cls: KO.wrap.className });
  // The user clicks the Clips tab; the ghost player is still there.
  setLoc('https://www.twitch.tv/rodil/clips');
  api.rectTick();
  check('route change hides the layer at once', KO.wrap.style.display === 'none');
  await api.probe();
  check('route change tears the layer down', KO.wrap === null);

  // ---- 4: a mount that has never been placed never paints ------------------
  check('CSS keeps an unplaced wrap invisible',
    src.includes('#ko-wrap{position:fixed;z-index:5;pointer-events:none;background:#000;overflow:hidden;visibility:hidden;}') === true);
  check('CSS makes a placed wrap visible',
    src.includes('#ko-wrap.ko-placed{visibility:visible;}') === true);
  // A mounted wrap with no measured rect must not claim a placement.
  setLoc('https://www.twitch.tv/rodil');
  pageVideos.length = 0;
  const unplaced = el('div');
  unplaced.id = 'ko-wrap';
  unplaced.classList.add('ko-kick');
  KO.wrap = unplaced;
  KO.player = 'kick';
  KO.slug = 'rodil';
  KO.activeUrl = 'https://ivs.example/live';
  KO.kickState = { state: 'Playing' };
  KO.hideTicks = 0;
  api.rectTick();
  check('a wrap with no player rect stays unplaced', !KO.wrap.classList.contains('ko-placed'));

  // ---- 5: the channel player wins over a portalled clip viewer -------------
  pageVideos.length = 0;
  const channelPlayer = videoEl({ left: 0, top: 90, width: 900, height: 506 });
  // real DOM shape: <video> inside div.video-ref inside .persistent-player
  channelPlayer.parentElement = { className: 'Layout-sc-1xcs6mc-0 video-ref', parentElement: { className: 'Layout-sc-1xcs6mc-0 persistent-player', parentElement: null } };
  const clipModal = videoEl({ left: 200, top: 100, width: 1200, height: 675 });
  clipModal.parentElement = { className: 'Layout-sc-1xcs6mc-0 clip-viewer', parentElement: null };
  const main = el('main');
  main.contains = (n) => n === channelPlayer;
  pageSel.set('main.twilight-main, main', main);
  pageVideos.push(channelPlayer, clipModal);
  setLoc('https://www.twitch.tv/rodil');
  check('twitchVideo prefers the channel player card inside main', api.twitchVideo() === channelPlayer);
  // No card anywhere: the largest visible video is still the answer.
  channelPlayer.parentElement = null;
  clipModal.parentElement = null;
  check('twitchVideo falls back to the largest visible video', api.twitchVideo() === clipModal);
  pageSel.clear();

  console.log('\nRESULT PASS route gate: contract + hide + no-mount + no-ghost-anchor');
  process.exit(process.exitCode || 0);
})().catch((e) => {
  console.error('\nRESULT FAIL', e.message);
  process.exit(1);
});
