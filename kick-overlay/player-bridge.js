'use strict';
// Kick player bridge — hosts the SAME engine kick.com uses (Amazon IVS
// web player, amazon-ivs-player) inside the extension page, so the wasm
// worker is same-origin (no CORS/importScripts traps) and playback_url
// fetches ride on the extension's host_permissions. Controls are driven
// over postMessage by the content script; state is reported back ~1/s.
const V = document.getElementById('v');
const params = new URLSearchParams(location.search);
const HLS_MODE = params.get('m') === 'hls';
const TWITCH_HLS = HLS_MODE && params.get('tw') === '1';
const PLAYER_TOKEN = params.get('token');
// The embed's parent page. Historically twitch.tv only; since 0.8.2 the
// same bridge also runs over youtube.com pages (the overlay's YT layer).
// The actual origin is LEARNED from the first token-valid message — the
// shared secret (PLAYER_TOKEN, minted per page by the content script) is
// what authenticates the parent, not a hardcoded host — so replies are
// addressed to that exact origin afterwards. Until then the frame does not
// know who its parent is, and a post to the wrong targetOrigin is dropped
// silently by the browser (measured 2026-10-26: 0 deliveries for
// https://www.twitch.tv from a youtube.com page, KO-20261026-02). `ready` is
// emitted at load, before any inbound message can teach us the real parent,
// so an unknown parent is addressed with '*'; the payload still carries the
// per-page token, and the page still validates origin and source.
const PARENT_ORIGINS = new Set([
  'https://www.twitch.tv',
  'https://www.youtube.com',
  'https://m.youtube.com',
  'https://youtube.com',
  'https://youtu.be',
]);
let PARENT_ORIGIN = null; // learned from the first token-valid message
// 0.8.41 diag (KO-20261026-02). The black box on a YouTube watch page with
// player=kick has one measured fact and no cause: the content script never
// received `ready`, while `st` did arrive. Two things had to be measurable
// instead of assumed: (a) what this frame actually posted, to which origin,
// and whether the parent origin had been learned at that moment, and (b) what
// arrived from the parent and what was rejected. Counters only; no behaviour
// change. Read it from the harness with `eval --target=ivs "__koBridgeDiag"`.
const BRIDGE_DIAG = (window.__koBridgeDiag = {
  startedAt: Date.now(),
  mode: HLS_MODE ? (TWITCH_HLS ? 'twitch-hls' : 'yt-hls') : 'ivs',
  token: PLAYER_TOKEN ? String(PLAYER_TOKEN).slice(0, 8) : null,
  parentOrigin: PARENT_ORIGIN,
  learned: false,
  parentLearnedAt: 0,
  learnedFrom: null,
  posts: {},
  firstPost: {},
  postErrors: 0,
  inbound: { total: 0, accepted: 0, rejected: 0, byOrigin: {}, firstReject: null },
});
const beacon = (ev, data) => {
  try {
    chrome.runtime.sendMessage({ __koDiag: { ev, data } }, () => void chrome.runtime.lastError);
  } catch {
    /* beacon must never break the player */
  }
};
window.addEventListener('error', (e) => beacon('ivs_page_err', { msg: String((e && e.message) || e).slice(0, 150), src: (e && e.filename ? e.filename.slice(-40) : '') }));
window.addEventListener('unhandledrejection', (e) => beacon('ivs_page_err', { rej: String((e && e.reason) || '').slice(0, 150) }));
const post = (m) => {
  if (!PLAYER_TOKEN) return;
  const d = BRIDGE_DIAG;
  // Unknown parent (`ready` at load) goes to '*' so it cannot be dropped by a
  // targetOrigin mismatch; every post after the first valid inbound message
  // uses that exact origin.
  const target = PARENT_ORIGIN || '*';
  d.posts[m.t] = (d.posts[m.t] || 0) + 1;
  if (!d.firstPost[m.t]) {
    // A post to the wrong targetOrigin is dropped by the browser with no
    // error, so the origin in effect is the fact worth keeping.
    d.firstPost[m.t] = {
      ms: Math.round(performance.now()),
      to: target,
      learned: !!d.learned,
      state: m.st ? m.st.state : null,
    };
  }
  try {
    parent.postMessage({ __koKick: { ...m, _koToken: PLAYER_TOKEN } }, target);
  } catch {
    d.postErrors++;
  }
};

