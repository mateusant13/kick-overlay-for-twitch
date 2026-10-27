// The owner's YouTube must not un-pause itself just because the overlay probed
// the page.
//
// Owner report 2026-10-26: "something unpauses my YouTube by itself". Cause:
// resumeNativePagePlayer() called play() on any paused <video>, and probe() runs
// on a 20 s poll (POLL_MS) plus on every `playing` event, so a YouTube watch
// page with KO.player === 'twitch' resumed a video the user had paused.
//
// This harness runs the REAL content.js against a stubbed YouTube page and asks
// the real invoker (probe()) to do it. It is deliberately not an "overlay
// mounted" assertion: the video must still be paused, and play() must not have
// been called.
//
//   node youtube-resume-test.cjs             runs both arms
//   node youtube-resume-test.cjs --arm=pre   pre-fix source, must go RED
//   node youtube-resume-test.cjs --arm=post  real source, must go GREEN
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// ---- stubs (same shape as route-gate-test.cjs) ------------------------------
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

const playCalls = { n: 0 };

// The page's own player: PAUSED, because the user paused it.
const pageVideo = {
  ...el('video'),
  paused: true,
  readyState: 4,
  currentTime: 42,
  muted: false,
  getClientRects: () => [{}],
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 1152, height: 648 }),
  pause() { this.paused = true; },
  play() { playCalls.n++; this.paused = false; return Promise.resolve(); },
};

const pageVideos = [pageVideo];
const mainEl = { ...el('main'), contains: (v) => v === pageVideo };
const pageSel = new Map([
  ['main.twilight-main, main', mainEl],
]);
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
  pathname: '/watch',
  search: '?v=abcdefghijk',
  hash: '',
  hostname: 'www.youtube.com',
  href: 'https://www.youtube.com/watch?v=abcdefghijk',
};
global.addEventListener = () => {};
global.removeEventListener = () => {};
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
      // player=twitch on a YouTube page is exactly the branch that resumed the
      // user's video.
      get: (k, cb) => setTimeout(() => cb && cb({
        'ko.v2': { enabled: true, player: 'twitch', mappings: { rodil: { kick: 'rodil', yt: '@rodil' } } },
      }), 0),
      set: (o, cb) => cb && cb(),
    },
    onChanged: { addListener() {} },
  },
  action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
  tabs: { query: () => Promise.resolve([]) },
};

const ARM = (process.argv.find((a) => a.startsWith('--arm=')) || '--arm=all').split('=')[1];
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

async function runArm(arm) {
  playCalls.n = 0;
  pageVideo.paused = true; // the user's paused state, restored per arm

  const src = fs.readFileSync(path.join(__dirname, 'content.js'), 'utf8');
  let useSrc = src;
  if (arm === 'pre') {
    // The pre-fix body: no ownership guard, only `v.paused`.
    const guard = /  const ours = opts && opts\.ours !== undefined \? !!opts\.ours : KO\.twWasPlaying;\r?\n  if \(!ours\) return;\r?\n/;
    if (!guard.test(useSrc)) throw new Error('pre-fix arm cannot find the ownership guard to remove');
    useSrc = useSrc.replace(guard, '');
  }

  const api = new Function(
    'window', 'document', 'location', 'navigator',
    useSrc + '\n;return {KO, probe, apply, currentSlug, twitchVideo, resumeNativePagePlayer};',
  )(global, doc, global.location, { userAgent: 'node' });

  await settle(400); // init() + boot apply()/probe() settle
  const { KO } = api;

  // Route the overlay onto this page the way probe() sees it after a binding:
  // same identity, same mappings object (so the re-resolve block is skipped and
  // the `player=twitch` branch is reached, which is what the poll hits too).
  KO.enabled = true;
  KO.player = 'twitch';
  KO.mappings = { rodil: { kick: 'rodil', yt: '@rodil' } };
  KO.ytPageId = api.currentSlug();
  KO.ytBoundMappings = KO.mappings;

  const before = { paused: pageVideo.paused, plays: playCalls.n };
  await api.probe();   // the real invoker: one poll tick
  await settle(50);
  const afterProbe = { paused: pageVideo.paused, plays: playCalls.n };

  // Ownership arm, same real invoker: a video WE paused must still come back.
  pageVideo.paused = true;
  KO.twWasPlaying = true;
  const oursBefore = playCalls.n;
  await api.probe();
  await settle(50);
  const oursAfter = { paused: pageVideo.paused, plays: playCalls.n - oursBefore };

  return { arm, before, afterProbe, oursArm: oursAfter, player: KO.player };
}

(async () => {
  if (ARM !== 'all') {
    const r = await runArm(ARM);
    console.log('ARM ' + JSON.stringify(r));
    if (ARM === 'pre') {
      // RED is the expected outcome: the old code started the user's video.
      const red = r.afterProbe.plays >= 1 && r.afterProbe.paused === false;
      console.log(red ? 'RED as expected — user-paused video was resumed' : 'FAIL: pre-fix arm did not reproduce');
      process.exit(red ? 0 : 1);
    }
    const green = r.afterProbe.plays === 0 && r.afterProbe.paused === true;
    const handsBack = r.oursArm.plays >= 1 && r.oursArm.paused === false;
    console.log(green && handsBack
      ? 'GREEN — user-paused video stayed paused; a video we paused was handed back'
      : `FAIL: user-paused plays=${r.afterProbe.plays} paused=${r.afterProbe.paused}; ours plays=${r.oursArm.plays} paused=${r.oursArm.paused}`);
    process.exit(green && handsBack ? 0 : 1);
  }

  const run = (arm) => spawnSync(process.execPath, [__filename, '--arm=' + arm], { encoding: 'utf8' });
  const pre = run('pre');
  const post = run('post');
  process.stdout.write(pre.stdout + pre.stderr);
  process.stdout.write(post.stdout + post.stderr);
  const ok = pre.status === 0 && post.status === 0;
  console.log(ok ? 'RESULT PASS youtube-resume (RED before, GREEN after)' : 'RESULT FAIL youtube-resume');
  process.exit(ok ? 0 : 1);
})();
