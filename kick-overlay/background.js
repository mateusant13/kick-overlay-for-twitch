// Kick Overlay — service worker.
// Resolves a YouTube channel URL (@handle / channel/UC... / bare UC...) to
// its UC... channel id by fetching the channel page (host_permission grants
// the cross-origin fetch the content script does not have). The live embed
// (youtube.com/embed/live_stream) only accepts the UC... id, not handles.
'use strict';

const YT_ID_RE = /UC[0-9A-Za-z_-]{22}/;
const YT_VIDEO_RE = /(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|live\/|embed\/|shorts\/)|youtu\.be\/)([0-9A-Za-z_-]{11})(?:[?&#/]|$)/i;

// A direct live/video reference gets a video id; channel references do not.
// "video:<id>" is the escape hatch for a bare id (a bare 11-char string is
// otherwise indistinguishable from a channel handle).
function ytVideoIdFromRef(value) {
  const v = String(value || '').trim();
  if (!v) return null;
  if (v.toLowerCase().startsWith('video:')) {
    const id = v.slice(6).trim();
    return /^[0-9A-Za-z_-]{11}$/.test(id) ? id : null;
  }
  const m = v.match(YT_VIDEO_RE);
  return m ? m[1] : null;
}

function normalizeYtUrl(value) {
  let v = (value || '').trim();
  if (!v) return null;
  const direct = ytVideoIdFromRef(v);
  if (direct) return `https://www.youtube.com/watch?v=${direct}`;
  if (YT_ID_RE.test(v) && v.startsWith('UC')) return `https://www.youtube.com/channel/${v}`;
  const m = v.match(/youtube\.com\/(@[^/?#]+|channel\/UC[0-9A-Za-z_-]{22}|c\/[^/?#]+|user\/[^/?#]+)/i);
  if (m) return `https://www.youtube.com/${m[1]}`;
  if (v.startsWith('@')) return `https://www.youtube.com/${v}`;
  // Bare handle without @ (e.g. "JBSniperPRIME") — the popup hint says
  // "URL, @handle or UC…", but users type the plain name; resolve it anyway.
  if (/^[0-9A-Za-z._-]{2,64}$/.test(v)) return `https://www.youtube.com/@${v}`;
  return null;
}

// ---- YouTube live HLS bypass ------------------------------------------------
// The live_stream embed (and the IFrame API) cannot initialize on bot-gated /
// cookieless sessions: the server bakes an error config ("Erro 153") into the
// embed page and the player never issues an innertube player request.
//
// The player call itself is not enough: since YouTube's 2025/2026 PO-token
// rollout, MWEB and WEB manifests hand out segment URLs that GVS rejects with
// 403 (verified 2026-10-20: MWEB hlsManifestUrl 200, every media segment 403).
// The ANDROID client still returns an HLS manifest whose segments are 200 and
// playable in hls.js — including from the extension origin — without a pot.
// IOS adaptive URLs are also 206, but HLS keeps the existing bridge (muxed
// audio/video in one <video>) instead of adding a DASH/MSE + audio-mux stack.
const KO_ANDROID_VER = '20.10.38';
const KO_ANDROID_UA = `com.google.android.youtube/${KO_ANDROID_VER} (Linux; U; Android 14; en_US) gzip`;
const KO_ANDROID_TPL = {
  context: {
    client: {
      hl: 'pt',
      gl: 'BR',
      clientName: 'ANDROID',
      clientVersion: KO_ANDROID_VER,
      userAgent: KO_ANDROID_UA,
      osName: 'Android',
      osVersion: '14',
      androidSdkVersion: 34,
      deviceMake: 'Google',
      deviceModel: 'Pixel 8',
      originalUrl: 'https://www.youtube.com/',
      playerType: 'UNIPLAYER',
      timeZone: 'UTC',
      utcOffsetMinutes: 0
    },
    user: { lockedSafetyMode: false },
    request: { useSsl: true },
    clickTracking: {}
  },
  racyCheckOk: true,
  contentCheckOk: true
};
// The MWEB player API rejects the call without the page's signature timestamp
// (sts) — observed UNPLAYABLE "A página precisa ser atualizada" without it.
// Real-world diag: "sts not found" — the ytcfg field was RENAMED to uppercase
// "STS" (verified: watch page ytcfg carries "STS":20676; lowercase is legacy).
const KO_STS_RE = /"STS":\s*(\d+)/;
const KO_STS_LEGACY_RE = /"sts":\s*(\d+)/;
const KO_VD_RE = /"visitorData":"([^"]+)"/;
const KO_VER_RE = /"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"/;
const KO_VID_RE = /[?&]v=([0-9A-Za-z_-]{11})/;

async function koFetchText(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

// The channel's /live page does not always redirect to a watch URL (verified
// 2026-10-20: /channel/UC…/live returned 200 with no canonical). The live
// video id is still in the HTML inside the player's videoDetails, right
// before "isLive":true. Prefer the canonical/watch URL when present, then the
// videoId nearest the first live marker. A most-frequent fallback would pick a
// recommendation, so it is deliberately NOT used.
async function koLiveVideoId(channelRef) {
  const direct = ytVideoIdFromRef(channelRef);
  if (direct) return direct;
  const base = channelRef.startsWith('UC')
    ? `https://www.youtube.com/channel/${channelRef}/live`
    : `https://www.youtube.com/${channelRef}/live`;
  const r = await fetch(base, { credentials: 'omit', redirect: 'follow' });
  if (!r.ok) return null;
  const m = r.url.match(KO_VID_RE);
  if (m) return m[1];
  const html = await r.text();
  const c = html.match(/<link rel="canonical" href="[^"]*watch\?v=([0-9A-Za-z_-]{11})/);
  if (c) return c[1];
  const liveAt = html.search(/"isLive":\s*true/);
  if (liveAt >= 0) {
    const before = html.slice(Math.max(0, liveAt - 4000), liveAt);
    const ids = [...before.matchAll(/"videoId":"([0-9A-Za-z_-]{11})"/g)];
    if (ids.length) return ids[ids.length - 1][1];
  }
  const vd = html.match(/"videoDetails":\{[^}]{0,2000}?"videoId":"([0-9A-Za-z_-]{11})"/);
  return vd ? vd[1] : null;
}

// Cache the resolved manifest per video id — the URL is valid for hours and
// re-resolving on every probe would hammer innertube.
const KO_HLS_CACHE = new Map(); // videoId -> { url, at }
const KO_HLS_TTL_MS = 5 * 60 * 1000;

async function koMintManifest(videoId) {
  const cached = KO_HLS_CACHE.get(videoId);
  if (cached && Date.now() - cached.at < KO_HLS_TTL_MS) return cached.url;
  // 1) A fresh visitor id (the mobile home page is still the cheapest source).
  const cfg = await koFetchText('https://m.youtube.com/?hl=pt&gl=BR');
  const vd = (cfg.match(KO_VD_RE) || [])[1];
  if (!vd) throw new Error('visitorData parse fail');
  // 2) Signature timestamp from the watch page ytcfg.
  const watch = await koFetchText(`https://www.youtube.com/watch?v=${videoId}`);
  const sts = (watch.match(KO_STS_RE) || watch.match(KO_STS_LEGACY_RE) || [])[1];
  if (!sts) throw new Error('sts not found');
  // 3) ANDROID player API call (anonymous). Its HLS segments are pot-free;
  // MWEB/WEB segments are 403 on the same IP (see the comment above).
  const body = JSON.parse(JSON.stringify(KO_ANDROID_TPL));
  body.context.client.visitorData = vd;
  body.playbackContext = { contentPlaybackContext: { html5Preference: 'HTML5_PREF_WANTS', signatureTimestamp: Number(sts) } };
  body.videoId = videoId;
  const pr = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Youtube-Client-Name': '3',
      'X-Youtube-Client-Version': KO_ANDROID_VER,
      'X-Goog-Visitor-Id': vd
    },
    body: JSON.stringify(body)
  });
  const j = await pr.json();
  const url = j && j.streamingData && j.streamingData.hlsManifestUrl;
  if (!url) throw new Error(`player ${(j && j.playabilityStatus && j.playabilityStatus.status) || pr.status}`);
  KO_HLS_CACHE.set(videoId, { url, at: Date.now() });
  return url;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.__koDiag) {
    // Keep debug telemetry inside the extension; never forward page data to a
    // local relay or other process.
    console.debug('[ko]', String(msg.__koDiag.ev || 'diag').slice(0, 80));
    return;
  }
  if (msg && msg.type === 'ko-yt-play') {
    const raw = msg.channelRef || '';
    const direct = ytVideoIdFromRef(raw);
    if (direct) {
      koMintManifest(direct)
        .then((url) => sendResponse({ url, videoId: direct }))
        .catch((e) => sendResponse({ error: String((e && e.message) || e).slice(0, 120) }));
      return true;
    }
    const normalized = normalizeYtUrl(raw);
    if (!normalized) {
      sendResponse({ url: null, error: 'bad-url' });
      return;
    }
    const channelRef = normalized.replace('https://www.youtube.com/', '');
    koLiveVideoId(channelRef)
      .then((videoId) => (videoId ? koMintManifest(videoId) : Promise.reject(new Error('no live video'))))
      .then((url) => sendResponse({ url }))
      .catch((e) => sendResponse({ error: String((e && e.message) || e).slice(0, 120) }));
    return true; // async sendResponse
  }
  if (!msg || msg.type !== 'ko-resolve-yt') return;
  const direct = ytVideoIdFromRef(msg.value || '');
  const url = direct ? `https://www.youtube.com/watch?v=${direct}` : normalizeYtUrl(msg.value);
  if (!url) {
    sendResponse({ id: null, error: 'bad-url' });
    return;
  }
  // credentials 'omit': the anonymous page carries the UC id (curl-verified);
  // the logged-in variant can redirect to the consent wall and break the match.
  fetch(url, { credentials: 'omit' })
    .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((html) => {
      const m =
        html.match(/"externalId":"(UC[0-9A-Za-z_-]{22})"/) ||
        html.match(/"channelId":"(UC[0-9A-Za-z_-]{22})"/) ||
        html.match(/"browseId":"(UC[0-9A-Za-z_-]{22})"/);
      sendResponse({ id: m ? m[1] : null, videoId: direct || null, error: m ? null : 'not-found' });
    })
    .catch((e) => sendResponse({ id: null, videoId: direct || null, error: String(e).slice(0, 80) }));
  return true; // async sendResponse
});