// Shared inbound bookkeeping for both engines (HLS and IVS listeners below).
function noteInbound(ev, stage, detail) {
  const d = BRIDGE_DIAG;
  if (stage === 'head') {
    d.inbound.total++;
    const o = String((ev && ev.origin) || '(none)');
    d.inbound.byOrigin[o] = (d.inbound.byOrigin[o] || 0) + 1;
    return;
  }
  if (stage === 'reject') {
    d.inbound.rejected++;
    if (!d.inbound.firstReject) {
      d.inbound.firstReject = {
        ms: Math.round(performance.now()),
        origin: String((ev && ev.origin) || '(none)'),
        fromParent: !!(ev && ev.source === window.parent),
        hasKick: !!(ev && ev.data && ev.data.__koKick),
        reason: String(detail || ''),
      };
    }
    return;
  }
  d.inbound.accepted++;
  if (!d.learned) {
    d.learned = true;
    d.parentLearnedAt = Math.round(performance.now());
    d.learnedFrom = {
      origin: String(ev.origin || ''),
      fromParent: ev.source === window.parent,
      t: String(detail && detail.t),
    };
  }
}

// Keyboard relay (0.8.6, pain 2): when focus lives INSIDE the extension-page
// iframe (after the user clicks the player — the host's document-level
// keydown capture never sees those presses, because the event targets the
// chrome-extension:// frame's own document), forward the overlay-relevant
// keys up so the content script issues the same seek/fullscreen it would for
// a keypress on the Twitch page. Only the keys the host's onOverlayKeydown
// whitelists (f / arrowleft / arrowright) are relayed, so the native YT
// controls (space = play/pause, and every other key) are left untouched.
// 'f' maps to the host's fullscreen toggle. preventDefault keeps the frame
// from also acting on the arrow (e.g. scrolling the page body).
const RELAY_KEYS = new Set(['f', 'arrowleft', 'arrowright']);
window.addEventListener('keydown', (ev) => {
  const k = String(ev.key).toLowerCase();
  if (!RELAY_KEYS.has(k) || ev.ctrlKey || ev.metaKey || ev.altKey || ev.shiftKey) return;
  const t = ev.target;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
  try { ev.preventDefault(); } catch { /* ignore */ }
  post({ t: 'key', k });
});

