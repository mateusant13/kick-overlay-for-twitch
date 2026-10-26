// Handshake regression harness for player-bridge.js (KO-20261026-02).
//
// Measured 2026-10-26 in the guest Chrome: on a youtube.com watch page with
// player=kick the frame posted `ready` with targetOrigin
// "https://www.twitch.tv" (the old hardcoded default). A post to the wrong
// targetOrigin is dropped silently by the browser, so the content script never
// saw `ready`, never handed over the pending playback_url, the IVS player
// stayed Idle, and the 15s never-played watchdog tore the layer down. The
// primitive was measured too: frame->page with twitch.tv on a youtube.com
// parent = 0 deliveries; page->frame with '*' or with the extension origin =
// delivered.
//
// This harness runs the REAL player-bridge.js in a stubbed frame whose parent
// enforces targetOrigin the way the browser does (a post addressed to another
// origin is dropped, never delivered). It asserts the handshake from the
// frame's side only; nothing here needs the network or a browser.
//
// Negative arm: the same scenario runs against a copy that restores the
// pre-fix targeting (default origin twitch.tv, no '*'). If that copy still
// delivered `ready`, this detector would be measuring nothing.
'use strict';
const fs = require('fs');
const path = require('path');

const SOURCE = fs.readFileSync(path.join(__dirname, 'player-bridge.js'), 'utf8');
const YOUTUBE = 'https://www.youtube.com';
const TOKEN = 'testtoken1234567890';

// Pre-fix code, expressed as two exact mutations of the current file.
const PRE_FIX_MUTATIONS = [
  ['let PARENT_ORIGIN = null; // learned from the first token-valid message', [
    'let PARENT_ORIGIN = null;',
    "let PARENT_ORIGIN = 'https://www.twitch.tv';",
  ]],
  ['const target = PARENT_ORIGIN || \'*\';', [
    'const target = PARENT_ORIGIN || \'*\';',
    'const target = PARENT_ORIGIN;',
  ]],
];

function preFixSource() {
  let out = SOURCE;
  for (const [from, [expected, replacement]] of PRE_FIX_MUTATIONS) {
    if (!out.includes(from)) {
      throw new Error(`the pre-fix mutation no longer applies (looked for: ${expected})`);
    }
    out = out.replace(from, replacement);
  }
  return out;
}

function makePlayer() {
  return {
    version: 'test',
    loadedUrl: null,
    muted: true,
    state: 'Idle',
    getVersion() { return this.version; },
    attachHTMLVideoElement() {},
    setAutoplay() {},
    getQuality() { return { name: '720p', width: 1280, height: 720 }; },
    getQualities() { return [{ name: '720p', width: 1280, height: 720 }]; },
    getDuration() { return Infinity; },
    getPosition() { return 10; },
    getBuffered() { return { end: 12 }; },
    getLiveLatency() { return 2; },
    getState() { return this.state; },
    isPaused() { return false; },
    isMuted() { return this.muted; },
    getVolume() { return this.muted ? 0 : 1; },
    addEventListener() {},
    load(url) { this.loadedUrl = url; this.state = 'Playing'; },
    play() {},
    pause() {},
    setMuted(m) { this.muted = !!m; },
    setVolume() {},
    seekTo() {},
    setAutoQualityMode() {},
    setQuality() {},
  };
}

// A frame document as the browser would give it: posts are delivered only when
// targetOrigin is '*' or matches the parent's real origin.
function makeFrame({ source = SOURCE, parentOrigin = YOUTUBE, token = TOKEN } = {}) {
  const delivered = [];
  const dropped = [];
  const listeners = {};
  const intervals = [];
  const player = makePlayer();

  const parent = {
    postMessage(msg, targetOrigin) {
      if (targetOrigin === '*' || targetOrigin === parentOrigin) delivered.push({ msg, targetOrigin });
      else dropped.push({ msg, targetOrigin });
    },
  };

  const window = {
    parent,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener() {},
    IVSPlayerModule: { create: () => player, PlayerEventType: { ERROR: 'PlayerError' } },
  };
  const document = { getElementById: (id) => (id === 'v' ? { addEventListener() {}, readyState: 0 } : null) };
  const location = { search: `?token=${token}`, href: `chrome-extension://test/player.html?token=${token}` };
  const chrome = {
    runtime: {
      getURL: (p) => `chrome-extension://test/${p}`,
      sendMessage: (_msg, cb) => { if (cb) cb(); },
      lastError: null,
    },
  };
  const performance = { now: () => (performance.t = (performance.t || 0) + 1) };

  const run = new Function(
    'window', 'document', 'chrome', 'location', 'performance', 'parent',
    'setInterval', 'setTimeout', 'URLSearchParams', 'Date',
    source,
  );
  run(
    window, document, chrome, location, performance, parent,
    (fn) => { intervals.push(fn); return intervals.length; },
    () => 1,
    URLSearchParams,
    Date,
  );

  return {
    delivered,
    dropped,
    player,
    diag: window.__koBridgeDiag,
    // a message from the parent page arriving in the frame
    receive(payload, { origin = parentOrigin, fromParent = true, token: tok = token } = {}) {
      const ev = { data: { __koKick: { ...payload, _koToken: tok } }, origin, source: fromParent ? parent : {} };
      for (const fn of listeners.message || []) fn(ev);
    },
    // the frame's 1/s heartbeat
    tick() { for (const fn of intervals) fn(); },
    posts() { return delivered.map((d) => d.msg && d.msg.__koKick); },
    firstPost(type) { return this.posts().find((m) => m && m.t === type) || null; },
  };
}

