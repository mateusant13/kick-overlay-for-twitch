// Mute-decision regression harness for twitch-adblock.js.
//
// Owner report (2026-10-26): "when i mute, the ad comes, player swaps, it
// unmutes. respect the last user decision." The ad path covers Twitch with a
// separate clean hls.js player; that player is started muted (Chrome autoplay
// policy) and revealOverlay() used to unmute it unconditionally, so a user who
// had muted the native player got sound back on every ad pod. The native mute
// was captured (wasMuted/holdWasMuted) but only ever used to restore the
// native player at the END of the pod.
//
// This harness runs the REAL twitch-adblock.js against a stubbed DOM and drives
// the real ad path (ad-hold -> ad-start -> frame ready -> 3 healthy Playing
// heartbeats -> reveal), then asserts the mute decision on the wire, at the
// badge, and at ad-end. `node mute-decision-test.cjs` (no frameworks).
//
// Negative arm: the same scenarios run against a copy with the reveal gate
// removed (`if (overlay.muteIntent)` -> `if (false)`), which is exactly the
// pre-fix behavior. The muted scenario MUST fail there; otherwise the detector
// is not measuring anything.
'use strict';
const fs = require('fs');
const path = require('path');

const SOURCE = fs.readFileSync(path.join(__dirname, 'twitch-adblock.js'), 'utf8');
const PRE_FIX_MUTATION = ['if (overlay.muteIntent) {', 'if (false) {'];