if (HLS_MODE) {
  // ---- HLS engine (YouTube layer) ------------------------------------------
  // Same bridge protocol as IVS: {t:'load'|'play'|'pause'|'mute'|'volume'|
  // 'seek'|'seekToLive'|'getState'} in, {t:'ready'} + ~1/s {t:'st'} + {t:'ev'}
  // out. hls.js plays the innertube hlsManifestUrl; native controls visible.
  V.controls = true; // native controls give the yt layer the embed-era UX
  // Twitch overlay: start muted so Chrome's autoplay policy cannot park the
  // clean player in Buffering/Idle while the native ad is still visible.
  // The badge offers a click-to-unmute after reveal. The YouTube layer keeps
  // its existing mute handling.
  if (TWITCH_HLS) V.muted = true;
  // 0.8.16: Twitch SSAI ads can appear on ANY token type. A playlist that
  // looked clean at probe time can turn ad-only on its next refresh (measured
  // on necros: site/web 15 clean segments -> 15 DCM/Amazon segments). Strip
  // stitched ad segments in hls.js itself, before they are parsed/buffered.
  // Keep the last clean playlist while an ad-only refresh is in flight, so
  // hls.js freezes on the last content frame instead of playing the ad.
  const cleanPlaylistCache = new Map();
  const adFilterStats = { strips: 0, adOnly: 0, last: null, lastSignalAt: 0 };
  let adOnlySignaled = false;
  const twitchPlaylist = (url) => /(^|\.)ttvnw\.net\//i.test(String(url || ''));
  const playlistCounts = (text) => {
    let content = 0;
    let ads = 0;
    for (const line of String(text || '').replace(/\r/g, '').split('\n')) {
      if (!line.startsWith('#EXTINF')) continue;
      if (/,live\s*$/.test(line)) content++;
      else ads++;
    }
    return { content, ads };
  };
  const stripTwitchAds = (text, url) => {
    if (!text) return text;
    const counts = playlistCounts(text);
    if (!counts.ads) {
      adOnlySignaled = false;
      return text;
    }
    const lines = text.replace(/\r/g, '').split('\n');
    const out = [];
    let skipUri = false;
    let leadingRemoved = 0;
    let seenContent = false;
    for (const line of lines) {
      if (skipUri) {
        // The segment URI (and optional byte-range tag) belongs to the ad
        // EXTINF just removed. Tags before that URI are part of the ad too.
        if (line.startsWith('#EXT-X-BYTERANGE')) continue;
        if (line.startsWith('#')) continue;
        skipUri = false;
        if (!seenContent) leadingRemoved++;
        continue;
      }
      if (line.startsWith('#EXTINF')) {
        // Twitch marks content segments ",live"; stitched ad segments do not.
        if (!/,live\s*$/.test(line)) {
          skipUri = true;
          continue;
        }
        seenContent = true;
        out.push(line);
        continue;
      }
      if (line.startsWith('#EXT-X-DATERANGE') && /twitch-stitched-ad|X-TV-TWITCH-AD-URL/i.test(line)) {
        continue;
      }
      out.push(line);
    }
    let clean = out.join('\n');
    const cleanCounts = playlistCounts(clean);
    if (cleanCounts.content === 0) {
      adFilterStats.adOnly++;
      adFilterStats.last = { at: Date.now(), kind: 'ad-only', url: String(url).slice(0, 120) };
      // 0.8.17: an ad-only refresh means this token type has no content right
      // now. Hls.js can sit in Buffering forever on the stale cached window
      // (measured on necros: 40s of black while the ad played). Ask the worker
      // to probe other token types and reload the overlay with a clean one.
      const now = Date.now();
      if (!adOnlySignaled || now - adFilterStats.lastSignalAt > 2500) {
        adOnlySignaled = true;
        adFilterStats.lastSignalAt = now;
        post({ t: 'ev', e: 'ad-only', d: String(counts.ads) });
      }
      // Reuse the last clean live window if we have one; otherwise hand
      // hls.js an empty live playlist so it waits instead of buffering an ad.
      return cleanPlaylistCache.get(url) || '#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n';
    }
    adOnlySignaled = false;
    // Removing leading ad segments shifts hls.js's implicit fragment numbers;
    // bump MEDIA-SEQUENCE by the same amount so the remaining SNs stay monotonic.
    if (leadingRemoved) {
      clean = clean.replace(/#EXT-X-MEDIA-SEQUENCE:(\d+)/, (_m, n) => `#EXT-X-MEDIA-SEQUENCE:${Number(n) + leadingRemoved}`);
    }
    cleanPlaylistCache.set(url, clean);
    adFilterStats.strips++;
    adFilterStats.last = { at: Date.now(), kind: 'stripped', ads: counts.ads, content: cleanCounts.content, url: String(url).slice(0, 120) };
    return clean;
  };
  class TwitchAdFilterLoader extends Hls.DefaultConfig.loader {
    load(context, config, callbacks) {
      const { type, url } = context;
      if ((type === 'manifest' || type === 'level' || type === 'audioTrack') && twitchPlaylist(url)) {
        const complete = callbacks.onSuccess;
        callbacks.onSuccess = (response, stats, successContext, networkDetails) => {
          try {
            if (response && typeof response.data === 'string') {
              const clean = stripTwitchAds(response.data, url);
              if (clean !== response.data) {
                response.data = clean;
                post({ t: 'ev', e: 'adstrip', d: `${adFilterStats.strips}/${adFilterStats.adOnly}` });
              }
            }
          } catch (e) {
            post({ t: 'ev', e: 'adstrip-error', d: String(e).slice(0, 120) });
          }
          complete(response, stats, successContext, networkDetails);
        };
      }
      super.load(context, config, callbacks);
    }
  }
  // 0.8.6 pain-1: the yt rewind window is TUNED, not whatever the playlist
  // grants - liveBackBufferLength anchors the ~20s seekable window the bar,
  // the "LIVE -Ns" pill and the edge-clamp all promise (0.8.5 left it at the
  // hls.js default, so the window was shorter than the UI implied).
  // The Twitch overlay is a fallback surface, not the primary player: start
  // closer to the live edge with a smaller buffer so a clean frame appears
  // in ~1-2s instead of hls.js buffering three live segments (~5s measured).
  // The YouTube layer keeps its tuned 30s/3-segment live buffer.
  const hlsConfig = TWITCH_HLS
    ? {
        // A 1-segment live sync left the clean player 0.04s from the edge in
        // the 2026-10-23 10-channel run; hls.js then stalled on the first
        // refresh. Keep one target segment of slack so the hidden player has
        // something to play while the next segment is fetched.
        maxBufferLength: 30,
        liveSyncDurationCount: 2,
        liveBackBufferLength: 30,
        startPosition: -1,
        // The clean autoplay/android master can be LL-HLS. hls.js's low-latency
        // mode then follows parts with <1s of forward buffer and stalls on a
        // normal segment refresh (measured: 0.04-0.888s buffered on jynxzi).
        // Full-segment live sync gives the hidden/visible clean player runway.
        lowLatencyMode: false,
        // Start on the lowest rendition. A cold standby on the native master
        // otherwise races a 1080p segment download before the preroll lands;
        // ABR can step up after the first clean frame.
        startLevel: 0,
        pLoader: TwitchAdFilterLoader,
      }
    : {
        maxBufferLength: 30,
        liveSyncDurationCount: 3,
        liveBackBufferLength: 20,
        pLoader: TwitchAdFilterLoader,
      };
  const h = new Hls(hlsConfig);
  let currentUrl = null;
  let reloaded = false;
  // hls.js can start a DVR playlist at its oldest segment (measured: a 30s
  // window began at currentTime 0 / lat 30). Jump once per load only in that
  // case, or when the player somehow starts inside 1.5s of the edge. Do not
  // pull a player that hls.js already placed behind live: the old unconditional
  // `end - 0.5` jump left the 2026-10-23 clean player at 0.04s of buffer and
  // it stalled on the first refresh. A deliberate user seek later is not
  // overridden because the flag is only reset by a new load.
  let liveJumped = false;
  const jumpToLiveEdge = () => {
    if (liveJumped) return;
    try {
      if (!V.seekable || !V.seekable.length) return;
      const end = V.seekable.end(V.seekable.length - 1);
      if (!isFinite(end) || end <= 0) return;
      const pos = V.currentTime || 0;
      const behind = end - pos;
      // liveSyncDurationCount 2 with 15s segments puts a healthy clean player
      // about 30s behind the edge. The old `behind > 20` test mistook that for
      // a DVR start and jumped to end-2, leaving only 0.4-1.2s of forward
      // buffer on jynxzi (2026-10-24), so the 4s readiness gate never opened.
      // Only correct a real DVR position or a player sitting on the edge.
      if (behind > 120 || behind < 1.5) V.currentTime = Math.max(0, end - 2);
      liveJumped = true;
      V.play().catch(() => { /* autoplay policy */ });
    } catch { /* not ready */ }
  };
  h.on(Hls.Events.MANIFEST_PARSED, jumpToLiveEdge);
  h.on(Hls.Events.LEVEL_LOADED, jumpToLiveEdge);
  const st = () => {
    let dur = 0;
    try { dur = V.duration || 0; } catch { /* not ready */ }
    if (!isFinite(dur) || dur < 0 || dur >= 1e15) dur = 0;
    let pos = V.currentTime || 0;
    if (!isFinite(pos) || pos < 0 || pos >= 1e15) pos = 0;
    let lat = 0;
    try {
      if (V.seekable && V.seekable.length) lat = V.seekable.end(V.seekable.length - 1) - pos;
    } catch { /* not ready */ }
    if (!isFinite(lat) || lat < 0) lat = 0;
    const levels = h.levels || [];
    let q = null;
    if (h.currentLevel >= 0 && levels[h.currentLevel]) {
      const l = levels[h.currentLevel];
      q = { name: l.height ? `${l.height}p` : `${l.width || ''}w`, w: l.width, h: l.height };
    }
    const qualities = levels.map((l, i) => ({
      id: i,
      name: l.height ? `${l.height}p` : `${l.width || ''}w`,
      w: l.width,
      h: l.height,
    }));
    // A drained live stream ends the element and then sits paused forever, so
    // 'Ended' gets its own name: the content side maps an unknown state to
    // NOT-live, which is what stops a dead YouTube layer from pinning a black
    // box over the deleted Twitch player.
    // readyState < HAVE_CURRENT_DATA means the element is not really producing
    // frames (measured at a 403 segment stall: paused=false / readyState=0 / no
    // buffer, which used to be reported as Playing and masked the failure).
    const state = V.ended
      ? 'Ended'
      : V.paused
        ? (V.readyState === 0 ? 'Idle' : 'Paused')
        : (V.readyState < 2 ? 'Buffering' : 'Playing');
    let buffered = 0;
    try {
      if (V.buffered && V.buffered.length) buffered = V.buffered.end(V.buffered.length - 1) - pos;
    } catch { /* not ready */ }
    return {
      state,
      paused: V.paused,
      muted: V.muted,
      volume: V.volume,
      rs: V.readyState,
      ns: V.networkState,
      err: V.error ? V.error.code : null,
      buffered: isFinite(buffered) ? Math.max(0, buffered) : 0,
      pos,
      lat,
      dur,
      q,
      qcount: qualities.length,
      qualities,
    };
  };
  const sendSt = () => post({ t: 'st', st: st() });
  window.addEventListener('message', (ev) => {
    noteInbound(ev, 'head');
    if (ev.source !== window.parent || !PARENT_ORIGINS.has(ev.origin)) {
      noteInbound(ev, 'reject', 'source-or-origin');
      return;
    }
    const m = ev.data && ev.data.__koKick;
    if (!m || m._koToken !== PLAYER_TOKEN) {
      noteInbound(ev, 'reject', m ? 'token' : 'no-koKick');
      return;
    }
    noteInbound(ev, 'accept', m);
    PARENT_ORIGIN = ev.origin; // answers follow the page that owns us
    switch (m.t) {
      case 'load':
        try {
          currentUrl = m.url;
          reloaded = false;
          liveJumped = false;
          h.loadSource(m.url);
          h.attachMedia(V);
          V.play().catch(() => { /* autoplay policy — unlock via gesture */ });
        } catch (e) {
          post({ t: 'ev', e: 'error', d: String(e) });
        }
        break;
      case 'play':
        V.play().catch(() => { /* ignore */ });
        break;
      case 'pause':
        V.pause();
        break;
      case 'mute':
        V.muted = !!m.m;
        break;
      case 'volume':
        if (Number.isFinite(m.v)) V.volume = Math.max(0, Math.min(1, m.v));
        break;
      case 'seek':
        if (Number.isFinite(m.s) && m.s >= 0 && m.s < 1e15) {
          // Clamp into the actual seekable range (the live window), never
          // past the live edge — an un-clamped currentTime there silently
          // snaps back to the buffer head on the next 'st' (0.8.5: arrow
          // overshoot left the playhead visibly jittering instead of live).
          let lo = 0, hi = m.s;
          try {
            if (V.seekable && V.seekable.length) {
              lo = V.seekable.start(0);
              hi = V.seekable.end(V.seekable.length - 1);
            }
          } catch { /* not ready */ }
          V.currentTime = Math.max(lo, Math.min(hi, m.s));
        }
        break;
      case 'seekToLive':
        try {
          if (V.seekable && V.seekable.length) V.currentTime = V.seekable.end(V.seekable.length - 1);
        } catch { /* ignore */ }
        break;
      case 'quality':
        if (m.q === 'auto') h.currentLevel = -1;
        else if (Number.isInteger(m.q) && m.q >= 0 && m.q < h.levels.length) h.currentLevel = m.q;
        break;
      // Vertical quality menu (0.8.2): the REAL hls.js levels, not a static
      // guess list. 'levels' mirrors the {t:'st'} qualities shape; the menu
      // adds its own Auto row.
      case 'getLevels':
        post({
          t: 'levels',
          levels: (h.levels || []).map((l, i) => ({
            id: i,
            name: l.height ? `${l.height}p` : `${l.width || ''}w`,
            w: l.width,
            h: l.height,
          })),
        });
        break;
      case 'setLevel':
        if (m.l === 'auto') h.currentLevel = -1;
        else if (Number.isInteger(m.l) && m.l >= 0 && m.l < (h.levels || []).length) h.currentLevel = m.l;
        sendSt(); // the checkmark follows the engine, not the click
        break;
      case 'getState':
        sendSt();
        break;
    }
  });
  h.on(Hls.Events.ERROR, (_e, d) => {
    beacon('hls_err', { type: d.type, details: d.details, fatal: !!d.fatal });
    post({ t: 'ev', e: 'hls', d: String(d.details || d.type || ''), fatal: !!d.fatal, url: String(d.url || '').slice(0, 160) });
    if (d.fatal) {
      post({ t: 'ev', e: 'error', d: String(d.details || d.type) });
      // One reload per url (stale manifest on live switches); then the
      // content script's fallback (kick) takes over.
      if (currentUrl && !reloaded) {
        reloaded = true;
        setTimeout(() => {
          h.loadSource(currentUrl);
          h.attachMedia(V);
        }, 1500);
      }
    }
  });
  setInterval(sendSt, 1000);
  // Report the first real frame immediately. The 1/s `st` heartbeat can lag
  // up to a second; the content script uses this to swap surfaces exactly when
  // the clean player can paint, not on a fixed timeout.
  let firstFrameSent = false;
  const firstFrame = () => {
    if (firstFrameSent || V.readyState < 2) return;
    firstFrameSent = true;
    post({ t: 'ev', e: 'firstframe', st: st() });
  };
  V.addEventListener('playing', firstFrame);
  post({ t: 'ready' });
} else {
  const IVS = window.IVSPlayerModule;
  beacon('ivs_page', { mod: typeof IVS, create: typeof (IVS || {}).create });
  const create = IVS.create;
  const ET = IVS.PlayerEventType || {};
  const p = create({
    wasmWorker: chrome.runtime.getURL('ivs/amazon-ivs-wasmworker.min.js'),
    wasmBinary: chrome.runtime.getURL('ivs/amazon-ivs-wasmworker.min.wasm'),
    logLevel: 'warn',
  });
  beacon('ivs_boot', { ver: p.getVersion(), worker: chrome.runtime.getURL('ivs/amazon-ivs-wasmworker.min.js').slice(-44) });
  p.attachHTMLVideoElement(V);
  p.setAutoplay(true);
  p.setMuted(true);

// A position to apply once the next load() completes (kick-style rewind:
// switch to the DVR url, then seek within the loaded broadcast).
let pendingSeek = null;
let pendingTries = 0; // seek retry budget (1/s) - give up instead of looping
let seekGen = 0;      // cancels a stale retry when a newer seek/live wins

function sendSt() {
  let q = null;
  try {
    const qq = p.getQuality();
    if (qq) q = { name: qq.name, w: qq.width, h: qq.height };
  } catch {
    /* not ready */
  }
  let qualities = [];
  try {
    qualities = p.getQualities().map((quality, id) => ({
      id,
      name: quality.name,
      w: quality.width,
      h: quality.height,
    }));
  } catch {
    /* not ready */
  }
  let dur = 0;
  try {
    dur = p.getDuration() || 0;
  } catch {
    /* not ready */
  }
  // Sanitize everything that reaches the bar: a poisoned seek (or IVS
  // quirks) can report MAX_SAFE_INTEGER / NaN positions — the content
  // script must never format Infinity or set an insane input range.
  let pos = 0;
  try {
    pos = p.getPosition();
  } catch {
    /* not ready */
  }
  if (!isFinite(pos) || pos < 0 || pos >= 1e15) pos = 0;
  // getLiveLatency() is the SDK's smoothed latency and does NOT update
  // immediately after a manual seek (measured: pos dropped 5s at t=0, lat
  // still read 1.5s until t≈5s). The buffered range end is the real newest
  // live frame and moves with the seek instantly, so the bar/pill and the
  // seekToLive target use `buffered.end - pos`. On the DVR/VOD url there is
  // no live edge: the player can buffer far ahead, which made this formula
  // report 30s+ "latency" and label the replay "LIVE -38s". A finite
  // duration identifies that url, where latency is meaningless (0). Live
  // streams report Infinity here (JSON turns that into null), so the
  // isFinite check must come before deciding "this is VOD".
  let lat = 0;
  if (!(isFinite(dur) && dur > 0)) {
    try {
      const b = p.getBuffered();
      if (b && isFinite(b.end) && isFinite(pos)) lat = Math.max(0, b.end - pos);
    } catch {
      /* not ready */
    }
    if (!(lat > 0)) {
      try {
        lat = p.getLiveLatency();
      } catch {
        /* not ready */
      }
    }
  }
  if (!isFinite(lat)) lat = 0;
  if (!isFinite(dur) || dur < 0 || dur >= 1e15) dur = 0;
  // Retry a pending rewind seek every poll until it lands, capped — IVS
  // drops a seekTo issued before the loaded media is seekable (first
  // Playing can fire with an empty seekable range), but a target that
  // never becomes reachable must give up instead of seeking forever
  // (that "video replays every second" bug — each seek restarts playback).
  if (pendingSeek !== null && pendingSeek < 1e15) {
    if (pendingTries-- > 0) {
      if (pos < pendingSeek - 1) {
        try {
          p.seekTo(pendingSeek);
        } catch {
          pendingSeek = null; // outside the timeline — give up quietly
        }
      } else {
        pendingSeek = null; // landed
      }
    } else {
      pendingSeek = null; // capped — stop hammering
    }
  }
  post({
    t: 'st',
    st: {
      state: p.getState(),
      paused: p.isPaused(),
      muted: p.isMuted(),
      volume: p.getVolume(),
      pos,
      lat,
      dur,
      q,
      qcount: qualities.length,
      qualities,
    },
  });
}

window.addEventListener('message', (ev) => {
  noteInbound(ev, 'head');
  if (ev.source !== window.parent || !PARENT_ORIGINS.has(ev.origin)) {
    noteInbound(ev, 'reject', 'source-or-origin');
    return;
  }
  const m = ev.data && ev.data.__koKick;
  if (!m || m._koToken !== PLAYER_TOKEN) {
    noteInbound(ev, 'reject', m ? 'token' : 'no-koKick');
    return;
  }
  noteInbound(ev, 'accept', m);
  PARENT_ORIGIN = ev.origin; // answers follow the page that owns us
  switch (m.t) {
    case 'load':
      try {
        seekGen++;
        pendingSeek = null;
        p.load(m.url);
        if (Number.isFinite(m.seekTo) && m.seekTo > 0 && m.seekTo < 1e15) {
          pendingSeek = m.seekTo;
          pendingTries = 30;
        }
        p.play();
      } catch (e) {
        post({ t: 'ev', e: 'error', d: String(e) });
      }
      break;
    case 'play':
      try { p.play(); } catch (e) { /* ignore */ }
      break;
    case 'pause':
      try { p.pause(); } catch (e) { /* ignore */ }
      break;
    case 'mute':
      try { p.setMuted(!!m.m); } catch (e) { /* ignore */ }
      break;
    case 'volume':
      try { p.setVolume(m.v); } catch (e) { /* ignore */ }
      break;
    case 'seek':
      // IVS owns its own clock: writing video.currentTime (the HLS bridge's
      // path) is ignored/re-based on a live element, which is why a 5s
      // rewind looked like a forward jump. getPosition()/seekTo() are the
      // player's own timeline, so a relative arrow step lands correctly.
      try {
        if (Number.isFinite(m.s) && m.s >= 0 && m.s < 1e15) {
          const cur = p.getPosition() || 0;
          let edge = 0;
          try {
            const b = p.getBuffered();
            if (b && isFinite(b.end)) edge = b.end;
          } catch { /* not ready */ }
          if (!(edge > 0)) {
            const lat = p.getLiveLatency();
            edge = cur + (isFinite(lat) && lat > 0 ? lat : 0);
          }
          const target = Math.max(0, Math.min(m.s, Math.max(0, edge - 0.25)));
          // IVS drops a seekTo issued while the live buffer is still
          // attaching (observed: first ArrowLeft after a fresh load did
          // nothing, second landed). Retry only when the player clearly did
          // not move: position reached/approached the target, or a live
          // rewind raised the latency. Same-target retries are harmless.
          const beforeLat = Math.max(0, edge - cur);
          const gen = ++seekGen;
          let tries = 0;
          const attempt = () => {
            if (gen !== seekGen) return; // a newer seek/live owns the player
            try { p.seekTo(target); p.play(); } catch { /* not ready */ }
            tries++;
            if (tries >= 3) return;
            setTimeout(() => {
              if (gen !== seekGen) return;
              try {
                const nowPos = p.getPosition() || 0;
                let nowLat = 0;
                try {
                  const b = p.getBuffered();
                  if (b && isFinite(b.end)) nowLat = Math.max(0, b.end - nowPos);
                } catch { /* not ready */ }
                const ok = Math.abs(nowPos - target) < 3 || nowLat > beforeLat + 2;
                if (!ok) attempt();
              } catch { attempt(); }
            }, 450);
          };
          attempt();
        }
      } catch (e) { /* ignore */ }
      break;
    case 'seekToLive':
      seekGen++; // a pending ArrowLeft retry must not pull us back again
      try {
        // The newest actually-buffered frame is the live edge. getLiveLatency()
        // lags a manual rewind by several seconds, so `pos + getLiveLatency()`
        // used to "go live" to a point only just ahead of the rewound playhead.
        // Buffered end tracks the edge immediately and shares getPosition()'s
        // timeline. Do NOT use the media element's seekable.end: IVS reports a
        // sentinel ~2^30 on a live edge and seeking there froze the player.
        const cur = p.getPosition() || 0;
        let target = 0;
        try {
          const b = p.getBuffered();
          if (b && isFinite(b.end) && b.end > 0) target = b.end - 0.25;
        } catch { /* not ready */ }
        if (!(target > cur)) {
          try {
            const lat = p.getLiveLatency();
            if (isFinite(lat) && lat > 0) target = cur + lat;
          } catch { /* not ready */ }
        }
        if (target > 0 && target > cur + 0.5) p.seekTo(target);
        p.play(); // already at the edge, or start the seek immediately
      } catch (e) { /* ignore */ }
      break;
    case 'quality':
      try {
        if (m.q === 'auto') {
          p.setAutoQualityMode(true);
        } else if (Number.isInteger(m.q)) {
          const qualities = p.getQualities();
          const selected = qualities[m.q];
          if (selected) {
            p.setAutoQualityMode(false);
            p.setQuality(selected);
          }
        }
      } catch (e) { /* quality menu is best-effort */ }
      break;
    // Vertical quality menu (0.8.2): IVS's real quality ladder, same
    // {id,name,w,h} shape the 'st' message carries.
    case 'getLevels': {
      let levels = [];
      try {
        levels = p.getQualities().map((quality, id) => ({
          id,
          name: quality.name,
          w: quality.width,
          h: quality.height,
        }));
      } catch (e) { /* not ready yet */ }
      post({ t: 'levels', levels });
      break;
    }
    case 'setLevel':
      try {
        if (m.l === 'auto') {
          p.setAutoQualityMode(true);
        } else if (Number.isInteger(m.l) && m.l >= 0) {
          const selected = p.getQualities()[m.l];
          if (selected) {
            p.setAutoQualityMode(false);
            p.setQuality(selected);
          }
        }
      } catch (e) { /* quality menu is best-effort */ }
      sendSt(); // the checkmark follows the engine, not the click
      break;
    case 'getState':
      sendSt();
      break;
  }
});

try {
  p.addEventListener(ET.ERROR || 'PlayerError', (e) => {
    const info = { d: (e && e.message) || 'unknown', code: (e && e.code) || 0 };
    post({ t: 'ev', e: 'error', d: info.d, code: info.code });
    beacon('ivs_err', info);
  });
  p.addEventListener(ET.REBUFFERING || 'PlayerRebuffering', () => post({ t: 'ev', e: 'rebuffering' }));
} catch {
  /* event wiring is best-effort; state polling still reports errors via getState */
}
setInterval(sendSt, 1000);
post({ t: 'ready' });
} // /else (IVS engine)
