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
  // Preload one clean 360p/1080p surface while the channel is live. This is
  // the only way to make the swap effectively 0s: a second hls.js player
  // cannot share the native player's decoded frames. It costs bandwidth/CPU
  // only while the Twitch tab is visible and an ad is not already active.
  const AD_STANDBY_ENABLED = true;
  // Hybrid: on the first ad signal, jump the native player back this many
  // seconds. 5s = the user's observed ~4s content grace + 1s safety. The real
  // value is measured from ko.adlog (`ad-rewind` / `content-play`); this is
  // only the starting point.
  // The cold-path rewind was meant to hide the hls.js fetch, but on ad-heavy
  // channels it seeks the native into an unbuffered ad-only region: jynxzi
  // dropped to readyState 1 at currentTime 5 for ~9s after a 5s rewind. Keep
  // the native where Twitch left it; the clean overlay either covers or the
  // native ad stays visible.
  const AD_REWIND_SEC = 0;
  const bypassStats = {
    starts: 0,
    stops: 0,
    errors: 0,
    playing: 0,
    standbyStarts: 0,
    standbyReady: 0,
    standbyHits: 0,
    last: null,
    lastStandby: null,
  };
  stats.adBypass = bypassStats;
  const overlay = {
    frame: null,
    token: null,
    url: null,
    channel: null,
    video: null,
    wasMuted: false,
    wasVolume: 1,
    // The user's last mute decision for the surface this overlay replaces.
    // true = muted. Seeded from the native <video> at takeover (ad-hold or
    // standby adoption), flipped only by an explicit badge click, and used
    // both at reveal (a muted user keeps a muted picture) and at ad-end
    // (restore the decision, not the transient state of whichever element
    // happened to be playing). Owner report 2026-10-26: mute, then an ad
    // swapped the player and the audio came back.
    muteIntent: true,
    held: false,
    holdWasMuted: false,
    holdVolume: 1,
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
    healthyTicks: 0,
    nudgeTries: 0,
    lastSt: null,
    lastStAt: 0,
    catchupAt: 0,
    unmuteTried: false,
    unmuteCheck: 0,
    switchTries: 0,
    watchdogTimer: 0,
    stallTimer: 0,
    adoptTimer: 0,
    switchPrev: null,
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
    coldCover: false,
    coldTimer: 0,
    nativeHidden: false,
    hideTimer: 0,
    // Preloaded clean player. It runs muted at 1% opacity over the native
    // surface, so an ad can be covered immediately instead of paying the
    // ~1.6-2.6s HLS segment-fetch cost after ad-hold. It is not an ad until
    // adActive is set; firstframe/Playing only mark it ready while standby.
    standby: false,
    adActive: false,
  };

  // The worker owns the prewarm probes and the ad state; it posts
  // `standby-start` with a clean URL when a standby may run. This page-side
  // request asks it to re-use a fresh prewarm or probe a new one, after an ad
  // or when the tab becomes visible again. It never starts anything directly.
  let standbyRequestTimer = 0;
  let lastStandbyRequestAt = 0;
  function pageChannel() {
    try {
      return (location.pathname.split('/').filter(Boolean)[0] || '').toLowerCase();
    } catch {
      return '';
    }
  }
  function isChannelPath() {
    try {
      const parts = location.pathname.split('/').filter(Boolean);
      if (parts.length !== 1) return false;
      return !/^(directory|downloads|friends|gift|jobs|login|notifications|search|settings|subscriptions|inventory|wallet|drops|video|videos|p|turbo|store|legal|privacy|about|embed|popout|moderator|dashboard|creatorcamp|security|activate|signup|messages|whispers)$/i.test(parts[0]);
    } catch {
      return false;
    }
  }
  function requestStandby(delay = 1200, force = false) {
    // A standby that keeps failing (offline channel, bad token) must not turn
    // into a mint/error loop. Normal requests still re-post immediately and
    // do not arm the cooldown, so recovery after an ad is not delayed.
    if (force) {
      const now = Date.now();
      if (now - lastStandbyRequestAt < 4000) return;
      lastStandbyRequestAt = now;
    }
    try { clearTimeout(standbyRequestTimer); } catch { /* ignore */ }
    standbyRequestTimer = setTimeout(() => {
      standbyRequestTimer = 0;
      if (overlay.frame || overlay.held || overlay.adActive) return;
      try {
        bypassChannel?.postMessage({
          type: 'standby-request',
          page: pageId,
          channel: pageChannel() || null,
          force: !!force,
        });
      } catch {
        /* overlay is optional */
      }
    }, delay);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') requestStandby(0);
  });

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
    // The old path blindly sought 5s back. On an ad-only part of the playlist
    // that target is not buffered, and the native dropped to readyState 1 and
    // never recovered (kimkataguiri, 2026-10-23). Only rewind into data the
    // element already has; leave a live native alone otherwise.
    let buffered = false;
    try {
      const b = v.buffered;
      for (let i = 0; i < (b ? b.length : 0); i++) {
        if (target >= b.start(i) && target <= b.end(i)) buffered = true;
      }
    } catch { /* ignore */ }
    if (!buffered) return { skipped: 'no-buffer', before: +before.toFixed(2), target: +target.toFixed(2) };
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
      overlay.badge.style.display = (overlay.revealed || overlay.coldCover) ? 'block' : 'none';
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
      const known = overlay.hiddenVideos.find((x) => x.el === v);
      if (known) {
        // Twitch can unmute/re-show a video after we hid it (measured as
        // doubled audio ~1.5-2s behind the clean overlay). Re-apply on every
        // position tick instead of trusting the first hide.
        try { v.style.visibility = 'hidden'; } catch { /* ignore */ }
        try { v.muted = true; } catch { /* ignore */ }
        continue;
      }
      overlay.hiddenVideos.push({ el: v, visibility: v.style.visibility, muted: v.muted, volume: v.volume });
      try { v.style.visibility = 'hidden'; } catch { /* ignore */ }
      // Mute every native video, not just the main one: a PBP/ad video can
      // keep playing audio behind the opaque overlay.
      try { v.muted = true; } catch { /* ignore */ }
    }
  }

  function restoreNativeVideos() {
    for (const { el, visibility, muted, volume } of overlay.hiddenVideos) {
      try {
        if (el.isConnected) {
          el.style.visibility = visibility;
          if (typeof muted === 'boolean') el.muted = muted;
          if (Number.isFinite(volume)) el.volume = volume;
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
      requestStandby();
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
    requestStandby();
  }

  // The ad path replaces the native surface; the user's mute decision belongs
  // to that surface at the moment of the swap. Record it once per pod so
  // reveal (never unmute a muted user) and ad-end (restore the decision) both
  // read the same value. A warm standby was minted at page load, before any
  // later mute, so its own capture can be stale.
  function adoptNativeMute(v) {
    if (!v) return;
    overlay.muteIntent = !!v.muted;
    overlay.wasMuted = !!v.muted;
    if (Number.isFinite(v.volume)) overlay.wasVolume = v.volume;
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
      // Twitch sets volume=0 when the element is muted. Restoring only
      // `muted` left the icon unmuted but the video at volume 0, so the user
      // heard nothing until clicking the volume button (real report). Restore
      // the pre-hold volume too.
      try {
        if (Number.isFinite(overlay.holdVolume)) v.volume = overlay.holdVolume;
      } catch { /* ignore */ }
    }
    overlay.held = false;
  }

  // Hiding the native video does not normally pause it, but Twitch may pause
  // when the element is occluded, and on a cold preroll the native was never
  // playing at all. If it is parked at the live edge with readyState < 3, seek
  // back two seconds first so play() has data to work with.
  function nudgeNativeToBuffer(v) {
    if (!v) return;
    try {
      let ahead = 0;
      let target = null;
      const b = v.buffered;
      for (let i = 0; i < (b ? b.length : 0); i++) {
        if (v.currentTime >= b.start(i) - 0.1 && v.currentTime <= b.end(i) + 0.1) {
          ahead = Math.max(ahead, b.end(i) - v.currentTime);
        }
        if (b.end(i) < v.currentTime && b.end(i) - b.start(i) >= 1) {
          target = Math.max(target === null ? -Infinity : target, b.end(i) - 1);
        }
      }
      if (ahead >= 0.5 || target === null) return;
      // Move back only into a range the element already has. Seeking to an
      // arbitrary seekable point can land in an unbuffered ad-only part and
      // leave readyState 1 (measured on kimkataguiri).
      if (target < v.currentTime - 0.25) v.currentTime = target;
    } catch {
      /* ignore */
    }
  }

  function resumeNative(v, tag) {
    if (!v || !v.isConnected) return;
    try {
      // A native element that resumed behind its own buffered range plays at
      // 1x and never closes the gap (measured srdogg 2026-10-25: ct=3.9 while
      // buffered end was 12.1 at ad-end, ~10s behind the clean edge). Seeking
      // inside the buffered range is instant and cuts the handoff delay.
      const b = v.buffered;
      const be = b && b.length ? b.end(b.length - 1) : 0;
      if (be > v.currentTime + 3) {
        const from = Number(v.currentTime || 0);
        const target = be - 0.5;
        v.currentTime = target;
        adLog('native-catchup', { from: +from.toFixed(1), to: +target.toFixed(1) });
      }
      // readyState 2 with paused=false is still a frozen frame. Nudge behind
      // live and call play() even when the element claims it is not paused.
      if (v.readyState < 3) nudgeNativeToBuffer(v);
      if (v.paused || v.readyState < 3) {
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

  // Twitch can pause the native player a couple of seconds after an overlay is
  // removed, even when it was playing at the now/300ms retries. Retry past the
  // old 1200ms window. Do not click Twitch's play/pause button: its label and
  // state race with the element (measured: a click on the "Pausar" button
  // paused a native that had just resumed), so the button is not a safe resume.
  function resumeNativeIfAllowed(v, tag) {
    if (!v || !v.isConnected) return;
    if (overlay.adActive) return;
    if (overlay.frame && !overlay.standby) return;
    resumeNative(v, tag);
  }

  function clearOverlayStall() {
    if (!overlay.stallTimer) return;
    try { clearTimeout(overlay.stallTimer); } catch { /* ignore */ }
    overlay.stallTimer = 0;
  }

  function maybeNudgeOverlay(st, kind) {
    if (!overlay.frame || !st) return false;
    const pos = Number(st.pos);
    if (!(pos > 2)) return false;
    if ((overlay.nudgeTries || 0) >= 2) return false;
    overlay.nudgeTries = (overlay.nudgeTries || 0) + 1;
    // The clean player parks at its own live edge with 0.04s buffered and
    // hls.js reports bufferStalledError. Seek back inside the media window and
    // play again before falling back to the native ad.
    overlaySend({ t: 'seek', s: Math.max(0, pos - 2) });
    overlaySend({ t: 'play' });
    adLog('overlay-nudge', { kind: String(kind || ''), pos: +pos.toFixed(2), tries: overlay.nudgeTries });
    return true;
  }

  function scheduleOverlayStall(kind, ms = 2500) {
    if (!overlay.frame) return;
    // One timer per overlay. A healthy Playing/rs>=3 message clears it; if the
    // clean player stays stalled we nudge it back once or twice, then restore
    // the native surface instead of leaving a frozen frame.
    if (overlay.stallTimer) return;
    overlay.stallTimer = setTimeout(() => {
      overlay.stallTimer = 0;
      if (!overlay.frame) return;
      if (maybeNudgeOverlay(overlay.lastSt, kind)) {
        scheduleOverlayStall(kind, 3000);
        return;
      }
      // A cold ad can start while the clean player is still at the beginning
      // of its window (pos <= 2), so there is nothing to rewind into yet. Keep
      // the hidden frame alive while the native ad is on screen instead of
      // stopping it; the 12s hideTimer and the ad-end path still bound it.
      const age = Date.now() - (overlay.startedAt || 0);
      if (overlay.adActive && age < 12000) {
        scheduleOverlayStall(kind, 1500);
        return;
      }
      const wasStandby = overlay.standby;
      adLog('overlay-stall-stop', {
        kind: String(kind || ''),
        revealed: overlay.revealed,
        playing: overlay.playing,
        switchPrev: !!overlay.switchPrev,
      });
      stopAdOverlay('clean-stall');
      if (wasStandby) requestStandby(600, true);
    }, ms);
  }

  function stopAdOverlay(reason) {
    // A standby that was never adopted is invisible content behind the native
    // player. Stopping it must not post overlay-stop (that clears the worker's
    // ad state without an ad) and must not resume/seek the native player.
    const wasStandby = !!overlay.standby && !overlay.revealed && !overlay.adActive;
    try { clearTimeout(overlay.extTimer); } catch { /* ignore */ }
    overlay.extTimer = 0;
    try { clearTimeout(overlay.adEndTimer); } catch { /* ignore */ }
    overlay.adEndTimer = 0;
    try { clearTimeout(overlay.watchdogTimer); } catch { /* ignore */ }
    overlay.watchdogTimer = 0;
    try { clearTimeout(overlay.adoptTimer); } catch { /* ignore */ }
    overlay.adoptTimer = 0;
    clearOverlayStall();
    if (overlay.hideTimer) {
      try { clearTimeout(overlay.hideTimer); } catch { /* ignore */ }
      overlay.hideTimer = 0;
    }
    if (overlay.held) restoreHeldMute();
    if (!overlay.frame) {
      // Even without a frame, a badge/unmute handler can be left over from a
      // source switch that failed between teardown and rebuild.
      if (overlay.switchPrev) {
        try { clearTimeout(overlay.switchPrev.timer); } catch { /* ignore */ }
        try { overlay.switchPrev.frame.remove(); } catch { /* ignore */ }
        overlay.switchPrev = null;
      }
      if (overlay.badge) { try { overlay.badge.remove(); } catch { /* ignore */ } overlay.badge = null; }
      if (overlay.unmuteHandler) {
        try { document.removeEventListener('pointerdown', overlay.unmuteHandler, true); } catch { /* ignore */ }
        overlay.unmuteHandler = null;
      }
      overlay.playing = false;
      overlay.healthyTicks = 0;
      overlay.nudgeTries = 0;
      overlay.lastSt = null;
      overlay.catchupAt = 0;
      overlay.unmuteTried = false;
      try { clearTimeout(overlay.unmuteCheck); } catch { /* ignore */ }
      overlay.unmuteCheck = 0;
      overlay.lastStAt = 0;
      overlay.switchTries = 0;
      overlay.rewound = false;
      overlay.revealed = false;
      overlay.coldCover = false;
    try { clearTimeout(overlay.coldTimer); } catch { /* ignore */ }
    overlay.coldTimer = 0;
      overlay.nativeHidden = false;
      overlay.standby = false;
      overlay.adActive = false;
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
    if (overlay.switchPrev) {
      try { clearTimeout(overlay.switchPrev.timer); } catch { /* ignore */ }
      try {
        if (overlay.switchPrev.frame !== overlay.frame) overlay.switchPrev.frame.remove();
      } catch { /* ignore */ }
      overlay.switchPrev = null;
    }
    try { overlay.frame.remove(); } catch { /* ignore */ }
    if (!wasStandby) {
      // Handoff proof: the replaced element can start at 0 and replay the DVR
      // start (measured srdogg 2026-10-25). Log the native position and the
      // clean window before any resume call.
      try {
        const hv = mainVideo();
        adLog('native-handoff', {
          replaced: !!(hv && overlay.video && hv !== overlay.video),
          ct: hv ? +Number(hv.currentTime || 0).toFixed(1) : null,
          buf: hv && hv.buffered.length ? +hv.buffered.end(hv.buffered.length - 1).toFixed(1) : null,
          se: hv && hv.seekable.length ? +hv.seekable.end(hv.seekable.length - 1).toFixed(1) : null,
          cleanPos: overlay.lastSt ? +Number(overlay.lastSt.pos || 0).toFixed(1) : null,
          cleanLat: overlay.lastSt ? +Number(overlay.lastSt.lat || 0).toFixed(1) : null,
        });
      } catch { /* ignore */ }
      const v = overlay.video && overlay.video.isConnected ? overlay.video : mainVideo();
      // restoreNativeVideos() restores every video's stored state, then the
      // main video's mute decision wins (the stored value can be the mute we
      // applied in ad-hold/after hiding). The decision, not wasMuted, so an
      // unmute the user asked for during the pod survives the ad-end.
      restoreNativeVideos();
      if (v) {
        try { v.muted = overlay.muteIntent; } catch { /* ignore */ }
        try {
          if (Number.isFinite(overlay.wasVolume)) v.volume = overlay.wasVolume;
        } catch { /* ignore */ }
        resumeNativeIfAllowed(v, 'now');
        setTimeout(() => {
          // A new *hidden standby* must not block the native resume retries;
          // only a visible/held ad overlay should. Measured: starting the new
          // standby at ~1s prevented the 1200ms retry and left Twitch paused.
          resumeNativeIfAllowed(v, '300ms');
        }, 300);
        setTimeout(() => resumeNativeIfAllowed(v, '1200ms'), 1200);
        setTimeout(() => resumeNativeIfAllowed(v, '2500ms'), 2500);
        setTimeout(() => resumeNativeIfAllowed(v, '4000ms'), 4000);
        // A stalled clean overlay can leave Twitch's native player parked at
        // the live edge, paused, with no forward buffer. Four one-shot retries
        // are not enough: measured 2026-10-23 `jynxzi` stayed paused for ~7s
        // after clean-stall. Keep nudging it back behind live for 10s, but only
        // after a failure path, not after a normal ad-end.
        if (/clean-stall|ad-only|standby-timeout/.test(String(reason || ''))) {
          let n = 0;
          const timer = setInterval(() => {
            if (++n > 10) {
              clearInterval(timer);
              return;
            }
            if (overlay.adActive) return;
            if (overlay.frame && !overlay.standby) return;
            const nv = mainVideo();
            if (!nv || !nv.isConnected) return;
            if (!nv.paused && nv.readyState >= 3) return;
            resumeNative(nv, 'watch');
          }, 1000);
        }
      }
    }
    if (wasStandby) {
      bypassStats.lastStandby = { type: 'stop', reason: String(reason || ''), at: Date.now() };
    } else {
      bypassStats.stops++;
      bypassStats.last = { type: 'stop', reason: String(reason || ''), at: Date.now() };
    }
    overlay.frame = null;
    overlay.token = null;
    overlay.url = null;
    overlay.channel = null;
    overlay.video = null;
    overlay.ready = false;
    overlay.autoplayRetry = false;
    overlay.playing = false;
    overlay.healthyTicks = 0;
    overlay.nudgeTries = 0;
    overlay.lastSt = null;
    overlay.catchupAt = 0;
    overlay.unmuteTried = false;
    try { clearTimeout(overlay.unmuteCheck); } catch { /* ignore */ }
    overlay.unmuteCheck = 0;
    overlay.lastStAt = 0;
    overlay.switchTries = 0;
    overlay.onMessage = null;
    overlay.rewound = false;
    overlay.revealed = false;
    overlay.coldCover = false;
    try { clearTimeout(overlay.coldTimer); } catch { /* ignore */ }
    overlay.coldTimer = 0;
    overlay.nativeHidden = false;
    overlay.standby = false;
    overlay.adActive = false;
    // Tell the worker the overlay is gone so a timeout/player-error can retry
    // on a later ad playlist instead of leaving adBypassActive stuck true.
    // Standby shutdowns are invisible to the ad state machine.
    if (!wasStandby) {
      try {
        if (bypassChannel) {
          bypassChannel.postMessage({ type: 'overlay-stop', page: pageId, reason: String(reason || '') });
        }
      } catch {
        /* overlay is optional */
      }
    }
    if (wasStandby && String(reason || '') === 'standby-timeout') requestStandby(800);
  }

  function revealOverlay(reason) {
    if (!overlay.frame) return;
    try { clearTimeout(overlay.adoptTimer); } catch { /* ignore */ }
    overlay.adoptTimer = 0;
    const wasStandby = overlay.standby;
    // Revealing adopts the standby into the ad path: from now on ad-end and
    // overlay-stop behave exactly like a normal clean overlay.
    if (wasStandby) {
      bypassStats.starts++;
      bypassStats.last = { type: 'start', channel: overlay.channel, at: Date.now() };
      // The standby timeout started at page load; reset it from the ad so a
      // warm player that has been running for minutes still covers the pod.
      try { clearTimeout(overlay.timeoutTimer); } catch { /* ignore */ }
      overlay.timeoutTimer = setTimeout(() => stopAdOverlay('timeout'), 180 * 1000);
    }
    overlay.standby = false;
    overlay.adActive = true;
    // A standby that sat hidden while the tab was throttled can be far behind
    // the live edge (measured on srdogg 2026-10-25: lat 115.8s, dur 224s).
    // Revealing it would show a delayed stream and then jump forward at
    // ad-end. Seek inside the live window first and keep the native surface
    // (already muted by ad-hold) until the clean player is healthy again.
    if (wasStandby && overlay.lastSt) {
      const lat0 = Number(overlay.lastSt.lat);
      const pos0 = Number(overlay.lastSt.pos);
      if (Number.isFinite(lat0) && lat0 > 20) {
        overlay.playing = false;
        overlay.healthyTicks = 0;
        overlaySend({ t: 'seek', s: Math.max(0, pos0 + lat0 - 3) });
        overlaySend({ t: 'play' });
        adLog('overlay-catchup', { lat: +lat0.toFixed(1), pos: +pos0.toFixed(1) });
        try { clearTimeout(overlay.hideTimer); } catch { /* ignore */ }
        overlay.hideTimer = setTimeout(() => {
          if (overlay.frame && !overlay.revealed && !overlay.playing) stopAdOverlay('catchup-timeout');
        }, 12000);
        return;
      }
    }
    if (wasStandby || reason === 'standby') bypassStats.standbyHits++;
    if (!overlay.revealed) {
      overlay.revealed = true;
      overlay.coldCover = false;
    try { clearTimeout(overlay.coldTimer); } catch { /* ignore */ }
    overlay.coldTimer = 0;
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
      if (overlay.switchPrev) {
        try { clearTimeout(overlay.switchPrev.timer); } catch { /* ignore */ }
        try {
          if (overlay.switchPrev.frame !== overlay.frame) overlay.switchPrev.frame.remove();
        } catch { /* ignore */ }
        overlay.switchPrev = null;
      }
    }
    if (!overlay.nativeHidden) {
      hideNativeVideos();
      overlay.nativeHidden = true;
    }
    // The clean player is started muted so Chrome can autoplay it. Sound is
    // restored only when the user had sound on when the ad took over (or asked
    // for it with the badge). A user who muted keeps a muted picture plus the
    // click-to-sound badge, and if the browser refuses the unmute the muted
    // player stays; never trade a visible ad for a frozen clean frame.
    if (overlay.muteIntent) {
      overlaySend({ t: 'mute', m: true });
      overlaySend({ t: 'play' });
      adLog('reveal-muted', { reason });
    } else if (!overlay.unmuteTried) {
      overlay.unmuteTried = true;
      overlaySend({ t: 'mute', m: false });
      overlaySend({ t: 'play' });
      try { clearTimeout(overlay.unmuteCheck); } catch { /* ignore */ }
      overlay.unmuteCheck = setTimeout(() => {
        const st = overlay.lastSt;
        if (!overlay.frame || !st) return;
        if (st.muted || st.paused) {
          overlaySend({ t: 'mute', m: true });
          overlaySend({ t: 'play' });
          adLog('unmute-blocked', { muted: !!st.muted, paused: !!st.paused });
        } else {
          if (overlay.badge) overlay.badge.style.display = 'none';
          adLog('unmute-ok');
        }
      }, 1500);
    }
    if (overlay.hideTimer) {
      try { clearTimeout(overlay.hideTimer); } catch { /* ignore */ }
      overlay.hideTimer = 0;
    }
  }

  function startAdOverlay(url, channel, switchSource = false, standby = false) {
    if (!AD_OVERLAY_ENABLED) return;
    if (!url) return;
    const prevWasMuted = overlay.wasMuted;
    const prevWasVolume = overlay.wasVolume;
    // A stall timer belongs to the previous frame/source. Starting a new
    // overlay/switch invalidates it; the new frame gets its own.
    clearOverlayStall();
    try { clearTimeout(overlay.adoptTimer); } catch { /* ignore */ }
    overlay.adoptTimer = 0;
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
          startAdOverlay(url, channel, switchSource, standby);
        }, 400);
      }
      return;
    }
    if (overlay.frame) {
      // standby-start never calls this with an existing frame; guard anyway so
      // a standby can never be reloaded into a visible player.
      if (standby) return;
      if (switchSource) {
        // 0.8.17: the old hls.js instance can stay stuck in Buffering after an
        // ad-only playlist (measured on necros). Build a fresh iframe for the
        // replacement source; this resets the MediaSource instead of calling
        // loadSource on a wedged instance.
        //
        // 0.8.26: when the old frame was already visible, keep it underneath
        // while the replacement decodes. Removing it immediately left ~2.4s of
        // black (native video was already hidden) during a long Necros pod.
        if (overlay.switchPrev && overlay.revealed) {
          // The current frame is visible; it becomes the new fallback, so the
          // older fallback (if any) can go. If the current frame was not yet
          // revealed, keep the existing visible fallback through this retry.
          try { clearTimeout(overlay.switchPrev.timer); } catch { /* ignore */ }
          try { overlay.switchPrev.frame.remove(); } catch { /* ignore */ }
          overlay.switchPrev = null;
        }
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
        if (overlay.revealed) {
          const prev = overlay.frame;
          try { prev.style.pointerEvents = 'none'; } catch { /* ignore */ }
          try { prev.style.zIndex = '2147483646'; } catch { /* ignore */ }
          overlay.switchPrev = {
            frame: prev,
            timer: setTimeout(() => {
              const p = overlay.switchPrev;
              if (!p) return;
              try { p.frame.remove(); } catch { /* ignore */ }
              overlay.switchPrev = null;
            }, 12000),
          };
        } else {
          try { overlay.frame.remove(); } catch { /* ignore */ }
        }
        overlay.frame = null;
        overlay.onMessage = null;
        overlay.ready = false;
        overlay.playing = false;
        overlay.healthyTicks = 0;
        overlay.nudgeTries = 0;
        overlay.lastSt = null;
        overlay.catchupAt = 0;
        overlay.unmuteTried = false;
        try { clearTimeout(overlay.unmuteCheck); } catch { /* ignore */ }
        overlay.unmuteCheck = 0;
        overlay.lastStAt = 0;
        overlay.standby = false;
        overlay.adActive = true;
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
    // A standby may win the race against Twitch's <video> element. Start the
    // hidden player anyway; positionOverlay() attaches it once the native
    // player exists. The normal ad path still waits for the native surface.
    if (!v && !standby) return;
    const extId = document.documentElement.getAttribute('data-ko-ext-id');
    const token = crypto.randomUUID();
    const frame = document.createElement('iframe');
    frame.id = 'ko-adfix';
    frame.dataset.koToken = token;
    frame.src = `chrome-extension://${extId}/player.html?m=hls&tw=1&token=${encodeURIComponent(token)}`;
    frame.title = 'Clean Twitch stream (ad bypass)';
    frame.setAttribute('allow', 'autoplay; fullscreen; encrypted-media');
    frame.allowFullscreen = true;
    // Keep the iframe composited while it is still invisible: `opacity:0`
    // made Chrome treat the clean player as occluded and hls.js never left
    // rs=0 (measured). 1% black over the native frame is imperceptible and
    // lets hls.js decode; on Playing we switch to opacity 1 and hide native.
    frame.style.cssText = 'position:fixed;z-index:2147483647;border:0;background:#000;opacity:0.01;pointer-events:none;left:0;top:0;width:100%;height:100%;';
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
    overlay.wasMuted = switchSource && typeof prevWasMuted === 'boolean'
      ? prevWasMuted
      : (overlay.held ? overlay.holdWasMuted : (v ? v.muted : false));
    overlay.wasVolume = switchSource && Number.isFinite(prevWasVolume)
      ? prevWasVolume
      : (overlay.held ? overlay.holdVolume : (v ? v.volume : 1));
    // A source switch inside a pod keeps the decision the user already made; a
    // new pod adopts it from the surface being replaced. ad-hold / the standby
    // adoption path refresh it from the DOM, because a standby is minted at
    // page load and can predate the user's mute.
    overlay.muteIntent = switchSource
      ? overlay.muteIntent
      : (overlay.held ? overlay.holdWasMuted : (v ? !!v.muted : overlay.muteIntent));
    overlay.held = false;
    overlay.startedAt = Date.now();
    overlay.ready = false;
    overlay.autoplayRetry = false;
    overlay.adEndTries = 0;
    overlay.playing = false;
    overlay.healthyTicks = 0;
    overlay.nudgeTries = 0;
    overlay.lastSt = null;
    overlay.catchupAt = 0;
    overlay.unmuteTried = false;
    try { clearTimeout(overlay.unmuteCheck); } catch { /* ignore */ }
    overlay.unmuteCheck = 0;
    overlay.lastStAt = 0;
    overlay.revealed = false;
    overlay.coldCover = false;
    try { clearTimeout(overlay.coldTimer); } catch { /* ignore */ }
    overlay.coldTimer = 0;
    overlay.nativeHidden = false;
    // A standby is a clean player that is already running behind the native
    // surface; it becomes an ad only when ad-hold/ad-start sets adActive.
    overlay.standby = !!standby;
    overlay.adActive = !standby;
    if (!switchSource) overlay.switchTries = 0;
    if (overlay.hideTimer) {
      try { clearTimeout(overlay.hideTimer); } catch { /* ignore */ }
      overlay.hideTimer = 0;
    }
    // Bounded fallback: if hls.js cannot reach a healthy Playing state, do not
    // reveal a black/frozen frame. Restore the native player instead. (A
    // standby must never reveal itself: it is invisible content, not an ad, so
    // it has no fallback timer.)
    // A cold pre-roll can start before the clean source has buffered anything
    // (jynxzi 2026-10-24: ad at 2.6s, prewarm.ok at 2.1s). The old 5s limit
    // stopped the overlay while it was still filling the 11s buffer, so the
    // whole first ad played. The frame stays hidden at 1% until healthy, so a
    // longer window costs no visible artifact; ad-end still stops it earlier.
    if (!standby) {
      overlay.hideTimer = setTimeout(() => {
        if (!overlay.frame || overlay.revealed) return;
        if (!overlay.playing) {
          adLog('overlay-no-playing', { reason: 'fallback-timeout' });
          stopAdOverlay('no-playing');
          return;
        }
        revealOverlay('fallback-timeout');
      }, 12000);
    }

    // Small, non-interactive indicator so the reduced-quality player is not
    // mistaken for a broken Twitch player. Positioned in positionOverlay().
    const badge = document.createElement('div');
    badge.id = 'ko-adfix-badge';
    badge.textContent = switchSource ? 'sem anúncio · trocando fonte limpa…' : 'sem anúncio · conectando fonte limpa…';
    badge.style.cssText =
      'position:fixed;z-index:2147483647;pointer-events:auto;cursor:pointer;display:none;' +
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
        overlaySend({ t: 'mute', m: true });
        overlaySend({ t: 'load', url: overlay.url });
        overlaySend({ t: 'play' });
        return;
      }
      if (m.t === 'ev' && m.e === 'hls') {
        bypassStats.lastHls = { d: m.d, fatal: m.fatal, url: m.url, at: Date.now() };
        if (m.fatal) bypassStats.errors++;
        // A visible clean player that stalls must not freeze forever over the
        // hidden native video. Give it a short chance to recover, then restore
        // the native surface. Standbys are ignored: they are invisible and
        // have their own timeout/probe path.
        if (!overlay.standby && m.d === 'bufferStalledError') {
          scheduleOverlayStall('bufferStalledError');
        }
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
        if (overlay.standby) {
          // A standby whose token went ad-only is useless. Tear it down and
          // probe a fresh clean master; the ad path remains normal meanwhile.
          stopAdOverlay('standby-ad-only');
          requestStandby(600, true);
          return;
        }
        if (overlay.badge) overlay.badge.textContent = 'sem anúncio · trocando fonte limpa…';
        // The current clean source is ad-only. If it is already visible and
        // freezes, the stall timer restores the native player instead of
        // leaving a frozen frame. The switch usually finishes first.
        if (overlay.revealed) scheduleOverlayStall('ad-only', 4000);
        try {
          bypassChannel?.postMessage({ type: 'need-source', page: pageId, channel: overlay.channel || null });
        } catch {
          /* overlay is optional */
        }
        return;
      }
      if (m.t === 'ev' && m.e === 'error') {
        bypassStats.errors++;
        if (overlay.standby) {
          stopAdOverlay('standby-player-error');
          requestStandby(2000, true);
          return;
        }
        stopAdOverlay('player-error');
        return;
      }
      if (m.t === 'ev' && m.e === 'firstframe') {
        // A standby stays hidden. Do not mark it ready from the first decoded
        // frame alone: hls.js can emit firstframe while still stalled at rs=2.
        // Readiness comes from a healthy `Playing` state below.
        if (overlay.standby && !overlay.adActive) {
          try { clearTimeout(overlay.watchdogTimer); } catch { /* ignore */ }
          overlay.watchdogTimer = 0;
          return;
        }
        // The clean player has produced its first frame, but it may not be
        // moving yet (`playing:false` was measured on the Necros source switch).
        // Revealing that frame hides the native player and leaves the user
        // with a frozen picture. Wait for Playing instead; the native/old clean
        // frame stays visible in the meantime.
        if (!overlay.playing) {
          adLog('firstframe-not-playing', { rs: 0 });
          scheduleOverlayStall('firstframe-not-playing');
          return;
        }
        revealOverlay('firstframe');
        return;
      }
      if (m.t === 'st' && m.st) {
        overlay.lastSt = m.st;
        overlay.lastStAt = Date.now();
        // A clean player that drifted behind live must not be revealed: the
        // user would see a delayed stream and a jump at ad-end. Seek forward
        // inside the live window, at most every 2s, and let the healthy gate
        // below hold the overlay hidden until latency is back under 20s.
        if (overlay.adActive && typeof m.st.lat === 'number' && m.st.lat > 20) {
          if (!overlay.catchupAt || Date.now() - overlay.catchupAt > 2000) {
            overlay.catchupAt = Date.now();
            overlaySend({ t: 'seek', s: Math.max(0, Number(m.st.pos) + m.st.lat - 3) });
            overlaySend({ t: 'play' });
            adLog('overlay-catchup', {
              lat: +m.st.lat.toFixed(1),
              pos: +Number(m.st.pos).toFixed(1),
            });
          }
        }
        if (m.st.state === 'Playing') {
          // HAVE_FUTURE_DATA plus four seconds of forward buffer is the minimum
          // that survived the ad-heavy 2026-10-23 channels without a freeze.
          // A stalled hls.js still reports state=Playing with rs=2 and buffered=0
          // (measured on the Necros long pod); a 2s buffer was not enough on
          // kimkataguiri (it drained one second after reveal). Keep the native
          // surface up until the clean player can survive several refreshes.
          const latOk = !overlay.adActive
            || typeof m.st.lat !== 'number'
            || m.st.lat <= 20;
          const healthy = latOk
            && (typeof m.st.rs !== 'number' || m.st.rs >= 3)
            && (typeof m.st.buffered !== 'number' || m.st.buffered >= 4);
          if (!healthy) {
            // A single healthy heartbeat is not enough. The 2026-10-23 run
            // revealed at a healthy tick and lost the buffer one second later;
            // mark the frame not-playing so a standby cannot be adopted from
            // stale state.
            overlay.healthyTicks = 0;
            overlay.playing = false;
            if (!overlay.lastUnhealthyLogAt || Date.now() - overlay.lastUnhealthyLogAt > 2000) {
              overlay.lastUnhealthyLogAt = Date.now();
              adLog('playing-not-healthy', { rs: m.st.rs, buffered: m.st.buffered, pos: m.st.pos });
            }
            if (!overlay.standby || m.st.pos > 2) scheduleOverlayStall('rs' + m.st.rs);
            return;
          }
          overlay.healthyTicks = (overlay.healthyTicks || 0) + 1;
          clearOverlayStall();
          const wasPlaying = overlay.playing;
          if (!overlay.playing) {
            // Require three consecutive healthy heartbeats before covering the
            // native surface. The clean source can report rs=4 once and then
            // drain to 0.04s while a hidden standby is still starting.
            if (overlay.healthyTicks < 3) return;
            overlay.playing = true;
          }
          try { clearTimeout(overlay.watchdogTimer); } catch { /* ignore */ }
          overlay.watchdogTimer = 0;
          if (overlay.standby && !overlay.adActive) {
            // Warm and hidden. Do not cover the native video or show a badge.
            if (!wasPlaying) bypassStats.standbyReady++;
            return;
          }
          // The clean player is actually running: now it is safe to cover the
          // native video. Before this point the native stays visible.
          revealOverlay('playing');
          if (overlay.badge) {
            const qn = m.st.q && m.st.q.name ? m.st.q.name : 'qualidade reduzida';
            overlay.badge.textContent = m.st.muted
              ? `sem anúncio · ${qn} · clique para som`
              : `sem anúncio · ${qn}`;
          }
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

    // Sound is restored on request: the native player is covered by the iframe,
    // so Twitch's own volume control is not reachable while the fallback is
    // active. A badge click is an explicit request and always counts. A generic
    // page click (chat, layout) only retries the autoplay unlock when the user
    // had sound on to begin with: it must never overrule a mute.
    const requestOverlaySound = (explicit) => {
      // Never unmute a hidden standby or a clean player that has not been
      // revealed. The standby runs 1.5-2s behind the native; unmuting it on a
      // click produced doubled/echoed audio (user report). Keep the handler
      // installed so the first click after reveal still unmutes.
      if (overlay.standby || !overlay.revealed) return;
      if (!explicit && overlay.muteIntent) return;
      overlay.muteIntent = false;
      overlay.unmuteTried = true;
      overlaySend({ t: 'mute', m: false });
      overlaySend({ t: 'play' });
      if (overlay.badge) overlay.badge.textContent = 'sem anúncio · qualidade reduzida';
      try { document.removeEventListener('pointerdown', overlay.unmuteHandler, true); } catch { /* ignore */ }
      overlay.unmuteHandler = null;
    };
    overlay.unmuteHandler = () => requestOverlaySound(false);
    try { document.addEventListener('pointerdown', overlay.unmuteHandler, true); } catch { /* ignore */ }
    try { badge.addEventListener('click', () => requestOverlaySound(true)); } catch { /* ignore */ }

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
    // normal stop. A standby is long-lived; 5min bounds its stale URL/token
    // while still covering many midrolls.
    overlay.timeoutTimer = setTimeout(
      () => stopAdOverlay(standby ? 'standby-timeout' : 'timeout'),
      (standby ? 300 : 180) * 1000
    );
    if (standby) {
      bypassStats.standbyStarts++;
      bypassStats.lastStandby = { type: 'start', channel: overlay.channel, at: Date.now() };
    } else {
      bypassStats.starts++;
      bypassStats.last = { type: 'start', channel: overlay.channel, at: Date.now() };
    }
    // The bridge may already be listening; the 'ready' handler covers a slow
    // iframe. Sending here too avoids a race on warm starts.
    setTimeout(() => {
      if (!overlay.frame) return;
      overlaySend({ t: 'mute', m: true });
      overlaySend({ t: 'load', url: overlay.url });
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
        // SPA channel switch: never reveal the previous channel's hidden
        // player. Drop it and fall through to the normal cold-start path.
        if (overlay.standby) {
          const sc = String(overlay.channel || '').toLowerCase();
          const pc = pageChannel();
          if (sc && pc && sc !== pc) stopAdOverlay('standby-channel-change');
        }
        if (overlay.frame && !overlay.standby) {
          try { clearTimeout(overlay.adEndTimer); } catch { /* ignore */ }
          overlay.adEndTimer = 0;
          overlay.adEndTries = 0;
          return;
        }
        if (overlay.held) return;
        // Warm standby: do NOT rewind the native. 0.8.26 rewound 5s here and
        // the user saw the live jump ~4s backwards right before the swap. The
        // standby is already at the live edge; the swap itself is 1-2ms.
        // The rewind remains only for the cold path, where the native has to
        // cover the hls.js segment fetch.
        const warmStandby = !!(overlay.standby && overlay.playing);
        if (!overlay.rewound) {
          overlay.rewound = true;
          if (warmStandby) {
            adLog('ad-rewind-skip', { reason: 'standby', seconds: AD_REWIND_SEC });
          } else {
            const rew = rewindNative(AD_REWIND_SEC);
            adLog('ad-rewind', { seconds: AD_REWIND_SEC, result: rew });
          }
        }
        const v = mainVideo();
        if (!v) return;
        overlay.held = true;
        overlay.holdWasMuted = v.muted;
        overlay.holdVolume = v.volume;
        // This is the takeover moment: whatever the user last decided about
        // sound applies to the clean player too. Refreshed here because a warm
        // standby was created at page load, before a later mute.
        if (!overlay.revealed) adoptNativeMute(v);
        // Mute immediately so the ad audio never plays. Do not hide the video
        // yet: the clean source is still being probed, and a black frame is
        // worse than one second of muted ad. startAdOverlay() covers it as
        // soon as the source is ready.
        try {
          v.muted = true;
        } catch {
          /* ignore */
        }
        overlay.adActive = true;
        // Cold preroll: the ad is already on screen and the clean source is
        // still minting. Cover the native now instead of showing the ad. The
        // badge explains the black/loading window; revealOverlay() finishes
        // when the clean player is healthy, and the 12s stall bound restores
        // the native if it never gets there (measured srdogg: reveal at 7.4s).
        if (overlay.frame && !overlay.revealed && !overlay.playing) {
          overlay.coldCover = true;
          try { overlay.frame.style.opacity = '1'; } catch { /* ignore */ }
          try { hideNativeVideos(); } catch { /* ignore */ }
          adLog('cold-cover', { reason: 'ad-hold', ct: +Number(v.currentTime || 0).toFixed(1) });
          try { clearTimeout(overlay.coldTimer); } catch { /* ignore */ }
          overlay.coldTimer = setTimeout(() => {
            if (overlay.coldCover && !overlay.revealed) stopAdOverlay('cold-cover-timeout');
          }, 12000);
        }
        // A warm standby is already playing the clean live edge. Reveal it
        // now: this is the 0s path. If it is still buffering, adopt it here:
        // adActive makes the Playing handler reveal it without waiting for
        // ad-start, which is one more round trip in the cold path.
        if (overlay.standby) {
          if (overlay.playing) revealOverlay('standby');
        }
        return;
      }
      if (msg.type === 'ad-start') {
        if (!AD_OVERLAY_ENABLED) return;
        if (overlay.frame && overlay.standby) {
          overlay.adActive = true;
          // ad-start can arrive without ad-hold; the mute decision still
          // belongs to the native surface being covered.
          if (!overlay.held && !overlay.revealed) adoptNativeMute(mainVideo());
          if (overlay.playing) {
            revealOverlay('standby');
            return;
          }
          // The standby was already buffering before ad-start. A young
          // standby has no chance, so rebuild almost immediately; an older
          // one is often one segment away from Playing, so give it enough
          // time to win before throwing away its decoded buffer.
          const standbyAge = Date.now() - (overlay.startedAt || 0);
          const graceMs = standbyAge >= 1200 ? 900 : 300;
          if (!overlay.adoptTimer) {
            overlay.adoptTimer = setTimeout(() => {
              overlay.adoptTimer = 0;
              if (!overlay.frame || !overlay.standby || !overlay.adActive || overlay.playing) return;
              startAdOverlay(msg.url, msg.channel, true);
            }, graceMs);
          }
          try {
            overlaySend({ t: 'play' });
          } catch {
            /* iframe may not be ready */
          }
          return;
        }
        if (overlay.frame && overlay.revealed) {
          if (msg.switch) startAdOverlay(msg.url, msg.channel, true);
          return;
        }
        startAdOverlay(msg.url, msg.channel, !!msg.switch);
        return;
      }
      if (msg.type === 'ad-end') {
        if (!AD_OVERLAY_ENABLED) return;
        finishAdOverlay();
        return;
      }
      if (msg.type === 'standby-start') {
        if (!AD_OVERLAY_ENABLED || !AD_STANDBY_ENABLED) return;
        // Ignore stale handoffs and never start over an ad, another overlay,
        // or a hidden tab. The worker re-posts on the next prewarm.
        if (msg.at && Date.now() - msg.at > 120000) return;
        const mc = String(msg.channel || '').toLowerCase();
        const pc = pageChannel();
        if (!mc || (pc && mc !== pc)) return;
        if (overlay.frame) {
          // SPA channel switch: the hidden player still shows the previous
          // channel. Replace it instead of revealing stale video on an ad.
          if (!overlay.standby) return;
          if (String(overlay.channel || '').toLowerCase() === mc) return;
          stopAdOverlay('standby-channel-change');
        }
        if (overlay.held || overlay.adActive) return;
        if (document.visibilityState !== 'visible') return;
        // Do not require the native <video> here: on a fast prewarm the clean
        // URL can be ready before Twitch creates its player. positionOverlay()
        // attaches the hidden frame once the native surface exists.
        startAdOverlay(msg.url, msg.channel, false, true);
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

  // Cold preroll: ask the worker to mint the clean source before Twitch asks
  // for the live master. The master hook is the earliest reliable point, but
  // it still lands after navigation; these retries cover the window where the
  // worker hook is still installing.
  if (isChannelPath()) {
    setTimeout(() => requestStandby(0), 200);
    setTimeout(() => requestStandby(0), 1000);
    setTimeout(() => requestStandby(0), 2500);
    setTimeout(() => requestStandby(0), 5000);
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
        } else if (msg.type === 'standby-request') {
          // Page asks for a hidden clean player (after ad-end, tab visible,
          // or a standby token went bad). Re-use a fresh prewarm or probe.
          const ch = msg.channel || lastChannel;
          if (!ch || adBypassActive || bypassBusy) return;
          if (msg.force && !prewarm.busy) {
            prewarm = { channel: null, url: null, at: 0, busy: false };
          }
          if (prewarm.channel === ch && prewarm.url && Date.now() - prewarm.at < PREWARM_TTL) {
            postBypass({ type: 'standby-start', channel: ch, url: prewarm.url });
          } else {
            prewarmCleanSource(ch);
          }
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
    async function findCleanHlsUrl(channel, preferFallback = false, prewarmMode = false, firstUrl = null, firstMaster = null) {
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
            // Cold preroll: the web token types are usually already ad-only,
            // and probing all of them costs ~9s before the overlay can start.
            // autoplay/android is the measured clean-during-SSAI type; start
            // with it (360p) so the ad is covered immediately. The overlay can
            // still switch to a web/HD type if this one goes ad-only.
            ['autoplay', 'android'],
            ['mobile_web', 'web'],
            ['popout', 'web'],
            ['site', 'web'],
            ['mobile', 'android'],
            ['embed', 'web'],
          ];
      let usedFirstUrl = false;
      for (const [playerType, platform] of types) {
        try {
          let url;
          let master = null;
          if (!usedFirstUrl && firstUrl) {
            url = firstUrl;
            master = firstMaster;
            usedFirstUrl = true;
          } else {
            url = await mintMasterUrl(channel, playerType, platform);
          }
          if (!url) continue;
          if (!master) {
            const mr = await realFetch(url, { credentials: 'omit' });
            if (!mr.ok) continue;
            master = await mr.text();
          }
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

    // Advertise a warm clean URL to the page. The page decides whether it can
    // start the hidden player (visible tab, no active ad/overlay). Never
    // advertise while an ad is being bypassed or probed.
    function postStandbyStart(channel, url) {
      if (!channel || !url) return;
      if (adBypassActive || bypassBusy) return;
      postBypass({ type: 'standby-start', channel, url });
    }

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
        // Prefer the source that is measured clean during SSAI. A web/HD
        // token can be clean before the pod and go ad-only mid-pod, which
        // forces another switch while the ad is on screen. autoplay/android
        // is lower quality but stays clean, so a switch lands on a source the
        // page can keep for the rest of the break.
        const url = await withTimeout(findCleanHlsUrl(channel || lastChannel, true, true), 10000);
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
          // prewarmMode starts with autoplay/android: it is the only measured
          // clean-during-SSAI type. Starting a hidden HD web token here is what
          // made the warm standby go ad-only in the middle of the Necros pod.
          //
          // Start the hidden player as soon as the autoplay master URL exists
          // and responds OK, before probing its first variant. hls.js fetches
          // that variant anyway and its own ad filter strips stitched
          // segments; the full probe below still verifies the URL for later
          // prewarm hits. On a cold preroll this moves the standby ~1s earlier.
          let fastUrl = null;
          let fastMaster = null;
          try {
            fastUrl = await withTimeout(mintMasterUrl(channel, 'autoplay', 'android'), 4000);
            // A minted URL can still 403 (offline channel, bad signature).
            // Check the master before handing it to the hidden player; this
            // is one round trip, not the full variant probe. Keep the body so
            // the probe below does not fetch the same master again.
            if (fastUrl) {
              const mr = await withTimeout(realFetch(fastUrl, { credentials: 'omit' }), 4000);
              if (mr && mr.ok) fastMaster = await mr.text();
              else fastUrl = null;
            }
          } catch {
            fastUrl = null;
            fastMaster = null;
          }
          if (fastUrl) {
            // Keep `busy` set: the full probe is still running. Only the URL
            // is published early so the page can start its hidden player.
            prewarm = { channel, url: fastUrl, at: Date.now(), busy: true };
            debugLog('prewarm.fast', { channel });
            postStandbyStart(channel, fastUrl);
          }
          const url = await withTimeout(findCleanHlsUrl(channel, true, true, fastUrl, fastMaster), 8000);
          if (url) {
            prewarm = { channel, url, at: Date.now(), busy: false };
            debugLog('prewarm.ok', { channel });
            if (!fastUrl) postStandbyStart(channel, url);
          } else {
            prewarm = { channel: null, url: null, at: 0, busy: false };
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
          // The page-load prewarm is still in flight. On a cold preroll it
          // usually needs 3-5s, and the ad is visible for that whole wait.
          // Give it only 800ms, then start the autoplay 360p source; the
          // prewarm can still populate `prewarm` for the next ad.
          await withTimeout(prewarmPromise, 800);
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
          // Fallback prewarm for SPA channel switches and for pages where the
          // document_start request did not reach the worker. A plain cold open
          // already asked from the pathname before this master arrived.
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