// ---- stubs ----------------------------------------------------------------
function makePage(source = SOURCE) {
  const sent = []; // every {t,m,v} the page posts into the clean frame
  const pageListeners = { message: [], pointerdown: [] };
  const bcInstances = [];

  const node = (tag) => {
    const n = {
      tag,
      tagName: String(tag || 'div').toUpperCase(),
      id: '',
      innerHTML: '',
      textContent: '',
      style: {},
      dataset: {},
      attrs: {},
      listeners: {},
      parentElement: null,
      isConnected: true,
      removed: false,
      appendChild(c) { c.parentElement = this; return c; },
      remove() { this.removed = true; this.isConnected = false; },
      addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); },
      removeEventListener(t, f) {
        const l = this.listeners[t] || [];
        const i = l.indexOf(f);
        if (i >= 0) l.splice(i, 1);
      },
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; },
      closest: () => null,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
    };
    return n;
  };

  const docEl = node('html');
  docEl.setAttribute('data-ko-adblock', '1');
  docEl.setAttribute('data-ko-ext-id', 'test');

  const body = node('body');
  const frameWindow = { postMessage: (payload) => { sent.push(payload && payload.__koKick); } };
  let createdFrame = null;
  let createdBadge = null;

  const video = {
    tagName: 'VIDEO',
    style: {},
    isConnected: true,
    paused: false,
    readyState: 4,
    currentTime: 30,
    duration: Infinity,
    muted: false,
    volume: 1,
    videoWidth: 1280,
    videoHeight: 720,
    error: null,
    buffered: { length: 1, start: () => 0, end: () => 40 },
    seekable: { length: 1, start: () => 0, end: () => 40 },
    closest: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
    pause() { this.paused = true; },
    play() { this.paused = false; return Promise.resolve(); },
  };

  const document = {
    documentElement: docEl,
    body,
    fullscreenElement: null,
    visibilityState: 'visible',
    hidden: false,
    createElement: (t) => {
      const n = node(t);
      if (t === 'iframe') {
        n.contentWindow = frameWindow;
        createdFrame = n;
      }
      if (t === 'div') createdBadge = n;
      return n;
    },
    querySelectorAll: (sel) => (sel === 'video' ? [video] : []),
    getElementById: () => null,
    addEventListener(t, f) {
      if (t === 'pointerdown') pageListeners.pointerdown.push(f);
    },
    removeEventListener(t, f) {
      const l = pageListeners[t] || [];
      const i = l.indexOf(f);
      if (i >= 0) l.splice(i, 1);
    },
    dispatchEvent() {},
  };

  const window = {
    addEventListener(t, f) { (pageListeners[t] = pageListeners[t] || []).push(f); },
    removeEventListener(t, f) {
      const l = pageListeners[t] || [];
      const i = l.indexOf(f);
      if (i >= 0) l.splice(i, 1);
    },
    fetch: undefined,
    Worker: undefined,
  };
  const location = {
    href: 'https://www.twitch.tv/rodil',
    pathname: '/rodil',
    search: '',
    hash: '',
    hostname: 'www.twitch.tv',
  };
  const navigator = { userAgent: 'node' };
  const performance = { now: () => Date.now() };
  class BroadcastChannel {
    constructor(name) { this.name = name; this.sent = []; this.onmessage = null; bcInstances.push(this); }
    postMessage(msg) { this.sent.push(msg); }
  }
  class CustomEvent {
    constructor(type, init) { this.type = type; this.detail = init && init.detail; }
  }
  class XMLHttpRequest {
    open() {}
    send() {}
    setRequestHeader() {}
    overrideMimeType() {}
  }
  // A real URL parser (overlaySend builds new URL(frame.src).origin) plus the
  // static createObjectURL the worker hook would use.
  class URLStub extends URL {
    static createObjectURL() { return 'blob:https://www.twitch.tv/ko-test'; }
  }

  const factory = new Function(
    'window', 'document', 'location', 'navigator', 'performance', 'BroadcastChannel',
    'CustomEvent', 'XMLHttpRequest', 'Blob', 'URL', 'btoa', 'console',
    source,
  );
  factory(
    window, document, location, navigator, performance, BroadcastChannel,
    CustomEvent, XMLHttpRequest, class Blob {}, URLStub,
    (s) => Buffer.from(String(s)).toString('base64'), console,
  );

  const api = {
    sent,
    video,
    get frame() { return createdFrame; },
    get badge() { return createdBadge; },
    document,
    bcInstances,
    listeners: pageListeners,
    stats: () => window.__koTwitchAdblockStats,
    frameToken() {
      const m = /token=([^&]+)/.exec((createdFrame && createdFrame.src) || '');
      return m ? decodeURIComponent(m[1]) : '';
    },
    // Drive the real frame -> page message path.
    frameMsg(msg) {
      const token = api.frameToken();
      for (const f of pageListeners.message) {
        f({ origin: 'chrome-extension://test', data: { __koKick: { ...msg, _koToken: token } }, source: frameWindow });
      }
    },
    pageMsg(msg) {
      for (const f of pageListeners.message) {
        f({ origin: 'https://www.twitch.tv', data: { __koKick: { ...msg, _koToken: api.frameToken() } }, source: frameWindow });
      }
    },
    bypass(msg) {
      const ch = bcInstances.find((c) => c.name === 'ko-adblock-bypass');
      const page = (window.__koTwitchAdblockStats && window.__koTwitchAdblockStats.pageId) || '';
      if (ch && ch.onmessage) ch.onmessage({ data: { page, ...msg } });
    },
    clickDocument() {
      for (const f of pageListeners.pointerdown.slice()) f({ type: 'pointerdown' });
    },
    clickBadge() {
      const b = createdBadge;
      for (const f of ((b && b.listeners.click) || []).slice()) f({ type: 'click' });
    },
    muteSent() {
      return sent.filter((m) => m && m.t === 'mute').map((m) => m.m);
    },
  };
  return api;
}

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

function healthySt(overrides) {
  return {
    t: 'st',
    st: Object.assign(
      { state: 'Playing', paused: false, muted: true, rs: 4, buffered: 8, pos: 30, lat: 2, dur: 0, q: { name: '360p' } },
      overrides || {},
    ),
  };
}

