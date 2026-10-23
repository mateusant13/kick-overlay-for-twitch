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
  // 0.8.18: platform is configurable so a clean-during-ad platform (from the
  // ad-matrix probe) can be adopted without touching the native player.
  const CLEAN_PLATFORM = 'web';
  const stats = { rewrites: 0, workerHooks: 0, workerFailures: 0 };
  window.__koTwitchAdblockStats = stats;
  // BroadcastChannel is origin-wide, so two Twitch tabs would otherwise react
  // to each other's ad events. Every worker carries this page id.
  const pageId = Math.random().toString(36).slice(2, 10);
  stats.pageId = pageId;
  let bypassChannel = null;

  // Persistent event log. The ISOLATED bridge (adblock-bridge.js) listens for
  // this DOM event and appends to chrome.storage.local['ko.adlog'] (ring
  // buffer, 500 events). Unlike console/stats, this survives a page refresh:
  // if an ad appears after a reload, the timestamps are still there next time.
  // `ms` is relative to navigation start, so content->ad delay can be read
  // directly from the log without correlating clocks.
  function adLog(ev, detail) {
    const d = Object.assign({ ms: Math.round(performance.now()) }, detail || {});
    stats.adLogCount = (stats.adLogCount || 0) + 1;
    stats.lastAdLog = { ev, d };
    try {
      document.dispatchEvent(new CustomEvent('ko-adlog', { detail: JSON.stringify({ ev, d }) }));
    } catch {
      /* bridge may not be ready very early */
    }
  }
  adLog('script-start', { href: location.href });

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
        if (msg.adOnly || msg.adExtinf > 0 || msg.changed) {
          adLog('worker-playlist', {
            extinf: msg.extinf,
            adExtinf: msg.adExtinf,
            adOnly: !!msg.adOnly,
            hasStitched: !!msg.hasStitched,
            changed: msg.changed || null,
            url: String(msg.url || '').slice(0, 180),
          });
        }
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
        // Keep the durable log small: only decisions, not every probe.
        if (/^(bypass|prewarm)\./.test(String(msg.step || ''))) {
          adLog('worker-debug', { step: msg.step, detail: msg.detail || null });
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
  // 0.8.20 fallback ladder: the proxy is still the best path (native HD), but
  // when an ad is already stitched the client can still avoid showing it by
  // covering the native player with a separate hls.js video fed by a clean
  // lower-quality stream. This is deliberately a worse experience (reduced
  // quality, no Twitch controls during the break) but it keeps the live
  // visible and never lets the ad play. The native player is restored after
  // two clean playlists.
  const AD_OVERLAY_ENABLED = true;
  // Hybrid: on the first ad signal, jump the native player back this many
  // seconds. 5s = the user's observed ~4s content grace + 1s safety. The real
  // value is measured from ko.adlog (`ad-rewind` / `content-play`); this is
  // only the starting point.
  const AD_REWIND_SEC = 5;
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
    playing: false,
    switchTries: 0,
    watchdogTimer: 0,
    badge: null,
    unmuteHandler: null,
    onMessage: null,
    // Hybrid ad handling: on the first ad signal, rewind the native player a
    // few seconds so it replays already-buffered content while the clean
    // overlay starts. The overlay stays transparent and the native stays
    // visible until the overlay actually reports Playing (or the fallback
    // timer fires), which avoids the black frame.
    rewound: false,
    revealed: false,
    nativeHidden: false,
    hideTimer: 0,
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

  // Rewind live by a few seconds so the native player replays already-buffered
  // content instead of immediately reaching the stitched ad. Twitch's live
  // video reports duration=Infinity but currentTime is seekable in the DVR
  // window; seekable.start(0) is 0, so `currentTime - seconds` is the target.
  function rewindNative(seconds) {
    const v = mainVideo();
    if (!v) return null;
    if (v.paused || v.readyState < 2) return { skipped: 'not-playing', rs: v.readyState, paused: v.paused };
    const before = v.currentTime;
    let target = before - seconds;
    try {
      const s = v.seekable;
      if (s && s.length) {
        const start = s.start(0);
        if (Number.isFinite(start)) target = Math.max(start, target);
      }
    } catch {
      /* fall back to before-seconds */
    }
    if (!(target < before - 0.5)) return { skipped: 'no-window', before: +before.toFixed(2), target: +target.toFixed(2) };
    try {
      v.currentTime = target;
      return { before: +before.toFixed(2), target: +target.toFixed(2), delta: +(before - target).toFixed(2) };
    } catch {
      return { skipped: 'seek-failed', before: +before.toFixed(2), target: +target.toFixed(2) };
    }
  }
  stats.rewindNative = rewindNative;
  // Diagnostic only: start the clean overlay against an arbitrary HLS URL so
  // the surface-swap (native visible -> firstframe -> hide native) can be
  // tested without waiting for a real ad. Not used by the ad path.
  stats.testOverlay = (url) => startAdOverlay(url, 'test', false);

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
      if (overlay.badge) overlay.badge.style.display = 'none';
      return;
    }
    overlay.frame.style.display = 'block';
    if (overlay.badge) {
      // Keep the badge hidden while the native player is still the visible
      // surface; it appears together with the clean player.
      overlay.badge.style.display = overlay.revealed ? 'block' : 'none';
      overlay.badge.style.left = `${Math.round(r.left) + 12}px`;
      overlay.badge.style.top = `${Math.round(r.top) + 12}px`;
    }
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
    // Hide native videos only after the clean player has been revealed; while
    // it is transparent the native player is the visible surface. After the
    // reveal, keep hiding any video Twitch recreates during the ad.
    if (overlay.revealed) hideNativeVideos();
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
      overlay.hiddenVideos.push({ el: v, visibility: v.style.visibility, muted: v.muted });
      try { v.style.visibility = 'hidden'; } catch { /* ignore */ }
      // Mute every native video, not just the main one: a PBP/ad video can
      // keep playing audio behind the opaque overlay.
      try { v.muted = true; } catch { /* ignore */ }
    }
  }

  function restoreNativeVideos() {
    for (const { el, visibility, muted } of overlay.hiddenVideos) {
      try {
        if (el.isConnected) {
          el.style.visibility = visibility;
          if (typeof muted === 'boolean') el.muted = muted;
        }
      } catch { /* ignore */ }
    }
    overlay.hiddenVideos = [];
  }

  // Real ad chrome only. The old any-aria-label match treated Twitch's
  // "Experimenta 1 mês sem anúncios" promo button (32x32) as an ad, which
  // logged fake ad-ui-on events and could delay uncovering the native player.
  function adUiDetail() {
    try {
      // Twitch can keep a hidden squeezeback wrapper before the visible ad
      // wrapper; querySelector() would only ever see the hidden one.
      for (const sda of document.querySelectorAll('[class*="stream-display-ad__wrapper"]')) {
        const r = sda.getBoundingClientRect();
        const cls = String(sda.className || '');
        if (r.width > 20 && r.height > 20 && !/hidden/i.test(cls)) {
          return { kind: 'wrapper', w: Math.round(r.width), h: Math.round(r.height) };
        }
      }
      // Twitch's real countdown is like "Anúncio (0:12)" /
      // "Advertisement (0:15)". Require the numeric part so plain labels and
      // promo buttons cannot match.
      for (const e of document.querySelectorAll('[aria-label]')) {
        const label = e.getAttribute('aria-label') || '';
        if (!/an.ncio|advert/i.test(label)) continue;
        if (/sem\s+an.ncios|without\s+ads?|no\s+ads?|ad-?free|remove\s+ads?|experimenta|teste|try\s+1/i.test(label)) continue;
        if (!/\(\s*\d|\d+\s*(s|seg|segundos?|seconds?)\b/i.test(label)) continue;
        const r = e.getBoundingClientRect();
        if (r.width > 10 && r.height > 5) {
          return { kind: 'aria', label: label.slice(0, 120), w: Math.round(r.width), h: Math.round(r.height) };
        }
      }
    } catch {
      /* DOM can be mid-mutation */
    }
    return null;
  }

  function adUiPresent() {
    return !!adUiDetail();
  }
  // Exposed for diagnostics/tests only; not used by the ad path.
  stats.adUiDetail = adUiDetail;

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
    // Restore visibility/first, then apply the pre-hold mute state. Doing it
    // the other way round lets a stored `muted:true` (captured after ad-hold)
    // overwrite the real original state.
    restoreNativeVideos();
    if (v) {
      try { v.muted = overlay.holdWasMuted; } catch { /* ignore */ }
    }
    overlay.held = false;
  }

  // Hiding the native video does not normally pause it, but Twitch may pause
  // when the element is occluded, and on a cold preroll the native was never
  // playing at all. Retry the resume a few times, then click Twitch's own
  // play button as a last resort (measured in the background Edge run: the
  // native stayed paused after ad-end).
  function resumeNative(v, tag) {
    if (!v || !v.isConnected) return;
    try {
      if (v.paused) {
        const p = v.play();
        if (p && p.catch) p.catch(() => {});
      }
    } catch {
      /* ignore */
    }
    adLog('native-resume', {
      tag,
      paused: v.paused,
      ct: +v.currentTime.toFixed(1),
      rs: v.readyState,
    });
  }

  function stopAdOverlay(reason) {
    try { clearTimeout(overlay.extTimer); } catch { /* ignore */ }
    overlay.extTimer = 0;
    try { clearTimeout(overlay.adEndTimer); } catch { /* ignore */ }
    overlay.adEndTimer = 0;
    try { clearTimeout(overlay.watchdogTimer); } catch { /* ignore */ }
    overlay.watchdogTimer = 0;
    if (overlay.hideTimer) {
      try { clearTimeout(overlay.hideTimer); } catch { /* ignore */ }
      overlay.hideTimer = 0;
    }
    if (overlay.held) restoreHeldMute();
    if (!overlay.frame) {
      // Even without a frame, a badge/unmute handler can be left over from a
      // source switch that failed between teardown and rebuild.
      if (overlay.badge) { try { overlay.badge.remove(); } catch { /* ignore */ } overlay.badge = null; }
      if (overlay.unmuteHandler) {
        try { document.removeEventListener('pointerdown', overlay.unmuteHandler, true); } catch { /* ignore */ }
        overlay.unmuteHandler = null;
      }
      overlay.playing = false;
      overlay.switchTries = 0;
      overlay.rewound = false;
      overlay.revealed = false;
      overlay.nativeHidden = false;
      return;
    }
    try { clearInterval(overlay.positionTimer); } catch { /* ignore */ }
    try { clearTimeout(overlay.timeoutTimer); } catch { /* ignore */ }
    if (overlay.onMessage) window.removeEventListener('message', overlay.onMessage);
    if (overlay.unmuteHandler) {
      try { document.removeEventListener('pointerdown', overlay.unmuteHandler, true); } catch { /* ignore */ }
      overlay.unmuteHandler = null;
    }
    if (overlay.badge) {
      try { overlay.badge.remove(); } catch { /* ignore */ }
      overlay.badge = null;
    }
    try { overlay.frame.remove(); } catch { /* ignore */ }
    const v = overlay.video && overlay.video.isConnected ? overlay.video : mainVideo();
    // restoreNativeVideos() restores every video's stored state, then the main
    // video's pre-overlay mute state wins (the stored value can be the mute we
    // applied in ad-hold/after hiding).
    restoreNativeVideos();
    if (v) {
      try { v.muted = overlay.wasMuted; } catch { /* ignore */ }
      resumeNative(v, 'now');
      setTimeout(() => {
        if (overlay.frame) return;
        resumeNative(v, '300ms');
      }, 300);
      setTimeout(() => {
        if (overlay.frame) return;
        resumeNative(v, '1200ms');
        if (v.paused) {
          try {
            const btn = document.querySelector('[data-a-target="player-play-pause-button"]');
            if (btn) btn.click();
            adLog('native-resume-click', {
              paused: v.paused,
              label: btn ? btn.getAttribute('aria-label') : null,
            });
          } catch {
            /* ignore */
          }
        }
      }, 1200);
    }
    bypassStats.stops++;
    bypassStats.last = { type: 'stop', reason: String(reason || ''), at: Date.now() };
    overlay.frame = null;
    overlay.token = null;
    overlay.url = null;
    overlay.channel = null;
    overlay.video = null;
    overlay.ready = false;
    overlay.autoplayRetry = false;
    overlay.playing = false;
    overlay.switchTries = 0;
    overlay.onMessage = null;
    overlay.rewound = false;
    overlay.revealed = false;
    overlay.nativeHidden = false;
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

  function revealOverlay(reason) {
    if (!overlay.frame) return;
    if (!overlay.revealed) {
      overlay.revealed = true;
      try {
        overlay.frame.style.opacity = '1';
        overlay.frame.style.pointerEvents = 'auto';
      } catch {
        /* frame gone */
      }
      adLog('overlay-reveal', {
        reason,
        rewound: overlay.rewound,
        playing: overlay.playing,
      });
    }
    if (!overlay.nativeHidden) {
      hideNativeVideos();
      overlay.nativeHidden = true;
    }
    if (overlay.hideTimer) {
      try { clearTimeout(overlay.hideTimer); } catch { /* ignore */ }
      overlay.hideTimer = 0;
    }
  }

  function startAdOverlay(url, channel, switchSource = false) {
    if (!AD_OVERLAY_ENABLED) return;
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
          startAdOverlay(url, channel, switchSource);
        }, 400);
      }
      return;
    }
    if (overlay.frame) {
      if (switchSource) {
        // 0.8.17: the old hls.js instance can stay stuck in Buffering after an
        // ad-only playlist (measured on necros). Tear the iframe down and
        // build a fresh one for the replacement source; this resets the
        // MediaSource instead of calling loadSource on a wedged instance.
        try { clearTimeout(overlay.timeoutTimer); } catch { /* ignore */ }
        try { clearInterval(overlay.positionTimer); } catch { /* ignore */ }
        try { clearTimeout(overlay.adEndTimer); } catch { /* ignore */ }
        try { clearTimeout(overlay.watchdogTimer); } catch { /* ignore */ }
        overlay.watchdogTimer = 0;
        if (overlay.onMessage) {
          try { window.removeEventListener('message', overlay.onMessage); } catch { /* ignore */ }
        }
        if (overlay.unmuteHandler) {
          try { document.removeEventListener('pointerdown', overlay.unmuteHandler, true); } catch { /* ignore */ }
          overlay.unmuteHandler = null;
        }
        if (overlay.badge) {
          try { overlay.badge.remove(); } catch { /* ignore */ }
          overlay.badge = null;
        }
        try { overlay.frame.remove(); } catch { /* ignore */ }
        overlay.frame = null;
        overlay.onMessage = null;
        overlay.ready = false;
        overlay.playing = false;
      } else {
        // A second ad event with a fresher URL: reload the same frame and
        // cancel any pending ad-end grace timer from the previous pod.
        try { clearTimeout(overlay.adEndTimer); } catch { /* ignore */ }
        overlay.adEndTimer = 0;
        overlay.adEndTries = 0;
        overlay.autoplayRetry = false;
        overlay.startedAt = Date.now();
        // A long ad pod can outlast 60s; the worker's two-clean-playlist
        // `ad-end` is the normal stop, this is only a safety net.
        try { clearTimeout(overlay.timeoutTimer); } catch { /* ignore */ }
        overlay.timeoutTimer = setTimeout(() => stopAdOverlay('timeout'), 180 * 1000);
        overlay.url = url;
        overlaySend({ t: 'load', url });
        return;
      }
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
    // Keep the iframe composited while it is still invisible: `opacity:0`
    // made Chrome treat the clean player as occluded and hls.js never left
    // rs=0 (measured). 1% black over the native frame is imperceptible and
    // lets hls.js decode; on Playing we switch to opacity 1 and hide native.
    frame.style.cssText = 'position:fixed;z-index:2147483647;border:0;background:#000;opacity:0.01;pointer-events:none;';
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
    overlay.playing = false;
    overlay.revealed = false;
    overlay.nativeHidden = false;
    if (!switchSource) overlay.switchTries = 0;
    if (overlay.hideTimer) {
      try { clearTimeout(overlay.hideTimer); } catch { /* ignore */ }
      overlay.hideTimer = 0;
    }
    // Bounded fallback: if hls.js cannot start while the native video is
    // visible, reveal anyway after 5s. With the 1%-opacity iframe the clean
    // player usually reports Playing well before this; the timer is only the
    // safety net that keeps the ad from staying visible forever.
    overlay.hideTimer = setTimeout(() => {
      if (!overlay.frame || overlay.revealed) return;
      revealOverlay('fallback-timeout');
    }, 5000);

    // Small, non-interactive indicator so the reduced-quality player is not
    // mistaken for a broken Twitch player. Positioned in positionOverlay().
    const badge = document.createElement('div');
    badge.id = 'ko-adfix-badge';
    badge.textContent = switchSource ? 'sem anúncio · trocando fonte limpa…' : 'sem anúncio · conectando fonte limpa…';
    badge.style.cssText =
      'position:fixed;z-index:2147483647;pointer-events:none;display:none;' +
      'background:rgba(0,0,0,.72);color:#fff;font:12px/1.4 system-ui,sans-serif;' +
      'padding:3px 7px;border-radius:4px;white-space:nowrap;';
    try { document.body.appendChild(badge); } catch { /* ignore */ }
    overlay.badge = badge;
    // Do NOT hide the native video here. Measured: hiding it immediately is
    // what produced the black/buffering frame while the clean source started.
    // Keep it visible until revealOverlay() (overlay Playing or the 2.5s
    // fallback), then hide all native videos.

    overlay.onMessage = (ev) => {
      const m = ev.data && ev.data.__koKick;
      if (!m || ev.source !== overlay.frame?.contentWindow || m._koToken !== overlay.token) return;
      bypassStats.msgs = (bypassStats.msgs || 0) + 1;
      bypassStats.lastMsg = { t: m.t, state: m.st && m.st.state, st: m.st || null, at: Date.now() };
      if (m.t === 'ready') {
        overlay.ready = true;
        if (overlay.badge) overlay.badge.textContent = 'sem anúncio · carregando…';
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
      if (m.t === 'ev' && m.e === 'adstrip') {
        bypassStats.adStrips = (bypassStats.adStrips || 0) + 1;
        bypassStats.lastAdStrip = { d: m.d, at: Date.now() };
        return;
      }
      if (m.t === 'ev' && m.e === 'adstrip-error') {
        bypassStats.adStripErrors = (bypassStats.adStripErrors || 0) + 1;
        bypassStats.lastAdStripError = { d: m.d, at: Date.now() };
        return;
      }
      if (m.t === 'ev' && m.e === 'ad-only') {
        // The overlay's current token type went ad-only. Ask the worker to
        // probe another type; its ad-start rebuilds this iframe with a clean
        // master instead of leaving hls.js in Buffering.
        bypassStats.adOnly = (bypassStats.adOnly || 0) + 1;
        bypassStats.lastAdOnly = { d: m.d, at: Date.now() };
        if (overlay.badge) overlay.badge.textContent = 'sem anúncio · trocando fonte limpa…';
        try {
          bypassChannel?.postMessage({ type: 'need-source', page: pageId, channel: overlay.channel || null });
        } catch {
          /* overlay is optional */
        }
        return;
      }
      if (m.t === 'ev' && m.e === 'error') {
        bypassStats.errors++;
        stopAdOverlay('player-error');
        return;
      }
      if (m.t === 'ev' && m.e === 'firstframe') {
        // The clean player has produced its first frame. Swap now: this is the
        // seam where the native frame is replaced by the clean frame.
        revealOverlay('firstframe');
        return;
      }
      if (m.t === 'st' && m.st) {
        if (m.st.state === 'Playing') {
          overlay.playing = true;
          try { clearTimeout(overlay.watchdogTimer); } catch { /* ignore */ }
          overlay.watchdogTimer = 0;
          // The clean player is actually running: now it is safe to cover the
          // native video. Before this point the native stays visible.
          revealOverlay('playing');
          if (overlay.badge) overlay.badge.textContent = 'sem anúncio · qualidade reduzida';
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

    // Unmute on the first user gesture anywhere on the page. The native player
    // is covered by the iframe, so Twitch's own volume control is not
    // reachable while the fallback is active.
    overlay.unmuteHandler = () => {
      overlaySend({ t: 'mute', m: false });
      overlaySend({ t: 'play' });
      if (overlay.badge) overlay.badge.textContent = 'sem anúncio · qualidade reduzida';
      try { document.removeEventListener('pointerdown', overlay.unmuteHandler, true); } catch { /* ignore */ }
      overlay.unmuteHandler = null;
    };
    try { document.addEventListener('pointerdown', overlay.unmuteHandler, true); } catch { /* ignore */ }

    // Watchdog: the clean master can still go ad-only on its media playlist.
    // The iframe reports that, but if hls.js simply never reaches Playing we
    // must not leave a permanent black frame. Ask the worker for a different
    // source, at most twice, then restore the native player.
    try { clearTimeout(overlay.watchdogTimer); } catch { /* ignore */ }
    overlay.watchdogTimer = setTimeout(() => {
      if (!overlay.frame || overlay.playing) return;
      if (overlay.switchTries >= 2) {
        stopAdOverlay('no-source');
        return;
      }
      overlay.switchTries++;
      if (overlay.badge) overlay.badge.textContent = 'sem anúncio · trocando fonte limpa…';
      try {
        bypassChannel?.postMessage({ type: 'need-source', page: pageId, channel: overlay.channel || null });
      } catch {
        /* overlay is optional */
      }
    }, 7000);

    positionOverlay();
    overlay.positionTimer = setInterval(positionOverlay, 500);
    // Safety net if Twitch stops requesting playlists while its <video> is
    // hidden. Long ad pods are common; the two-clean-playlist `ad-end` is the
    // normal stop, this only guards a stuck overlay.
    overlay.timeoutTimer = setTimeout(() => stopAdOverlay('timeout'), 180 * 1000);
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
      adLog('bypass-msg', {
        type: String(msg.type || ''),
        channel: msg.channel || null,
        switch: !!msg.switch,
        hasUrl: !!msg.url,
        reason: msg.reason ? String(msg.reason).slice(0, 80) : null,
      });
      if (document.documentElement.getAttribute('data-ko-adblock') === '0') {
        stopAdOverlay('disabled');
        return;
      }
      if (msg.type === 'ad-hold') {
        if (!AD_OVERLAY_ENABLED) return;
        if (overlay.frame) {
          try { clearTimeout(overlay.adEndTimer); } catch { /* ignore */ }
          overlay.adEndTimer = 0;
          overlay.adEndTries = 0;
          return;
        }
        if (overlay.held) return;
        // Hybrid step 1: rewind before muting. The native replays buffered
        // content, giving the clean overlay time to start without a black
        // frame. One rewind per ad.
        if (!overlay.rewound) {
          overlay.rewound = true;
          const rew = rewindNative(AD_REWIND_SEC);
          adLog('ad-rewind', { seconds: AD_REWIND_SEC, result: rew });
        }
        const v = mainVideo();
        if (!v) return;
        overlay.held = true;
        overlay.holdWasMuted = v.muted;
        // Mute immediately so the ad audio never plays. Do not hide the video
        // yet: the clean source is still being probed, and a black frame is
        // worse than one second of muted ad. startAdOverlay() covers it as
        // soon as the source is ready.
        try {
          v.muted = true;
        } catch {
          /* ignore */
        }
        return;
      }
      if (msg.type === 'ad-start') {
        if (!AD_OVERLAY_ENABLED) return;
        startAdOverlay(msg.url, msg.channel, !!msg.switch);
        return;
      }
      if (msg.type === 'ad-end') {
        if (!AD_OVERLAY_ENABLED) return;
        finishAdOverlay();
        return;
      }
      if (msg.type === 'ad-fail') {
        if (!AD_OVERLAY_ENABLED) return;
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

  // ---- durable recorder ----------------------------------------------------
  // Runs whether adblock is ON or OFF. This is what makes a refresh useful:
  // every content/ad transition is appended to storage with `ms` since
  // navigation, so a preroll that appears 4s after load is still measurable
  // after the tab has moved on.
  const rec = { ad: false, playing: false, adSince: 0, lastTick: 0, netSeen: new Map() };
  function videoInfo(v) {
    if (!v) return null;
    return {
      ct: Math.round(v.currentTime * 10) / 10,
      dur: Number.isFinite(v.duration) ? Math.round(v.duration * 10) / 10 : null,
      w: v.videoWidth,
      h: v.videoHeight,
      rs: v.readyState,
      paused: v.paused,
      muted: v.muted,
    };
  }
  function sampleVideo() {
    try {
      const vs = [...document.querySelectorAll('video')];
      const v =
        vs.find((x) => x.isConnected && !x.paused && x.videoWidth > 0) ||
        vs.find((x) => x.videoWidth > 0) ||
        vs[0] ||
        null;
      return videoInfo(v);
    } catch {
      return null;
    }
  }
  function recLog(ev, detail) {
    adLog(ev, Object.assign({ video: sampleVideo(), adblock: isOn() }, detail || {}));
  }

  try {
    for (const type of ['playing', 'pause', 'waiting', 'stalled', 'loadedmetadata', 'emptied', 'error']) {
      document.addEventListener(
        type,
        (e) => {
          const t = e && e.target;
          if (!t || t.tagName !== 'VIDEO') return;
          recLog('video-' + type, { targetMuted: !!t.muted });
        },
        true,
      );
    }
  } catch {
    /* recorder is best-effort */
  }

  // Resource timing catches the ad SDK / creative requests even when the
  // adblock fetch hook is disabled, and gives a timestamp before the ad UI.
  try {
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const u = String(e.name || '');
        if (!/edge\.ads\.twitch\.tv|amazon-adsystem|doubleclick|imasdk|ads\.twitch/i.test(u)) continue;
        const key = u.slice(0, 120);
        const prev = rec.netSeen.get(key) || 0;
        if (Date.now() - prev < 800) continue;
        rec.netSeen.set(key, Date.now());
        if (rec.netSeen.size > 40) {
          const first = rec.netSeen.keys().next().value;
          rec.netSeen.delete(first);
        }
        adLog('ad-net', {
          url: u.slice(0, 180),
          start: Math.round(e.startTime || 0),
          dur: Math.round(e.duration || 0),
          initiator: String(e.initiatorType || ''),
        });
      }
    });
    po.observe({ type: 'resource', buffered: true });
  } catch {
    /* PerformanceObserver is optional */
  }

  setInterval(() => {
    try {
      const adDetail = adUiDetail();
      const ad = !!adDetail;
      if (ad !== rec.ad) {
        const since = rec.adSince;
        rec.ad = ad;
        if (ad) rec.adSince = Date.now();
        rec.lastTick = 0;
        recLog(ad ? 'ad-ui-on' : 'ad-ui-off', {
          // Never derive a duration from adSince=0; that printed epoch seconds.
          adSec: ad ? 0 : since ? Number(((Date.now() - since) / 1000).toFixed(1)) : null,
          match: adDetail,
        });
        if (!ad) rec.adSince = 0;
      }
      const v = sampleVideo();
      const playing = !!(v && !v.paused && v.w > 0 && v.rs >= 2);
      if (playing !== rec.playing) {
        rec.playing = playing;
        // A video playing while the ad UI is up is the ad creative, not
        // content. Label it separately so content->ad is unambiguous.
        recLog(playing ? (ad ? 'ad-video-play' : 'content-play') : 'content-stop', { ad });
      }
      if (ad && Date.now() - rec.lastTick > 1000) {
        rec.lastTick = Date.now();
        recLog('ad-tick', { adSec: Number(((Date.now() - rec.adSince) / 1000).toFixed(1)) });
      }
    } catch {
      /* DOM can be mid-mutation */
    }
  }, 500);
  // At document_start the bridge has not applied storage yet, so logging
  // `adblock` here would always say true. Log the resolved state after the
  // async storage read has had time to set the attribute.
  adLog('recorder-start', { href: location.href, video: sampleVideo() });
  setTimeout(() => recLog('recorder-ready', { href: location.href }), 500);

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
        if (typeof v.platform === 'string') v.platform = CLEAN_PLATFORM;
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

  // ---- VOD CSAI ad-decision block -----------------------------------------
  // VOD pre-roll/mid-roll ads are not in the HLS manifest; the player fetches
  // an ad creative from edge.ads.twitch.tv and renders it over paused content.
  // Community scripts use an empty ad list ([]) as the safe "no ads" shape.
  // Keep this to ad hosts only; normal Twitch requests are untouched.
  const AD_CREATIVE_HOSTS = new Set([
    'edge.ads.twitch.tv',
    'imasdk.googleapis.com',
    'securepubads.g.doubleclick.net',
    'pubads.g.doubleclick.net',
  ]);
  function isAdCreativeUrl(value) {
    try {
      const u = new URL(String(value || ''), location.href);
      return AD_CREATIVE_HOSTS.has(u.host);
    } catch {
      return false;
    }
  }
  function isAdTelemetryUrl(value) {
    try {
      const u = new URL(String(value || ''), location.href);
      if (u.host === 'countess.twitch.tv') return true;
      return u.host === 'spade.twitch.tv' && /ad|midroll|preroll|video_ad/i.test(u.pathname + u.search);
    } catch {
      return false;
    }
  }
  function emptyAdResponse() {
    stats.vodAdsBlocked = (stats.vodAdsBlocked || 0) + 1;
    return new Response('[]', {
      status: 200,
      statusText: 'OK',
      headers: { 'Content-Type': 'application/json' },
    });
  }
  function noContentResponse() {
    return new Response('', { status: 204, statusText: 'No Content' });
  }

  // ---- layer 1: page fetch / XHR token rewrite -----------------------------
  try {
    const realFetch = window.fetch;
    if (typeof realFetch === 'function') {
      window.fetch = function (input, init) {
        try {
          if (!isOn()) return realFetch.apply(this, arguments);
          const url = typeof input === 'string' ? input : (input && input.url) || '';
          if (isAdCreativeUrl(url)) return Promise.resolve(emptyAdResponse());
          if (isAdTelemetryUrl(url)) return Promise.resolve(noContentResponse());
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
    const xhrSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.open = function (method, url) {
      try {
        this.__koUrl = String(url);
        if (isOn() && isAdCreativeUrl(url)) {
          // A data: URL makes the ad-decision XHR resolve with [] without a
          // network request; 4xx/5xx would make the player retry the break.
          this.__koBlockedAd = true;
          stats.vodAdsBlocked = (stats.vodAdsBlocked || 0) + 1;
          return xhrOpen.call(this, method, 'data:application/json;base64,' + btoa('[]'), true);
        }
      } catch {
        /* ignore */
      }
      return xhrOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.setRequestHeader = function () {
      // data: URLs reject custom headers (edge.ads.twitch.tv sends some).
      if (this.__koBlockedAd) return;
      return xhrSetRequestHeader.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
      try {
        if (!this.__koBlockedAd && isOn() && String(this.__koUrl || '').includes('gql.twitch.tv/gql')) {
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
    // 0.8.20: the client-side fallback ladder. The page covers the native
    // player with a clean lower-quality HLS stream during stitched ads. This
    // is opt-out via the adblock toggle (data-ko-adblock=0).
    const AD_BYPASS_ENABLED = true;
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
        } else if (msg.type === 'need-source' && adBypassActive) {
          switchCleanSource(msg.channel || lastChannel);
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

    // Live ad bypass must never run for VOD. VOD media segments have no
    // ",live" suffix, so playlistInfo() reports every VOD segment as an "ad";
    // without this guard a live->VOD SPA navigation could cover the VOD with
    // the old channel's live stream. Twitch live media is served from
    // *.playlist.ttvnw.net/v1/playlist/ or *.playlist.live-video.net/, while
    // VOD media is a cloudfront index-dvr.m3u8.
    function isLiveMediaUrl(url) {
      const u = String(url || '');
      return /\/v1\/playlist\//.test(u) || /\.playlist\.live-video\.net\//.test(u);
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
    // The 2026 TwitchAdSolutions forks put popout/site/mobile_web first and
    // use autoplay only as a last resort: autoplay is 360p and can get stuck
    // in a loading loop when used as a long-lived backup. We keep it last.
    async function findCleanHlsUrl(channel, preferFallback = false, prewarmMode = false) {
      const types = prewarmMode
        ? [
            // Prewarm should maximize the chance the token is still clean
            // when the ad actually lands. autoplay/android is the measured
            // clean-during-SSAI type; it is 360p, but the user accepts lower
            // quality during the break. The overlay can still switch to a
            // better web type if this one goes ad-only.
            ['autoplay', 'android'],
            ['mobile', 'android'],
            ['mobile_web', 'web'],
            ['popout', 'web'],
            ['site', 'web'],
            ['embed', 'web'],
          ]
        : preferFallback
        ? [
            ['mobile_web', 'web'],
            ['popout', 'web'],
            ['site', 'web'],
            ['mobile', 'android'],
            ['autoplay', 'android'],
            ['embed', 'web'],
          ]
        : [
            ['site', 'web'],
            ['popout', 'web'],
            ['mobile_web', 'web'],
            ['mobile', 'android'],
            ['embed', 'web'],
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
    let switchBusy = false;
    let lastSwitchAt = 0;
    // The first ~4s of a fresh page are usually content before the preroll.
    // Mint and probe a clean backup during that window so an ad can be covered
    // immediately instead of spending 1-3s probing after the ad starts.
    const PREWARM_TTL = 90 * 1000;
    let prewarm = { channel: null, url: null, at: 0, busy: false };
    let prewarmBusyChannel = null;
    let prewarmPromise = null;

    // A DNS/TLS hang while probing must not leave the native player muted for
    // the rest of the ad. The probe itself keeps running, but the caller gets
    // null and restores the native player / asks the watchdog to retry.
    function withTimeout(promise, ms) {
      return Promise.race([
        promise,
        new Promise((resolve) => setTimeout(() => resolve(null), ms)),
      ]);
    }

    // The overlay's current source went ad-only mid-pod. Probe the types that
    // are known to stay clean during SSAI (autoplay/android first) and post a
    // fresh ad-start; the page rebuilds the hls.js iframe with it.
    async function switchCleanSource(channel) {
      if (bypassBusy || switchBusy) return;
      if (Date.now() - lastSwitchAt < 4000) return;
      switchBusy = true;
      lastSwitchAt = Date.now();
      try {
        const url = await withTimeout(findCleanHlsUrl(channel || lastChannel, true), 10000);
        if (url && adBypassActive) {
          debugLog('bypass.switch', { channel: channel || lastChannel });
          postBypass({ type: 'ad-start', channel: lastChannel, url, switch: true });
        } else if (!adBypassActive) {
          debugLog('bypass.switchAborted', { channel: channel || lastChannel });
        } else {
          debugLog('bypass.switchFail', { channel: channel || lastChannel });
        }
      } catch (e) {
        debugLog('bypass.switchError', { error: String(e).slice(0, 180) });
      } finally {
        switchBusy = false;
      }
    }

    async function prewarmCleanSource(channel) {
      if (!channel || prewarm.busy) return;
      if (prewarm.channel === channel && Date.now() - prewarm.at < PREWARM_TTL) return;
      prewarm.busy = true;
      prewarmBusyChannel = channel;
      prewarmPromise = (async () => {
        try {
          const url = await withTimeout(findCleanHlsUrl(channel, true), 8000);
          if (url) {
            prewarm = { channel, url, at: Date.now(), busy: false };
            debugLog('prewarm.ok', { channel });
          } else {
            prewarm.busy = false;
            debugLog('prewarm.fail', { channel });
          }
        } catch (e) {
          prewarm.busy = false;
          debugLog('prewarm.error', { error: String(e).slice(0, 160) });
        }
      })();
      try {
        await prewarmPromise;
      } finally {
        prewarmBusyChannel = null;
        prewarmPromise = null;
      }
    }

    async function maybeStartBypass() {
      if (!lastChannel || bypassBusy) return;
      if (Date.now() - lastBypassAt < 15000) return;
      bypassBusy = true;
      lastBypassAt = Date.now();
      postBypass({ type: 'ad-hold', channel: lastChannel });
      try {
        let url = null;
        let prewarmAge = 0;
        if (prewarm.channel === lastChannel && prewarm.url && Date.now() - prewarm.at < PREWARM_TTL) {
          url = prewarm.url;
          prewarmAge = Date.now() - prewarm.at;
          prewarm = { channel: null, url: null, at: 0, busy: false };
          debugLog('bypass.prewarmHit', { channel: lastChannel, age: prewarmAge });
        }
        if (!url && prewarmPromise && prewarmBusyChannel === lastChannel) {
          // The page-load prewarm is still in flight; wait briefly for it
          // instead of launching a duplicate probe.
          await withTimeout(prewarmPromise, 3500);
          if (prewarm.channel === lastChannel && prewarm.url && Date.now() - prewarm.at < PREWARM_TTL) {
            url = prewarm.url;
            prewarmAge = Date.now() - prewarm.at;
            prewarm = { channel: null, url: null, at: 0, busy: false };
            debugLog('bypass.prewarmWaitHit', { channel: lastChannel, age: prewarmAge });
          }
        }
        if (!url) url = await withTimeout(findCleanHlsUrl(lastChannel), 10000);
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
      if (incoming && incoming.player_type === __KO_PLAYER_TYPE && incoming.platform === __KO_PLATFORM) {
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
        const text = await mintMaster(channel, __KO_PLAYER_TYPE, __KO_PLATFORM);
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
          platform: __KO_PLATFORM,
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
        // A VOD page reuses the same worker/page after an SPA navigation from
        // a live channel. Drop the stale live channel so the VOD playlists
        // can never trigger the live-only bypass ladder.
        if (typeof url === 'string' && /\/vod\/v2\//.test(url)) lastChannel = null;
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
          // Start the prewarm as soon as the live master appears: this is the
          // earliest point where the channel is known, and it buys the most
          // of the ~4s content grace before a preroll.
          if (lastChannel) prewarmCleanSource(lastChannel);
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
          const liveMedia = isLiveMediaUrl(url);
          if (info.extinf > 0) {
            if (liveMedia && info.adExtinf > 0) {
              // Any stitched ad, not just an all-ad preroll. A midroll can be
              // mixed (e.g. 51 ad segments + 1 content segment in the same
              // refreshed playlist), and the player may already have buffered
              // the ad by the time stripAds() sees it. Cover the native player
              // with the clean hls.js stream immediately; stripAds() still
              // removes future ad segments from the native playlist.
              cleanPlaylistStreak = 0;
              if (AD_BYPASS_ENABLED && !adBypassActive) maybeStartBypass();
            } else if (liveMedia && adBypassActive) {
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
          // Use the pre-ad grace window: while the live playlist is clean,
          // keep one warm, pre-probed clean master ready. When the preroll
          // lands, maybeStartBypass() can cover it without the 1-3s probe.
          if (liveMedia && info.extinf > 0 && info.adExtinf === 0 && !adBypassActive) {
            prewarmCleanSource(lastChannel);
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
              'const __KO_PLATFORM=' + JSON.stringify(CLEAN_PLATFORM) + ';' +
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