let checks = 0;
let failed = 0;
function ok(name, cond, detail) {
  checks++;
  if (cond) {
    console.log(`PASS ${name}`);
  } else {
    failed++;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ---- 1. new code: ready reaches a youtube.com parent before any inbound ----
{
  const f = makeFrame();
  const ready = f.firstPost('ready');
  ok('new code: ready is delivered to a youtube.com parent', !!ready, JSON.stringify(f.delivered.map((d) => d.targetOrigin)));
  ok('new code: the first ready was addressed with * (origin not learned yet)', ready && f.diag.firstPost.ready.to === '*', f.diag.firstPost.ready.to);
  ok('new code: ready carries the page token', ready && ready._koToken === TOKEN);
  ok('new code: the frame reported it had not learned the parent', f.diag.parentLearnedAt === 0);
}

// ---- 2. negative arm: the pre-fix code must NOT deliver ready ----
{
  let f = null;
  let threw = null;
  try {
    f = makeFrame({ source: preFixSource() });
  } catch (e) {
    threw = e;
  }
  ok('negative arm: the pre-fix mutation applied', !threw, threw && threw.message);
  if (f) {
    const ready = f.firstPost('ready');
    ok('negative arm: the pre-fix code IS caught dropping ready', !ready, ready ? 'ready was delivered' : '');
    ok(
      'negative arm: it was dropped because it targeted https://www.twitch.tv',
      f.dropped.some((d) => d.msg && d.msg.__koKick && d.msg.__koKick.t === 'ready' && d.targetOrigin === 'https://www.twitch.tv'),
      JSON.stringify(f.dropped.map((d) => d.targetOrigin)),
    );
  }
}

// ---- 3. after one valid command the frame replies on the exact origin ----
{
  const f = makeFrame();
  f.receive({ t: 'load', url: 'https://example.invalid/stream.m3u8' });
  ok('learning: the frame learned the parent origin', f.diag.parentLearnedAt > 0 && f.diag.learnedFrom.origin === YOUTUBE, JSON.stringify(f.diag.learnedFrom));
  ok('learning: the command reached the player', f.player.loadedUrl === 'https://example.invalid/stream.m3u8');
  const before = f.delivered.length;
  f.tick();
  const after = f.delivered.slice(before);
  ok('learning: the heartbeat after learning is delivered', after.length > 0);
  ok('learning: the heartbeat uses the exact parent origin, not *', after.every((d) => d.targetOrigin === YOUTUBE), JSON.stringify(after.map((d) => d.targetOrigin)));
  ok('learning: ready was still posted exactly once', f.posts().filter((m) => m && m.t === 'ready').length === 1);
}

// ---- 4. a foreign origin cannot teach the frame the parent origin ----
{
  const f = makeFrame();
  f.receive({ t: 'load', url: 'https://example.invalid/evil.m3u8' }, { origin: 'https://evil.example' });
  ok('guard: a foreign origin is rejected', f.diag.inbound.rejected === 1 && f.diag.parentLearnedAt === 0, JSON.stringify(f.diag.inbound));
  ok('guard: the rejected command never reached the player', f.player.loadedUrl === null);
  f.tick();
  ok('guard: posts keep * instead of a forged origin', f.diag.parentOrigin === null && f.delivered.every((d) => d.targetOrigin === '*'));
}

// ---- 5. a wrong token cannot teach the frame either ----
{
  const f = makeFrame();
  f.receive({ t: 'load', url: 'https://example.invalid/spoof.m3u8' }, { token: 'wrongtoken' });
  ok('guard: a wrong token is rejected', f.diag.inbound.rejected === 1 && f.diag.parentLearnedAt === 0, JSON.stringify(f.diag.inbound));
  ok('guard: the spoofed command never reached the player', f.player.loadedUrl === null);
  ok('guard: the right token then still works', (() => {
    f.receive({ t: 'load', url: 'https://example.invalid/ok.m3u8' });
    return f.player.loadedUrl === 'https://example.invalid/ok.m3u8';
  })());
}

console.log(`\nRESULT ${failed ? 'FAIL' : 'PASS'} bridge-handshake checks=${checks} failed=${failed}`);
process.exit(failed ? 1 : 0);