// ---- Twitch proxy mode (HD, no SSAI ads) -----------------------------------
// Twitch makes the SSAI decision from the egress IP/region of the playlist
// request. A proxy in an ad-free region returns a clean HD playlist; the video
// segments still go direct. This PAC routes ONLY the playlist/usher/GQL hosts,
// so normal browsing and the video bytes never touch the proxy.
const KO_PROXY_KEY = 'ko.twitchProxy';
const KO_PROXY_APPLIED = 'ko.twitchProxyApplied';
const KO_PROXY_ROUTES = [
  'usher.ttvnw.net',
  'gql.twitch.tv',
  '*.playlist.ttvnw.net',
  '*.playlist.live-video.net',
];

function koPac(proxyHost, proxyPort) {
  const routes = KO_PROXY_ROUTES.map((h) =>
    h.startsWith('*.') ? `shExpMatch(host, '${h}')` : `host === '${h}'`,
  ).join(' ||\n      ');
  return (
    'function FindProxyForURL(url, host) {\n' +
    '  host = host.toLowerCase();\n' +
    '  if (\n' +
    `      ${routes}\n` +
    '  ) {\n' +
    `    return 'PROXY ${proxyHost}:${proxyPort}; DIRECT';\n` +
    '  }\n' +
    '  return \'DIRECT\';\n' +
    '}\n'
  );
}

