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
(() => {
  if (window.__koTwitchAdblock) return;
  window.__koTwitchAdblock = true;

  const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
  const GQL_HASH = 'ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9';
  const GQL_URL = 'https://gql.twitch.tv/gql';
  const PLAYER_TYPE = 'popout'; // clean token type; "embed" is the ad-bearing one
  const stats = { rewrites: 0, workerHooks: 0, workerFailures: 0 };
  window.__koTwitchAdblockStats = stats;

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
    const realFetch = self.fetch.bind(self);
    const cleanCache = new Map();

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
      if (!m) return null;
      const channel = decodeURIComponent(m[1]);
      const cached = cleanCache.get(channel);
      if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.text;
      const device = Array.from({ length: 32 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('');
      const body = {
        operationName: 'PlaybackAccessToken',
        variables: { isLive: true, login: channel, isVod: false, vodID: '', playerType: __KO_PLAYER_TYPE, platform: 'web' },
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
      const u = new URL(url);
      u.searchParams.set('sig', token.signature);
      u.searchParams.set('token', token.value);
      const mr = await realFetch(u.toString(), { credentials: 'omit' });
      if (!mr.ok) return null;
      const text = await mr.text();
      cleanCache.set(channel, { text, at: Date.now() });
      return text;
    }

    self.fetch = async function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      try {
        // Clean picture-by-picture masters too. Twitch's 2025 SDA ads can
        // arrive on that player type; skipping them let a PBP master through
        // even though the page token itself had been rewritten to popout.
        if (typeof url === 'string' && url.includes('/channel/hls/')) {
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
          const clean = stripAds(text);
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
              'const __KO_PLAYER_TYPE=' + JSON.stringify(PLAYER_TYPE) + ';';
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