// ad-hold -> ad-start -> ready -> 3 healthy Playing ticks -> reveal.
async function runPod(page, { mutedBeforeAd, autoStart = true }) {
  page.video.muted = mutedBeforeAd;
  page.bypass({ type: 'ad-hold' });
  if (autoStart) page.bypass({ type: 'ad-start', url: 'https://clean.example/live.m3u8', channel: 'rodil' });
  await settle(20);
  page.frameMsg({ t: 'ready' });
  for (let i = 0; i < 3; i++) page.frameMsg(healthySt());
  await settle(20);
}

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push({ name, status: 'PASS' });
    console.log(`PASS ${name}`);
  } catch (error) {
    checks.push({ name, status: 'FAIL', detail: error.message });
    console.log(`FAIL ${name}  ${error.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  // ---- 1: the owner's report. Muted user, an ad swaps the player. --------
  {
    const page = makePage();
    await runPod(page, { mutedBeforeAd: true });
    const afterReveal = page.muteSent();
    check('muted user is NOT unmuted when the clean player reveals', () => {
      assert(page.frame.removed === false, 'clean frame was removed instead of revealed');
      assert(page.sent.some((m) => m && m.t === 'load'), 'frame never received the clean url');
      assert(!afterReveal.includes(false), `sent mute:false -> ${JSON.stringify(page.sent)}`);
      assert(afterReveal.includes(true), 'the clean player was never told to stay muted');
    });
    check('muted user sees a click-to-sound badge', () => {
      assert(/clique para som/.test(page.badge.textContent), `badge text: ${page.badge.textContent}`);
    });
    check('a click anywhere else on the page does NOT unmute a muted user', () => {
      page.clickDocument();
      assert(!page.muteSent().includes(false), 'a generic page click restored the audio');
    });
    check('an explicit badge click still restores sound', () => {
      page.clickBadge();
      assert(page.muteSent().includes(false), 'the badge click did not unmute');
    });
    check('ad-end restores the mute the user asked for during the pod', () => {
      page.bypass({ type: 'ad-end' });
      assert(page.video.muted === false, `native restored muted=${page.video.muted} after an explicit unmute`);
    });
  }

  // ---- 2: muted user, ad ends without an unmute: native stays muted. -----
  {
    const page = makePage();
    await runPod(page, { mutedBeforeAd: true });
    page.bypass({ type: 'ad-end' });
    check('ad-end keeps the native player muted for a muted user', () => {
      assert(page.video.muted === true, `native restored muted=${page.video.muted}`);
    });
  }

  // ---- 3: sound-on user keeps the existing autoplay path. ----------------
  {
    const page = makePage();
    await runPod(page, { mutedBeforeAd: false });
    check('an unmuted user still gets sound restored at reveal', () => {
      assert(page.muteSent().includes(false), `sent mute values: ${JSON.stringify(page.muteSent())}`);
      assert(page.muteSent().indexOf(false) > page.muteSent().lastIndexOf(true), 'unmute came before the initial mute');
    });
  }

  // ---- 4: mute made AFTER a warm standby was minted (standby adoption) ---
  {
    const page = makePage();
    // Standby minted at page load, while the user still had sound on.
    page.video.muted = false;
    page.bypass({ type: 'standby-start', url: 'https://clean.example/live.m3u8', channel: 'rodil' });
    await settle(20);
    page.frameMsg({ t: 'ready' });
    for (let i = 0; i < 3; i++) page.frameMsg(healthySt()); // healthy but hidden
    // The user mutes Twitch later, then the ad arrives.
    page.video.muted = true;
    page.bypass({ type: 'ad-hold' });
    page.bypass({ type: 'ad-start', url: 'https://clean.example/live.m3u8', channel: 'rodil' });
    await settle(20);
    for (let i = 0; i < 3; i++) page.frameMsg(healthySt());
    check('a standby minted before the mute does not unmute at reveal', () => {
      assert(page.muteSent().includes(true), 'no mute was ever sent');
      assert(!page.muteSent().includes(false), 'stale standby mute state overruled the user');
    });
  }

  // ---- 5: negative arm. Same scenario against the pre-fix gate. ----------
  {
    const mutated = SOURCE.split(PRE_FIX_MUTATION[0]).join(PRE_FIX_MUTATION[1]);
    check('negative arm: the pre-fix mutation applied', () => {
      assert(mutated !== SOURCE, 'the pre-fix mutation did not apply');
    });
    const page = makePage(mutated);
    await runPod(page, { mutedBeforeAd: true });
    check('negative arm: the pre-fix code IS caught unmuting a muted user', () => {
      assert(page.muteSent().includes(false), 'the detector accepted the pre-fix behavior — it measures nothing');
    });
  }

  const failed = checks.filter((c) => c.status === 'FAIL');
  console.log('');
  console.log(`RESULT ${failed.length ? 'FAIL' : 'PASS'} mute-decision checks=${checks.length} failed=${failed.length}`);
  process.exit(failed.length ? 1 : 0);
}

if (require.main === module) {
  main().catch((error) => {
    console.error('\nRESULT FAIL', error && error.message ? error.message : error);
    process.exit(1);
  });
} else {
  module.exports = { makePage, runPod, settle, healthySt };
}