async function koApplyProxy() {
  let p = {};
  let applied = false;
  try {
    const o = await chrome.storage.local.get([KO_PROXY_KEY, KO_PROXY_APPLIED]);
    p = o[KO_PROXY_KEY] || {};
    applied = !!o[KO_PROXY_APPLIED];
  } catch {
    return;
  }
  if (!p.enabled || !p.host) {
    if (!applied) return; // never touch a proxy we did not set
    try {
      await chrome.proxy.settings.clear({ scope: 'regular' });
    } catch {
      /* policy/other extension owns it */
    }
    try {
      await chrome.storage.local.remove(KO_PROXY_APPLIED);
    } catch {
      /* ignore */
    }
    return;
  }
  const proxyHost = String(p.host)
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .trim();
  const proxyPort = Number(p.port) || 8899;
  if (!proxyHost) return;
  try {
    await chrome.proxy.settings.set({
      value: { mode: 'pac_script', pacScript: { data: koPac(proxyHost, proxyPort) } },
      scope: 'regular',
    });
    await chrome.storage.local.set({ [KO_PROXY_APPLIED]: true });
  } catch (e) {
    console.warn('[ko] proxy set failed', String((e && e.message) || e).slice(0, 120));
  }
}

koApplyProxy();
chrome.runtime.onInstalled.addListener(koApplyProxy);
chrome.runtime.onStartup.addListener(koApplyProxy);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[KO_PROXY_KEY]) koApplyProxy();
});

// Supply basic-auth credentials for the Twitch proxy without a Chrome prompt.
try {
  chrome.webRequest.onAuthRequired.addListener(
    (details, callback) => {
      if (!details.isProxy) {
        callback({});
        return;
      }
      let done = false;
      const finish = (r) => {
        if (done) return;
        done = true;
        callback(r);
      };
      // Never leave Chrome's auth request hanging.
      setTimeout(() => finish({}), 1500);
      chrome.storage.local.get(KO_PROXY_KEY, (o) => {
        const p = (o && o[KO_PROXY_KEY]) || {};
        if (!p.enabled || !p.user) {
          finish({});
          return;
        }
        finish({ authCredentials: { username: String(p.user), password: String(p.pass || '') } });
      });
    },
    {
      urls: [
        'https://usher.ttvnw.net/*',
        'https://gql.twitch.tv/*',
        'https://*.playlist.ttvnw.net/*',
        'https://*.playlist.live-video.net/*',
      ],
    },
    ['asyncBlocking'],
  );
} catch (e) {
  console.warn('[ko] proxy auth listener failed', String((e && e.message) || e).slice(0, 120));
}
