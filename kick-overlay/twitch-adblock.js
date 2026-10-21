'use strict';
// Twitch SSAI adblock (MAIN world, document_start).
//
// How Twitch ads work (measured 2026-10-20, Chrome 155 / Twitch v2 HLS):
//  - The page mints a PlaybackAccessToken through gql.twitch.tv, then asks
//    usher.ttvnw.net/api/v2/channel/hls/<channel>.m3u8 for the master.
//  - The player itself runs in a blob:https://www.twitch.tv worker, which
//    fetches the media playlists. Ads are stitched INTO those playlists
//    (CLASS="twitch-stitched-ad" / X-TV-TWITCH-AD-URL / #EXTINF without
//    ",live"), so blocking domains or segments by URL cannot work.
//  - The player type embedded in the token decides ad eligibility. Measured
//    on this IP: playerType "embed" produced stitched midroll ads, while
//    "popout" served the same channel clean. This is the modern VAFT/
//    TTV LOL PRO idea without an external proxy: force the clean player type
//    at token-mint time, then strip any stitched ad blocks that still leak.
//
// Two layers:
//  1. GQL request rewrite (primary): any PlaybackAccessToken body gets
//     variables.playerType = "popout". Works for the page's token request
//     and for XHR transports.
//  2. Worker wrapper (fallback): Twitch's blob worker is re-created with a
//     tiny fetch hook that (a) re-mints a popout usher master if the page
//     hook was missed and (b) removes ad segment blocks from media playlists.
//     If the wrapper cannot be built, the original worker is used unchanged.
//
// 2026-10-20: ads can arrive as an **all-ad** preroll playlist or as a
// **mixed** midroll (e.g. 51 ad segments + 1 content segment). Stripping is
// not enough: the player may already have buffered the ad. We now cover the
// native player with a separate hls.js video fed by a freshly minted clean
// master (site/web HD when available, autoplay/android 360p otherwise), hide
// and mute the native video, and uncover it after two consecutive clean
// playlists + the ad DOM clears. `ALL_AD_FALLBACK` stays false: feeding the
// foreign MSE into Twitch's player left it permanently paused.
// `workerPlaylistLog`/`workerDebugLog` expose what the worker actually saw
// (BroadcastChannel, scoped by a per-page id) for future diagnosis.
(() => {
  if (window.__koTwitchAdblock) return;
  window.__koTwitchAdblock = true;

  const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
  const GQL_HASH = 'ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9';
  const GQL_URL = 'https://gql.twitch.tv/gql';
  const PLAYER_TYPE = 'popout'; // clean token type; "embed" is the ad-bearing one
  const stats = { rewrites: 0, workerHooks: 0, workerFailures: 0 };
  window.__koTwitchAdblockStats = stats;
  // BroadcastChannel is origin-wide, so two Twitch tabs would otherwise react
  // to each other's ad events. Every worker carries this page id.
  const pageId = Math.random().toString(36).slice(2, 10);
  stats.pageId = pageId;
  let bypassChannel = null;

  // Debug channel: the player worker cannot touch page globals, so it posts
  // a compact digest of every playlist it sees. This is how we tell stitched
  // SSAI (ad lines inside the m3u8) from client-side MSE (no ad lines at all).
  // Ring-buffered; expose via window.__koTwitchAdblockStats.workerPlaylistLog.
  try {
    const debugChannel = new BroadcastChannel('ko-adblock-debug');
    debugChannel.onmessage = (ev) => {
      const msg = ev && ev.data;
      if (!msg || typeof msg !== 'object' || msg.page !== pageId) return;
      if (msg.type === 'playlist') {
        if (!Array.isArray(stats.workerPlaylistLog)) stats.workerPlaylistLog = [];
        stats.workerPlaylistLog.push(msg);
        if (stats.workerPlaylistLog.length > 40) stats.workerPlaylistLog.shift();
        stats.lastWorkerPlaylist = msg;
        if (msg.adOnly) stats.adOnlySeen = (stats.adOnlySeen || 0) + 1;
        if (msg.changed === 'adOnly->fallback') stats.fallbacks = (stats.fallbacks || 0) + 1;
        return;
      }
      if (msg.type === 'debug') {
        if (!Array.isArray(stats.workerDebugLog)) stats.workerDebugLog = [];
        stats.workerDebugLog.push(msg);
        if (stats.workerDebugLog.length > 40) stats.workerDebugLog.shift();
        stats.lastWorkerDebug = msg;
        if (msg.step === 'probe.clean' && msg.detail) {
          stats.lastFallbackType = `${msg.detail.playerType}/${msg.detail.platform}`;
        }
      }
    };
  } catch {
    /* debug channel is optional */
  }

  // ---- clean HLS overlay for ad playlists ----------------------------------
  // SSAI ads (all-ad prerolls or mixed midrolls) cannot be fixed by handing
  // the web player a different token's playlist: its MSE rejects the clean
  // autoplay profile. hls.js CAN play that profile in a separate video. Cover
  // the Twitch player with the clean stream, mute/hide the native player, and
  // remove the overlay when the worker reports content again. This never
  // touches the player's own MSE.
  const bypassStats = { starts: 0, stops: 0, errors: 0, playing: 0, last: null };
  stats.adBypass = bypassStats;
  const overlay = {
    frame: null,
    token: null,
    url: null,
    channel: null,
    video: null,
    wasMuted: false,
    held: false,
    holdWasMuted: false,
    hiddenVideos: [],
    startedAt: 0,
    positionTimer: 0,
    timeoutTimer: 0,
    extTimer: 0,
    adEndTimer: 0,
    adEndTries: 0,
    ready: false,
    autoplayRetry: false,
    onMessage: null,
  };

  function mainVideo() {
    let best = null;
    let bestArea = 0;
    for (const v of document.querySelectorAll('video')) {
      try {
        const r = v.getBoundingClientRect();
        const area = Math.max(0, r.width) * Math.max(0, r.height);
        if (area > bestArea) {
          bestArea = area;
          best = v;
        }
      } catch {
        /* ignore */
      }
    }
    return best;
  }

  function positionOverlay() {
    if (!overlay.frame) return;
    const v = overlay.video && overlay.video.isConnected ? overlay.video : mainVideo();
    if (!v) return;
    let r;
    try {
      r = v.getBoundingClientRect();
    } catch {
      return;
    }
    if (!r || r.width < 40 || r.height < 40) {
      overlay.frame.style.display = 'none';
      return;
    }
    overlay.frame.style.display = 'block';
    // Put the frame INSIDE the player's stacking context. A body-level fixed
    // frame sat behind Twitch's video on channel pages; Chrome then treated it
    // as occluded and hls.js never loaded a segment (measured: rs=0, ns=2).
    const container = v.closest('[data-a-target="video-player"], .video-player, .video-player__container, .pbyp-player-instance');
    const host = document.fullscreenElement || container || document.body;
    if (overlay.frame.parentElement !== host) {
      try { host.appendChild(overlay.frame); } catch { /* ignore */ }
    }
    if (host === document.body) {
      overlay.frame.style.position = 'fixed';
      overlay.frame.style.left = `${Math.round(r.left)}px`;
      overlay.frame.style.top = `${Math.round(r.top)}px`;
      overlay.frame.style.width = `${Math.round(r.width)}px`;
      overlay.frame.style.height = `${Math.round(r.height)}px`;
      overlay.frame.style.right = 'auto';
      overlay.frame.style.bottom = 'auto';
    } else {
      // The host is the video's own container (or the fullscreen element);
      // filling it avoids coordinate/scroll drift and keeps the frame above
      // the native video in the same stacking context.
      overlay.frame.style.position = 'absolute';
      overlay.frame.style.left = '0';
      overlay.frame.style.top = '0';
      overlay.frame.style.width = '100%';
      overlay.frame.style.height = '100%';
      overlay.frame.style.right = 'auto';
      overlay.frame.style.bottom = 'auto';
    }
    hideNativeVideos(); // Twitch may recreate a video while the ad runs
  }

  function overlaySend(msg) {
    if (!overlay.frame || !overlay.token) return;
    try {
      overlay.frame.contentWindow.postMessage({ __koKick: { ...msg, _koToken: overlay.token } }, new URL(overlay.frame.src).origin);
    } catch {
      /* frame gone */
    }
  }

  function hideNativeVideos() {
    for (const v of document.querySelectorAll('video')) {
      if (overlay.hiddenVideos.some((x) => x.el === v)) continue;
      overlay.hiddenVideos.push({ el: v, visibility: v.style.visibility });
      try { v.style.visibility = 'hidden'; } catch { /* ignore */ }
    }
  }

  function restoreNativeVideos() {
    for (const { el, visibility } of overlay.hiddenVideos) {
      try {
        if (el.isConnected) el.style.visibility = visibility;
      } catch { /* ignore */ }
    }
    overlay.hiddenVideos = [];
  }

  function adUiPresent() {
    try {
      for (const e of document.querySelectorAll('[aria-label]')) {
        if (!/an.ncio|advert/i.test(e.getAttribute('aria-label') || '')) continue;
        if (e.getBoundingClientRect().width > 10 && e.getBoundingClientRect().height > 5) return true;
      }
      const sda = document.querySelector('[class*="stream-display-ad__wrapper"]:not([class*="hidden"])');
      if (sda) {
        const r = sda.getBoundingClientRect();
        if (r.width > 20 && r.height > 20) return true;
      }
    } catch {
      /* DOM can be mid-mutation */
    }
    return false;
  }

  function finishAdOverlay() {
    if (!overlay.frame) {
      stopAdOverlay('ad-end');
      return;
    }
    // The worker waits for clean playlists, but Twitch's ad chrome can linger
    // for a beat. Keep covering the native player until the ad UI is gone.
    if (overlay.adEndTries < 3 && adUiPresent()) {
      overlay.adEndTries++;
      overlay.adEndTimer = setTimeout(finishAdOverlay, 1000);
      return;
    }
    stopAdOverlay('ad-end');
  }

  function restoreHeldMute() {
    if (!overlay.held) return;
    const v = overlay.video && overlay.video.isConnected ? overlay.video : mainVideo();
    if (v) {
      try { v.muted = overlay.holdWasMuted; } catch { /* ignore */ }
    }
    restoreNativeVideos();
    overlay.held = false;
  }

  function stopAdOverlay(reason) {
    try { clearTimeout(overlay.extTimer); } catch { /* ignore */ }
    overlay.extTimer = 0;
    try { clearTimeout(overlay.adEndTimer); } catch { /* ignore */ }
    overlay.adEndTimer = 0;
    if (overlay.held) restoreHeldMute();
    if (!overlay.frame) return;
    try { clearInterval(overlay.positionTimer); } catch { /* ignore */ }
    try { clearTimeout(overlay.timeoutTimer); } catch { /* ignore */ }
    if (overlay.onMessage) window.removeEventListener('message', overlay.onMessage);
    try { overlay.frame.remove(); } catch { /* ignore */ }
    const v = overlay.video && overlay.video.isConnected ? overlay.video : mainVideo();
    if (v) {
      try { v.muted = overlay.wasMuted; } catch { /* ignore */ }
    }
    restoreNativeVideos();
    bypassStats.stops++;
    bypassStats.last = { type: 'stop', reason: String(reason || ''), at: Date.now() };
    overlay.frame = null;
    overlay.token = null;
    overlay.url = null;
    overlay.channel = null;
    overlay.video = null;
    overlay.ready = false;
    overlay.autoplayRetry = false;
    overlay.onMessage = null;
    // Tell the worker the overlay is gone so a timeout/player-error can retry
    // on a later ad playlist instead of leaving adBypassActive stuck true.
    try {
      if (bypassChannel) {
        bypassChannel.postMessage({ type: 'overlay-stop', page: pageId, reason: String(reason || '') });
      }
    } catch {
      /* overlay is optional */
    }
  }

  function startAdOverlay(url, channel) {
    if (!url) return;
    if (document.documentElement.getAttribute('data-ko-adblock') === '0') {
      stopAdOverlay('disabled');
      return;
    }
    if (!document.documentElement.getAttribute('data-ko-ext-id')) {
      // The isolated bridge sets this on its first storage callback. An ad
      // that starts in the first few hundred ms of a page load can beat it.
      if (!overlay.extTimer) {
        overlay.extTimer = setTimeout(() => {
          overlay.extTimer = 0;
          startAdOverlay(url, channel);
        }, 400);
      }
      return;
    }
    if (overlay.frame) {
      // A second ad event with a fresher URL: reload the same frame and cancel
      // any pending ad-end grace timer from the previous pod.
      try { clearTimeout(overlay.adEndTimer); } catch { /* ignore */ }
      overlay.adEndTimer = 0;
      overlay.adEndTries = 0;
      overlay.url = url;
      overlaySend({ t: 'load', url });
      return;
    }
    const v = mainVideo();
    if (!v) return;
    const extId = document.documentElement.getAttribute('data-ko-ext-id');
    const token = crypto.randomUUID();
    const frame = document.createElement('iframe');
    frame.id = 'ko-adfix';
    frame.dataset.koToken = token;
    frame.src = `chrome-extension://${extId}/player.html?m=hls&token=${encodeURIComponent(token)}`;
    frame.title = 'Clean Twitch stream (ad bypass)';
    frame.setAttribute('allow', 'autoplay; fullscreen; encrypted-media');
    frame.allowFullscreen = true;
    frame.style.cssText = 'position:fixed;z-index:2147483647;border:0;background:#000;';
    frame.addEventListener('load', () => {
      bypassStats.frameLoads = (bypassStats.frameLoads || 0) + 1;
    });
    frame.addEventListener('error', () => {
      bypassStats.frameErrors = (bypassStats.frameErrors || 0) + 1;
    });
    document.body.appendChild(frame);

    overlay.frame = frame;
    overlay.token = token;
    overlay.url = url;
    overlay.channel = channel || null;
    overlay.video = v;
    overlay.wasMuted = overlay.held ? overlay.holdWasMuted : v.muted;
    overlay.held = false;
    overlay.startedAt = Date.now();
    overlay.ready = false;
    overlay.autoplayRetry = false;
    overlay.adEndTries = 0;
    try { v.muted = true; } catch { /* ignore */ }
    // Concurrency fix (measured): with ANY native Twitch video visible,
    // Chrome/hls.js keeps the overlay at rs=0/ns=2 forever on channel pages.
    // The page has more than one <video> (main + PBP); hide them all. The
    // opaque iframe covers the same rect, so there is no visual difference.
    hideNativeVideos();

    overlay.onMessage = (ev) => {
      const m = ev.data && ev.data.__koKick;
      if (!m || ev.source !== overlay.frame?.contentWindow || m._koToken !== overlay.token) return;
      bypassStats.msgs = (bypassStats.msgs || 0) + 1;
      bypassStats.lastMsg = { t: m.t, state: m.st && m.st.state, st: m.st || null, at: Date.now() };
      if (m.t === 'ready') {
        overlay.ready = true;
        overlaySend({ t: 'load', url: overlay.url });
        overlaySend({ t: 'mute', m: false });
        overlaySend({ t: 'play' });
        return;
      }
      if (m.t === 'ev' && m.e === 'hls') {
        bypassStats.lastHls = { d: m.d, fatal: m.fatal, url: m.url, at: Date.now() };
        if (m.fatal) bypassStats.errors++;
        return;
      }
      if (m.t === 'ev' && m.e === 'error') {
        bypassStats.errors++;
        stopAdOverlay('player-error');
        return;
      }
      if (m.t === 'st' && m.st) {
        if (m.st.state === 'Playing') {
          bypassStats.playing++;
          if (bypassStats.last?.type !== 'playing') {
            bypassStats.last = { type: 'playing', q: m.st.q, at: Date.now() };
          }
        } else if (!overlay.autoplayRetry && Date.now() - overlay.startedAt > 2500 && Date.now() - overlay.startedAt < 9000 && m.st.paused) {
          // Autoplay-with-audio was blocked. Retry muted; native controls let
          // the user unmute without losing the clean video.
          overlay.autoplayRetry = true;
          overlaySend({ t: 'mute', m: true });
          overlaySend({ t: 'play' });
        }
      }
    };
    window.addEventListener('message', overlay.onMessage);

    positionOverlay();
    overlay.positionTimer = setInterval(positionOverlay, 500);
    // Safety net if Twitch stops requesting playlists while its <video> is
    // hidden; a normal preroll/midroll is well under a minute.
    overlay.timeoutTimer = setTimeout(() => stopAdOverlay('timeout'), 60 * 1000);
    bypassStats.starts++;
    bypassStats.last = { type: 'start', channel: overlay.channel, at: Date.now() };
    // The bridge may already be listening; the 'ready' handler covers a slow
    // iframe. Sending here too avoids a race on warm starts.
    setTimeout(() => {
      if (!overlay.frame) return;
      overlaySend({ t: 'load', url: overlay.url });
      overlaySend({ t: 'mute', m: false });
      overlaySend({ t: 'play' });
    }, 400);
  }

  try {
    bypassChannel = new BroadcastChannel('ko-adblock-bypass');
    bypassChannel.onmessage = (ev) => {
      const msg = ev && ev.data;
      if (!msg || typeof msg !== 'object' || msg.page !== pageId) return;
      if (document.documentElement.getAttribute('data-ko-adblock') === '0') {
        stopAdOverlay('disabled');
        return;
      }
      if (msg.type === 'ad-hold') {
        if (overlay.frame) {
          try { clearTimeout(overlay.adEndTimer); } catch { /* ignore */ }
          overlay.adEndTimer = 0;
          overlay.adEndTries = 0;
          return;
        }
        if (overlay.held) return;
        const v = mainVideo();
        if (!v) return;
        overlay.held = true;
        overlay.holdWasMuted = v.muted;
        try { v.muted = true; } catch { /* ignore */ }
        hideNativeVideos();
        return;
      }
      if (msg.type === 'ad-start') {
        startAdOverlay(msg.url, msg.channel);
        return;
      }
      if (msg.type === 'ad-end') {
        finishAdOverlay();
        return;
      }
      if (msg.type === 'ad-fail') {
        stopAdOverlay('ad-fail');
      }
    };
  } catch {
    /* overlay is optional */
  }

  // The ISOLATED bridge (adblock-bridge.js) mirrors the user's toggle into
  // this attribute at document_start. Absent attribute = default ON.
  const isOn = () => {
    try {
      return (document.documentElement && document.documentElement.getAttribute('data-ko-adblock') !== '0');
    } catch {
      return true;
    }
  };

  function rewriteTokenBody(body) {
    if (typeof body !== 'string' || body.length < 8) return body;
    if (!body.includes('PlaybackAccessToken') && !body.includes('playerType')) return body;
    try {
      const parsed = JSON.parse(body);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      let changed = false;
      for (const item of items) {
        const v = item && item.variables;
        if (!v || typeof v !== 'object') continue;
        // Some token calls omit playerType entirely; a live/VOD request with
        // no type must be forced to popout too, otherwise Twitch defaults to
        // the ad-bearing site player.
        if (typeof v.playerType !== 'string') {
          if (v.isLive !== true || v.isVod === true) continue;
        }
        const before = v.playerType;
        v.playerType = PLAYER_TYPE;
        if (typeof v.platform === 'string') v.platform = 'web';
        stats.lastPlayerType = { before: before || '(none)', after: PLAYER_TYPE };
        if (before === 'picture-by-picture') stats.pbpRewrites = (stats.pbpRewrites || 0) + 1;
        changed = true;
      }
      if (!changed) return body;
      stats.rewrites++;
      return JSON.stringify(parsed);
    } catch {
      return body;
    }
  }

  // ---- layer 1: page fetch / XHR token rewrite -----------------------------
  try {
    const realFetch = window.fetch;
    if (typeof realFetch === 'function') {
      window.fetch = function (input, init) {
        try {
          if (!isOn()) return realFetch.apply(this, arguments);
          const url = typeof input === 'string' ? input : (input && input.url) || '';
          if (url.includes('gql.twitch.tv/gql') && init && typeof init.body === 'string') {
            const next = rewriteTokenBody(init.body);
            if (next !== init.body) init = { ...init, body: next };
          }
        } catch {
          /* never break a page request */
        }
        // MUST forward the possibly-rewritten `init`. The old code used
        // `arguments`, so the playout token body stayed ad-bearing even
        // though stats.rewrites incremented — the exact failure that let a
        // midroll through.
        return realFetch.call(this, input, init);
      };
    }
  } catch {
    /* best-effort */
  }

  try {
    const xhrOpen = XMLHttpRequest.prototype.open;
    const xhrSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      try {
        this.__koUrl = String(url);
      } catch {
        /* ignore */
      }
      return xhrOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
      try {
        if (isOn() && String(this.__koUrl || '').includes('gql.twitch.tv/gql')) {
          const next = rewriteTokenBody(body);
          if (next !== body) arguments[0] = next;
        }
      } catch {
        /* ignore */
      }
      return xhrSend.apply(this, arguments);
    };
  } catch {
    /* best-effort */
  }

  // ---- layer 2: blob-worker HLS hook ---------------------------------------
  // Self-contained function serialized into the replacement worker.
  function workerMain() {
    const workerId = Math.random().toString(36).slice(2, 6);
    // Legacy playlist-swap code is kept but disabled: the clean autoplay
    // variant uses an MSE profile Twitch's web player cannot append, so
    // swapping left the player permanently paused. 0.8.15 uses the separate
    // hls.js overlay instead (see the page-side code above).
    const ALL_AD_FALLBACK = false;
    const realFetch = self.fetch.bind(self);
    const cleanCache = new Map();
    const mediaFallbackCache = new Map();
    let lastChannel = null;
    let lastMaster = null;
    let debugChannel = null;
    let bypassChannel = null;
    try {
      debugChannel = new BroadcastChannel('ko-adblock-debug');
    } catch {
      debugChannel = null;
    }
    try {
      bypassChannel = new BroadcastChannel('ko-adblock-bypass');
    } catch {
      bypassChannel = null;
    }

    function postBypass(msg) {
      if (!bypassChannel) return;
      try {
        bypassChannel.postMessage({
          ...msg,
          at: Date.now(),
          worker: workerId,
          page: typeof __KO_PAGE_ID !== 'undefined' ? __KO_PAGE_ID : '',
        });
      } catch {
        /* overlay is optional */
      }
    }

    if (bypassChannel) {
      bypassChannel.onmessage = (ev) => {
        const msg = ev && ev.data;
        if (!msg || typeof msg !== 'object') return;
        if (typeof __KO_PAGE_ID !== 'undefined' && msg.page !== __KO_PAGE_ID) return;
        if (msg.type === 'overlay-stop') {
          adBypassActive = false;
          cleanPlaylistStreak = 0;
          debugLog('bypass.overlayStop', { reason: String(msg.reason || '').slice(0, 60) });
        }
      };
    }

    function debugLog(step, detail) {      if (!debugChannel) return;
      try {
        debugChannel.postMessage({
          type: 'debug',
          at: Date.now(),
          worker: workerId,
          page: typeof __KO_PAGE_ID !== 'undefined' ? __KO_PAGE_ID : '',
          step,
          detail: detail || null,
        });
      } catch {
        /* diagnostics only */
      }
    }

    function playlistInfo(text) {
      const lines = String(text || '').replace(/\r/g, '').split('\n');
      const extinf = lines.filter((l) => l.startsWith('#EXTINF'));
      const adExtinf = extinf.filter((l) => !/,live\s*$/.test(l));
      return {
        lines,
        extinf: extinf.length,
        adExtinf: adExtinf.length,
        adOnly: extinf.length > 0 && adExtinf.length === extinf.length,
        hasStitched: /stitched|X-TV-TWITCH-AD-URL|twitch-stitched-ad/i.test(text),
        adExtinfSamples: adExtinf.slice(0, 3).map((l) => l.slice(0, 160)),
      };
    }

    function digestPlaylist(url, text, changed) {
      if (!debugChannel || typeof text !== 'string') return;
      try {
        const info = playlistInfo(text);
        debugChannel.postMessage({
          type: 'playlist',
          at: Date.now(),
          worker: workerId,
          page: typeof __KO_PAGE_ID !== 'undefined' ? __KO_PAGE_ID : '',
          url: String(url || '').slice(0, 300),
          len: text.length,
          extinf: info.extinf,
          adExtinf: info.adExtinf,
          adExtinfSamples: info.adExtinfSamples,
          hasStitched: info.hasStitched,
          adOnly: info.adOnly,
          changed: changed || false,
          sample: text.slice(0, 1200),
        });
      } catch {
        /* diagnostics only */
      }
    }

    function contentCount(text) {
      const info = playlistInfo(text);
      return info.extinf - info.adExtinf;
    }

    function parseVariants(masterText) {
      const lines = String(masterText || '').replace(/\r/g, '').split('\n');
      const urls = [];
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
        // Audio-only renditions have no RESOLUTION. Feeding one to the video
        // player makes a clean-but-black stream, so skip them.
        if (!/RESOLUTION=/.test(lines[i])) continue;
        for (let j = i + 1; j < lines.length; j++) {
          const line = lines[j].trim();
          if (!line) continue;
          if (line.startsWith('#')) break;
          urls.push(line);
          break;
        }
      }
      return urls;
    }

    async function mintMasterUrl(channel, playerType, platform) {
      const device = Array.from({ length: 32 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('');
      const body = {
        operationName: 'PlaybackAccessToken',
        variables: { isLive: true, login: channel, isVod: false, vodID: '', playerType, platform },
        extensions: { persistedQuery: { version: 1, sha256Hash: __KO_GQL_HASH } },
      };
      const gr = await realFetch(__KO_GQL_URL, {
        method: 'POST',
        credentials: 'omit',
        headers: {
          'Client-ID': __KO_CLIENT_ID,
          'X-Device-Id': device,
          'Content-Type': 'text/plain;charset=UTF-8',
        },
        body: JSON.stringify(body),
      });
      if (!gr.ok) return null;
      const gj = await gr.json();
      const token = gj && gj.data && gj.data.streamPlaybackAccessToken;
      if (!token || !token.value || !token.signature) return null;
      const u = new URL(`https://usher.ttvnw.net/api/v2/channel/hls/${encodeURIComponent(channel)}.m3u8`);
      u.searchParams.set('sig', token.signature);
      u.searchParams.set('token', token.value);
      u.searchParams.set('allow_source', 'true');
      u.searchParams.set('allow_audio_only', 'true');
      u.searchParams.set('p', String(Math.floor(Math.random() * 9000000) + 1000000));
      u.searchParams.set('player', 'twitchweb');
      u.searchParams.set('type', 'any');
      return u.toString();
    }

    async function mintMaster(channel, playerType, platform) {
      const url = await mintMasterUrl(channel, playerType, platform);
      if (!url) return null;
      const mr = await realFetch(url, { credentials: 'omit' });
      if (!mr.ok) return null;
      return await mr.text();
    }

    // Find a master whose first two video renditions have NO stitched ads.
    // autoplay/android is the measured clean type during a preroll; its 360p
    // MSE is playable by hls.js (the web player's own MSE rejects it). Keep
    // the list short: this runs during a live ad and delays the overlay.
    async function findCleanHlsUrl(channel) {
      // Prefer the web container (HD) and fall back to autoplay/android
      // (clean during the measured preroll, but only 160p/360p). Probe one
      // video rendition per type: this runs while the ad is on screen, so
      // latency matters more than exhaustive coverage.
      const types = [
        ['site', 'web'],
        ['popout', 'web'],
        ['mobile', 'android'],
        ['autoplay', 'android'],
      ];
      for (const [playerType, platform] of types) {
        try {
          const url = await mintMasterUrl(channel, playerType, platform);
          if (!url) continue;
          const mr = await realFetch(url, { credentials: 'omit' });
          if (!mr.ok) continue;
          const master = await mr.text();
          const variants = parseVariants(master);
          for (const variant of variants.slice(0, 1)) {
            let variantUrl = variant;
            try { variantUrl = new URL(variant, url).toString(); } catch { /* keep raw */ }
            const vr = await realFetch(variantUrl, { credentials: 'omit' });
            if (!vr.ok) continue;
            const text = await vr.text();
            const info = playlistInfo(text);
            debugLog('bypass.probe', {
              playerType,
              platform,
              extinf: info.extinf,
              adExtinf: info.adExtinf,
              adOnly: info.adOnly,
            });
            if (info.extinf > 0 && info.adExtinf === 0) return url;
          }
        } catch (e) {
          debugLog('bypass.probeError', { playerType, platform, error: String(e).slice(0, 160) });
        }
      }
      return null;
    }

    // The player can be handed an ad-only media playlist (all #EXTINF lines
    // lack ",live"; measured preroll: 3-4 x "#EXTINF:2.0,Amazon|..."). The
    // clean master minted with popout can itself be in an ad window, so try
    // other token types and only adopt one that actually has content segments.
    let fallbackAttemptAt = 0;
    let adBypassActive = false;
    let bypassBusy = false;
    let lastBypassAt = 0;
    let cleanPlaylistStreak = 0;

    async function maybeStartBypass() {
      if (!lastChannel || bypassBusy) return;
      if (Date.now() - lastBypassAt < 15000) return;
      bypassBusy = true;
      lastBypassAt = Date.now();
      postBypass({ type: 'ad-hold', channel: lastChannel });
      try {
        const url = await findCleanHlsUrl(lastChannel);
        if (url) {
          adBypassActive = true;
          postBypass({ type: 'ad-start', channel: lastChannel, url });
        } else {
          postBypass({ type: 'ad-fail', channel: lastChannel });
        }
      } catch (e) {
        debugLog('bypass.startError', { error: String(e).slice(0, 200) });
        postBypass({ type: 'ad-fail', channel: lastChannel });
      } finally {
        bypassBusy = false;
      }
    }

    async function cleanMediaFallback() {
      if (!lastChannel) {
        debugLog('fallback.noChannel', null);
        return null;
      }
      const cached = mediaFallbackCache.get(lastChannel);
      if (cached && Date.now() - cached.at < 8000 && contentCount(cached.text) > 0) return cached.text;
      if (Date.now() - fallbackAttemptAt < 10000) return null;
      fallbackAttemptAt = Date.now();
      const types = [
        // Prefer web-container types: autoplay/android is ad-free but its MSE
        // output does not play in the web player (paused at readyState 1).
        ['site', 'web'],
        ['site', 'android'],
        ['mobile', 'web'],
        ['mobile', 'android'],
        ['android', 'web'],
        ['android', 'android'],
        ['autoplay', 'web'],
        ['autoplay', 'android'],
      ];
      for (const [playerType, platform] of types) {
        try {
          const master = await mintMaster(lastChannel, playerType, platform);
          if (!master) {
            debugLog('probe.masterFail', { playerType, platform });
            continue;
          }
          const variants = parseVariants(master);
          debugLog('probe.master', { playerType, platform, variants: variants.length });
          for (const variant of variants.slice(0, 2)) {
            const r = await realFetch(variant, { credentials: 'omit' });
            if (!r.ok) continue;
            const text = await r.text();
            const clean = stripAds(text);
            const content = contentCount(clean);
            const info = playlistInfo(text);
            debugLog('probe.media', {
              playerType,
              platform,
              len: text.length,
              content,
              extinf: info.extinf,
              adExtinf: info.adExtinf,
              adOnly: info.adOnly,
              hasStitched: info.hasStitched,
            });
            if (content > 0) {
              mediaFallbackCache.set(lastChannel, { text: clean, at: Date.now() });
              digestPlaylist(lastChannel + ' [mediaFallback]', clean, 'fallback');
              debugLog('probe.clean', { playerType, platform, content });
              return clean;
            }
          }
        } catch (e) {
          debugLog('probe.error', { playerType, platform, error: String(e).slice(0, 200) });
        }
      }
      debugLog('probe.fail', { channel: lastChannel });
      return null;
    }

    function stripAds(text) {
      if (!/stitched|X-TV-TWITCH-AD-URL|twitch-stitched-ad/i.test(text)) return text;
      const lines = text.replace(/\r/g, '').split('\n');
      const out = [];
      let skipUri = false;
      let removed = false;
      for (const line of lines) {
        if (skipUri) {
          // The segment URI (and an optional byte-range tag) belongs to the
          // ad EXTINF just removed.
          if (line.startsWith('#EXT-X-BYTERANGE')) continue;
          if (line.startsWith('#')) continue;
          skipUri = false;
          removed = true;
          continue;
        }
        if (line.startsWith('#EXTINF')) {
          // Twitch marks content segments ",live"; stitched ad segments do
          // not carry that marker.
          if (!/,live\s*$/.test(line)) {
            skipUri = true;
            removed = true;
            continue;
          }
          out.push(line);
          continue;
        }
        if (line.startsWith('#EXT-X-DATERANGE') && /twitch-stitched-ad|X-TV-TWITCH-AD-URL/i.test(line)) {
          removed = true;
          continue;
        }
        if (line.startsWith('#EXT-X-TWITCH-PREFETCH')) {
          removed = true;
          continue;
        }
        out.push(
          line
            .replace(/X-TV-TWITCH-AD-URL="[^"]*"/g, 'X-TV-TWITCH-AD-URL="https://twitch.tv"')
            .replace(/X-TV-TWITCH-AD-CLICK-TRACKING-URL="[^"]*"/g, 'X-TV-TWITCH-AD-CLICK-TRACKING-URL="https://twitch.tv"'),
        );
      }
      // All-ad playlist: keep the original instead of handing the player an
      // empty list (it would stall/black-screen).
      if (!removed || !out.some((l) => l.startsWith('#EXTINF'))) return text;
      return out.join('\n');
    }

    async function cleanMaster(url) {
      const m = url.match(/\/channel\/hls\/([^/?#]+)\.m3u8/);
      if (!m) {
        debugLog('cleanMaster.nochannel', { url: String(url).slice(0, 200) });
        return null;
      }
      const channel = decodeURIComponent(m[1]);
      lastChannel = channel;
      const incoming = tokenInfo(url);
      debugLog('cleanMaster.start', { channel, token: incoming });
      // The page hook already rewrote this master to the clean popout type.
      // Do not mint a second master here: the extra GQL/usher round-trip and
      // the replacement master made the player rebuffer when it re-requested
      // the master on fullscreen/quality changes.
      if (incoming && incoming.player_type === __KO_PLAYER_TYPE && incoming.platform === 'web') {
        debugLog('cleanMaster.skipCleanToken', { channel, playerType: incoming.player_type, platform: incoming.platform });
        return null;
      }
      const cached = cleanCache.get(channel);
      if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.text;
      try {
        // Keep the normal web container. autoplay/android has clean media
        // playlists during an ad, but its MSE output is not playable in the
        // web player (video stays paused at readyState 1), so it is only a
        // last-resort source and must not replace the main master.
        const text = await mintMaster(channel, __KO_PLAYER_TYPE, 'web');
        if (!text) {
          debugLog('cleanMaster.fail', { channel });
          return null;
        }
        lastChannel = channel;
        lastMaster = text;
        debugLog('cleanMaster.ok', {
          channel,
          len: text.length,
          variants: parseVariants(text).length,
          playerType: __KO_PLAYER_TYPE,
          platform: 'web',
        });
        digestPlaylist(url + ' [cleanMaster]', text, false);
        cleanCache.set(channel, { text, at: Date.now() });
        return text;
      } catch (e) {
        debugLog('cleanMaster.error', { channel, error: String(e).slice(0, 300) });
        return null;
      }
    }

    function tokenInfo(url) {
      try {
        const raw = new URL(url).searchParams.get('token');
        if (!raw) return null;
        // Twitch's usher `token` is URL-encoded JSON today, not base64. Try
        // both so this keeps working if the encoding changes.
        let t = null;
        try {
          t = JSON.parse(raw);
        } catch {
          const b = raw.replace(/-/g, '+').replace(/_/g, '/');
          t = JSON.parse(atob(b + '='.repeat((4 - (b.length % 4)) % 4)));
        }
        if (!t) return null;
        return {
          player_type: t.player_type,
          platform: t.platform,
          show_ads: t.show_ads,
          server_ads: t.server_ads,
          hide_ads: t.hide_ads,
          adblock: t.adblock,
          user_id: t.user_id,
          channel: t.channel,
        };
      } catch {
        return null;
      }
    }

    self.fetch = async function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      try {
        // Clean picture-by-picture masters too. Twitch's 2025 SDA ads can
        // arrive on that player type; skipping them let a PBP master through
        // even though the page token itself had been rewritten to popout.
        if (typeof url === 'string' && url.includes('/channel/hls/')) {
          try {
            const cm = url.match(/\/channel\/hls\/([^/?#]+)\.m3u8/);
            if (cm) lastChannel = decodeURIComponent(cm[1]);
          } catch {
            /* ignore */
          }
          let tokenRaw = null;
          try { tokenRaw = new URL(url).searchParams.get('token'); } catch {}
          debugLog('master.request', {
            token: tokenInfo(url),
            tokenLen: tokenRaw ? tokenRaw.length : 0,
            tokenHead: tokenRaw ? tokenRaw.slice(0, 24) : null,
          });
          const text = await cleanMaster(url);
          if (text) {
            return new Response(text, {
              status: 200,
              headers: { 'Content-Type': 'application/vnd.apple.mpegurl', 'Access-Control-Allow-Origin': '*' },
            });
          }
        }
      } catch {
        /* fall through to the original response */
      }
      const response = await realFetch(input, init);
      try {
        if (
          response &&
          response.ok &&
          typeof url === 'string' &&
          (url.includes('/playlist/') || /\.m3u8(?:[?#]|$)/.test(url))
        ) {
          const text = await response.clone().text();
          const info = playlistInfo(text);
          const clean = stripAds(text);
          if (info.extinf > 0) {
            if (info.adExtinf > 0) {
              // Any stitched ad, not just an all-ad preroll. A midroll can be
              // mixed (e.g. 51 ad segments + 1 content segment in the same
              // refreshed playlist), and the player may already have buffered
              // the ad by the time stripAds() sees it. Cover the native player
              // with the clean hls.js stream immediately; stripAds() still
              // removes future ad segments from the native playlist.
              cleanPlaylistStreak = 0;
              if (!adBypassActive && !bypassBusy) maybeStartBypass();
            } else if (adBypassActive) {
              // One clean playlist can still sit next to buffered ad media.
              // Require two consecutive clean refreshes before uncovering the
              // native player, so a midroll tail is not shown.
              cleanPlaylistStreak++;
              if (cleanPlaylistStreak >= 2) {
                adBypassActive = false;
                cleanPlaylistStreak = 0;
                postBypass({ type: 'ad-end', channel: lastChannel });
              }
            } else {
              cleanPlaylistStreak = 0;
            }
          }
          // All-ad preroll/master window: there is no content segment to keep.
          // Swap in a live media playlist from the clean master instead of
          // letting the player play the ad-only list.
          if (ALL_AD_FALLBACK && info.adOnly) {
            const fallback = await cleanMediaFallback();
            if (fallback) {
              digestPlaylist(url, text, 'adOnly->fallback');
              return new Response(fallback, {
                status: 200,
                headers: { 'Content-Type': 'application/vnd.apple.mpegurl', 'Access-Control-Allow-Origin': '*' },
              });
            }
          }
          digestPlaylist(url, text, clean !== text);
          if (clean !== text) {
            // Only Content-Type: copying content-encoding/length from the
            // already-decoded body makes the consumer misread it.
            return new Response(clean, {
              status: 200,
              headers: { 'Content-Type': 'application/vnd.apple.mpegurl', 'Access-Control-Allow-Origin': '*' },
            });
          }
        }
      } catch {
        /* keep the original response */
      }
      return response;
    };
  }

  try {
    const NativeWorker = window.Worker;
    if (typeof NativeWorker === 'function') {
      window.Worker = class KoAdblockWorker extends NativeWorker {
        constructor(url, options) {
          const src = String(url);
          if (!isOn()) {
            super(url, options);
            return;
          }
          if (!/^blob:https:\/\/(?:www\.)?twitch\.tv\//.test(src)) {
            super(url, options);
            return;
          }
          let code = '';
          try {
            const x = new XMLHttpRequest();
            x.open('GET', src, false);
            x.overrideMimeType('text/javascript');
            x.send();
            code = x.responseText || '';
          } catch {
            stats.workerFailures++;
          }
          if (!code) {
            super(url, options);
            return;
          }
          try {
            const prelude =
              'const __KO_CLIENT_ID=' + JSON.stringify(CLIENT_ID) + ';' +
              'const __KO_GQL_HASH=' + JSON.stringify(GQL_HASH) + ';' +
              'const __KO_GQL_URL=' + JSON.stringify(GQL_URL) + ';' +
              'const __KO_PLAYER_TYPE=' + JSON.stringify(PLAYER_TYPE) + ';' +
              'const __KO_PAGE_ID=' + JSON.stringify(pageId) + ';';
            const blob = new Blob([prelude + '(' + workerMain.toString() + ')();\n' + code], {
              type: 'text/javascript',
            });
            super(URL.createObjectURL(blob), options);
            stats.workerHooks++;
          } catch {
            stats.workerFailures++;
            super(url, options);
          }
        }
      };
    }
  } catch {
    /* worker hook is optional — the GQL rewrite remains active */
  }
})();
