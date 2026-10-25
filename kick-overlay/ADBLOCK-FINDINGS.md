# Twitch adblock — investigation log (for a future zero-context session)

Last updated: 2026-10-25. Chrome 155 / Edge 155, extension **0.8.35**, persistent profile
(`C:\Users\Administrador\Desktop\Nova pasta (3)\TESTE\VOD.RIP\vendor\kick-overlay`),
CDP port 9222 (user Chrome) and 9335 (separate Edge test harness). Channels used for repro: `twitch.tv/duda` (pre-roll appears most
reloads), `twitch.tv/zerggyyyy` (midroll after ~3 min), `twitch.tv/vegas`
(midroll/preroll), `twitch.tv/Necros` (long real pod during 0.8.26 work).

Read this before touching `twitch-adblock.js` again. Several "obvious" fixes
were already tried and measured; do not repeat them without new evidence.
Ad-time HD source options are tracked separately in
`kick-overlay/ADBLOCK-HD-RESEARCH.md`.

---

## 1. TL;DR

- The extension **does** rewrite the playback token to `playerType:"popout"`
  (`stats.lastPlayerType` proves it) and **does** hook the player worker
  (`workerHooks:2`). Ads still play.
- Token payloads for **every** player type still say `show_ads:true`,
  `server_ads:true`, `hide_ads:false` (measured below). Token rewriting alone
  cannot switch ads off.
- The observed ad is the **picture-by-picture (PBP) / stream-display-ad**
  format:
  - main `<video>` (1340x751) plays the ad,
  - a second `<video>` (340x191, paused, readyState 0) holds the stream,
  - `.stream-display-ad__wrapper...__hidden` exists but is 0x0,
  - UI shows `Anúncio (0:12)`, `Saiba mais`, DSA button.
- Blocking, at the network layer, **all** of:
  `*client-side-video-ads*`, `*amazon-adsystem*`, `*ads.twitch.tv*`,
  `*tq-tungsten*`, `*media-amazon*` did **not** stop the pre-roll.
  (CDP `Network.setBlockedURLs`, cache disabled, fresh navigation; 7 requests
  blocked, ad still present at t=0s.)
- No GQL operation requests the ad itself. `AdRequestHandling` only returns
  channel ad properties; `ConnectAdIdentityMutation` returns an Amazon
  identity URL. There is no `VideoAdRequest` / `AdFormat` operation.
- CDP never sees the ad creative or the HLS `.m3u8` requests: no playback
  `worker` targets attach, `playlists` arrived empty. The ad media is invisible
  to page-level Network, so it is almost certainly fetched inside the blob
  worker (or is stitched by the server).
- **BREAKTHROUGH (same day):** instrumenting the player worker showed the ad
  really is **stitched into an all-ad media playlist**:
  `#EXTINF:2.002,Amazon|...` x3-4, `CLASS="twitch-stitched-ad"`. The old
  `stripAds()` removed every ad line, then hit its all-ad guard and returned
  the original text unchanged (`changed:false`). That guard is why the ad
  played despite all the token/worker machinery appearing healthy.
- Tried a fallback: when an all-ad playlist arrives, mint a **fresh master
  with another player type** and serve one of its clean media playlists.
  `autoplay/android` was clean (15 content segments, no ads), but its MSE
  output is **not playable in the web player**: the ad UI went away and the
  video stayed paused at `readyState:1` forever. All web-container types are
  ad-only during the ad window. The fallback is therefore **disabled**
  (`ALL_AD_FALLBACK = false`); letting an ad play is better than a dead player.
- PBP-content promotion also failed: the second `<video>` is an empty
  placeholder (`rs:0`, no source) at ad time.
- Consequence: keep working **inside the player worker**; DNR and token flags
  are not the fix. A real fix needs a clean, web-compatible SSE/playlist
  source (proxy, or a future Twitch token/ad flag change).

---

## 1.1 0.8.15 solution: clean HLS overlay (READ THIS FIRST)

The all-ad fallback in section 2.8 is still disabled. 0.8.15 uses a **separate
hls.js video** instead of feeding a foreign playlist into Twitch's MSE.

Flow (measured on `vegas`, 2026-10-20 23:38 local):

1. The wrapped player worker sees a media playlist with **any** stitched ad
   (`adExtinf > 0`), not only an all-ad preroll. Midrolls can be mixed, e.g.
   `51` ad `#EXTINF` lines + `1` content line in the same refresh.
2. Worker posts `ad-hold` on `BroadcastChannel('ko-adblock-bypass')`. The page
   script hides/mutes **all** native `<video>` elements and shows a clean
   hls.js iframe over the player. Hiding the native video is required: with it
   visible, hls.js stalled forever at `rs=0 ns=2` on channel pages.
3. Worker probes masters in this order: `site/web`, `popout/web`,
   `mobile/android`, `autoplay/android`. It fetches the first video rendition
   and returns the first master whose playlist has `adExtinf == 0`.
   - During the measured preroll, every web/mobile type was still ad-only;
     `autoplay/android` was clean but only **160p/360p**.
   - Outside the ad window, `site/web` is a normal 1080p/720p master and
     hls.js plays it (verified in isolation). No clean **HD** source has been
     found during an ad window yet.
4. Overlay plays via `player.html?m=hls`; native player stays muted/hidden and
   continues its own timeline. `ad-end` is sent only after **two consecutive
   clean playlists**, then the page waits (max 3s) for Twitch's ad DOM to clear.
   Native `visibility`/`muted` are restored.
5. `ALL_AD_FALLBACK` stays `false`; no foreign MSE is injected into the player.
6. `BroadcastChannel` is origin-wide, so every worker now carries a random
   `pageId`; a page ignores messages from another tab. Without this, an ad in
   one Twitch tab started the overlay in every other tab (observed).
7. **0.8.16/0.8.17:** the clean source can turn ad-only on a later refresh
   (measured on `necros`). `player-bridge.js` filters ad segments out of every
   `*.ttvnw.net` media playlist with an hls.js `pLoader` before hls.js parses
   it. If the whole playlist is ads, it signals `ad-only`; the page asks the
   worker for another type (`autoplay/android` first) and reloads the same
   overlay iframe. See section 2.11.

Measured real-ad run (`vegas`, midroll/preroll):

```
ext=ojd... adfix=true starts=1
bypass.probe site/web      adExtinf=3   (ad-only)
bypass.probe mobile/android adExtinf=3  (ad-only)
bypass.probe autoplay/android adExtinf=0 (clean)
bypass.probe ... overlay state=Playing, 360p
playlist: extinf 14, adExtinf 0 (clean)
stops=1, native visibility restored
```

Known limits:
- The reliable clean stream during an ad is **360p**.
- The hold/mint can leave ~1-5s of black player before the clean stream starts.
- If every probed type is ad-only, the overlay fails and the native ad is
  restored (`ad-fail`), so the ad is not blocked in that case.
- Chrome may block unmuted autoplay in the iframe; the code retries muted and
  exposes native controls, so the user can unmute.

Do **not** re-enable `ALL_AD_FALLBACK` or feed `autoplay` into the Twitch
player's MSE. That was measured to leave the player permanently paused.

---

## 1.2 0.8.18: overlay disabled (user requirement: no player change)

The user's report after 0.8.17:

> travou a live. mudou o player, q e algo q tu implementou, e travou. nao era
> pra mudar. era pra ser smooth

0.8.17's mid-ad `ad-only` path tore the iframe down and recreated it with
`autoplay/android`. That is the change they saw: a 360p hls.js player with
Chrome controls replacing the Twitch player, plus a rebuffer/stall around the
switch. 0.8.16 was no better (hls.js sat in `Buffering` ~40s on an ad-only
refresh).

0.8.18 therefore ships `AD_OVERLAY_ENABLED = false`:

- `ad-hold` / `ad-start` / `ad-end` / `ad-fail` no longer hide, mute, or cover
  the native player. The Twitch `<video>` and its controls are untouched, so
  seek/fullscreen/quality keep working and nothing can freeze on a switch.
- The worker still records every ad playlist (`workerPlaylistLog`) and still
  strips ad lines from native playlists (so mixed playlists lose future ad
  segments), but it no longer mints/probes clean sources during an ad.
- The HLS overlay code remains for the opt-in path (Kick/YouTube layers still
  use `player.html`/`player-bridge.js`); only the automatic Twitch-ad overlay
  is off.

Trade-off: with the overlay off, an all-ad playlist can still play natively.
The next step is the one thing not yet measured: whether some token
type/platform is **clean during an ad AND HD**. If one is, the native player
can be pointed at it directly (no overlay at all), which satisfies both
"no ads" and "no player change". `G:\Temp\opencode\ko-necros-ad-matrix.mjs`
watches the `necros` tab and probes all 21 type/platform pairs the moment the
page reports an ad; results go to `G:\Temp\opencode\necros-ad-matrix.log`.

---

## 1.3 0.8.19: proxy mode (HD, native player, no SSAI)

The user chose the only path that can satisfy **HD + no ads + native player**:
a TTV LOL PRO-style egress proxy. Twitch decides SSAI from the **egress
IP/region of the playlist request**, so a proxy in a region where Twitch does
not fill ads returns a clean HD playlist. Video segments stay direct; only the
playlist/usher/GQL traffic goes through the proxy (a few MB per session).

Implementation:

- `twitch-proxy/ko-proxy.mjs` — dependency-free HTTP CONNECT proxy with basic
  auth, optional IP allowlist, `/health`, systemd installer (`install.sh`) and
  README. No ad stripping: the clean playlist comes from the proxy's region.
- `kick-overlay/background.js` — `chrome.proxy` PAC (scope `regular`) routes
  only:
  `usher.ttvnw.net`, `gql.twitch.tv`, `*.playlist.ttvnw.net`,
  `*.playlist.live-video.net`. Everything else is `DIRECT`, including the video
  segments. `PROXY …; DIRECT` so a dead proxy falls back to normal playback
  instead of a black player.
- Proxy basic auth is supplied through
  `chrome.webRequest.onAuthRequired` (`webRequestAuthProvider`), so Chrome never
  prompts. The PAC is only cleared when this extension set it (`ko.twitchProxyApplied`).
- `popup.html/js` — `Proxy HD (sem ads)` checkbox, `host:port`, user/pass,
  save. Editable from any page.

Verified locally (2026-10-21):

- Set `{enabled:true, host:'127.0.0.1', port:8899}` via the service worker;
  `chrome.proxy.settings.get` returned the expected `pac_script`.
- Reloaded `necros`; the proxy log showed
  `CONNECT gql.twitch.tv:443`, `CONNECT usher.ttvnw.net:443`,
  `CONNECT sae13.playlist.ttvnw.net:443`; the worker's playlist was
  `extinf:14, adExtinf:0`; no `#ko-adfix`, native `<video>` present.
- Disabling the checkbox returned `chrome.proxy.settings.get` to
  `{mode:"system"}` (no leftover browser proxy).
- Local egress is Brazil, so this proves routing/compatibility, **not** ad
  removal. Ad removal needs the VPS in an ad-free region.

Known trade-offs:

- All `gql.twitch.tv` traffic is proxied (PAC cannot inspect GQL operation
  names), so UI/chat latency follows the proxy's latency. If that is a problem,
  add a body-aware GQL redirect later.
- A VPS in a region Twitch has flagged can return "Commercial break in
  progress"; move region/provider if so.
- The proxy is a public service: keep basic auth on and firewall the port.

---

## 2. What is known about Twitch's ad pipeline (measured)

### 2.1 Token

The page mints `PlaybackAccessToken` through GQL. The extension rewrites
`variables.playerType` to `popout`. Captured token (duda, 2026-10-20) still
contains:

```json
{"adblock":false,"hide_ads":false,"server_ads":true,"show_ads":true,
 "platform":"web","player_type":"popout","turbo":false}
```

Token probe (same hash `ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9`)
for `duda`:

| playerType | platform | show_ads | server_ads | hide_ads | adblock |
|---|---|---|---|---|---|
| site | web | true | true | false | false |
| popout | web | true | true | false | false |
| embed | web | true | true | false | false |
| autoplay | android | true | true | false | false |
| autoplay | web | true | true | false | false |
| picture-by-picture | web | true | true | false | false |
| mobile | android | true | true | false | false |
| android | android | true | true | false | false |

**Conclusion:** the "clean player type" trick no longer produces ad-free
tokens on this IP/account. The flags are server-controlled.

### 2.2 GQL operations observed during an ad

`window.fetch` + XHR hook at document_start captured 188 operations. Ad-ish
ones and their payloads:

- `AdRequestHandling` → `currentUser.hasTurbo:false` plus
  `user.adProperties`:
  `{adServerDefault:"VAES", hasPrerollsDisabled:false,
    hasPostrollsDisabled:false, hasVodAdsEnabled:true,
    vodArchiveMidrolls:"inserted"}`.
- `Ads_Components_AdManager_User` → `{id, hasTurbo:false}`.
- `ConnectAdIdentityMutation` → `identityURL:
  "https://s.amazon-adsystem.com/iu3?cs=<device>&cu=<user>&d=twitch.tv&pid=..."`.
- `VideoAdBanner` → channel user only.
- `AdContextChannelIDQuery` → channel id only.
- `PlayerTrackingContextQuery`, `VideoPlayer_VideoSourceManager` → no ad data.
- **No** `VideoAdRequest`, `AdFormatRequest`, `AdRequest` mutation/query.
  Therefore the ad request is not a page-level GQL call.

### 2.3 Network seen during an ad

Only Amazon/Twitch telemetry, never a creative or VAST:

- `https://www.twitch.tv/r/ts/?s=...` (OMSDK / Amazon ad telemetry)
- `https://www.twitch.tv/r/ts/rs/vue/omsdk-video/ev/csmv4.js?...`
- `https://www.twitch.tv/r/ts/rs/tq-forensics/adforensics_basicv3.js?...`
- `https://www.twitch.tv/r/ts/rs/tq-devices/om-attest-device.js?...`
- `https://sq-tungsten-ts.amazon-adsystem.com/noop?...`
- `https://www.btd-cmh.tq-tungsten.com/collect/twitchEvent`
- `https://www.twitch.tv/r/c/95650408/x/px/...` (impression pixel)
- `https://s.amazon-adsystem.com/iu3?...` (identity sync)

No `m.media-amazon.com` video, no `aax-.../e/dtb/bid` tag captured at page
level. `getResponseBody` for `.m3u8` never fired: **0 playlists visible**.

### 2.4 DOM at ad time (`duda`)

```
video[0] aria="Player de vídeo da Twitch"
  src="" currentSrc="" paused=false readyState=4
  rect 1340x751  parent: .video-player__container.seventv-player
video[1] aria=null
  src="" currentSrc="" paused=true readyState=0
  rect 340x191   parent: ScAspectRatio... tw-aspect
.stream-display-ad__wrapper.stream-display-ad__wrapper_squeezeback
  .stream-display-ad__wrapper-hidden  rect 0x0
```

So the **ad is in the main video** and the **content is the paused PBP
video**. The hidden SDA wrapper is only the lower-third container; it is not
the ad being shown. `sevenTV` (7TV extension) is present in the class list.

### 2.5 Block test (negative result)

CDP, fresh navigation to `duda`, `Network.setCacheDisabled(true)`:

```js
Network.setBlockedURLs({urls:[
  '*client-side-video-ads*',
  '*amazon-adsystem*',
  '*ads.twitch.tv*',
  '*tq-tungsten*',
  '*media-amazon*'
]})
```

Blocked 7 requests (the CSAI JS+CSS, `s.amazon-adsystem.com`,
`sq-tungsten-ts...`, two `/r/ts/` telemetry URLs, two identity syncs).
**Ad still played at t=0** with main video `paused:false`, `readyState:4`,
`currentTime:3.2`, stats `rewrites:1`, `workerHooks:2`. This is the strongest
evidence that the ad is **not** loaded by the blocked client-side ad chunk on
this run, or that it is already stitched into the media pipeline.

### 2.6 Worker digest — the actual root cause (2026-10-20, later)

Added `BroadcastChannel('ko-adblock-debug')` to the wrapped worker. It posts a
digest of every playlist (counts, ad-only flag, first 1200 chars). Observed
pre-roll on `duda`:

```
# master: usher.ttvnw.net/api/v2/channel/hls/duda.m3u8
len 11808, extinf 0, variants 5

# media playlist (preroll, sae12.playlist.ttvnw.net/v1/playlist/...)
len 19052, extinf 3, adExtinf 3, adOnly true, hasStitched true
#EXTINF:2.002,Amazon|580161099130987255   (x3)
#EXT-X-DATERANGE:ID="stitched-ad-..." CLASS="twitch-stitched-ad"
  X-TV-TWITCH-AD-ROLL-TYPE="PREROLL"
  X-TV-TWITCH-AD-AD-FORMAT="standard_video_ad"
  X-TV-TWITCH-AD-URL="https://aax-events...amazon-adsystem.com/..."
```

On the next refreshes: extinf 4, 5, ... 17, all ad; `changed:false`. Later,
`extinf 18 / ad 17`, `changed:true` (mixed ad + content) and the strip worked.
So:

- `stripAds()` detects and removes every `#EXTINF` lacking `,live`.
- For an **all-ad playlist**, it removes all segments and then the fallback
  `if (!out.some(EXTINF)) return text` deliberately returns the original.
  This is exactly the pre-roll window: Twitch serves a playlist containing
  **only ads**. Hence ads play.
- The ad is **SSAI**, not CSAI. The Amazon CSAI chunk and Amazon DNR are
  irrelevant to this path.

### 2.7 Clean-player-type probe (Node, anonymous token)

For `duda`, same minute, first 3 variants of each master:

| playerType | platform | media playlist result |
|---|---|---|
| site | web | 15 content, 0 ads |
| popout | web | 15 content, 0 ads |
| embed | web | 3-4 ads, 0 content |
| autoplay | android | 15 content, 0 ads |
| autoplay | web | 15 content, 0 ads |
| mobile | android | 15 content, 0 ads |
| picture-by-picture | web | 3-4 ads, 0 content |
| android | android | 15 content, 0 ads |

But during the **page's ad window**, the popout master minted inside the
worker still returned ad-only media playlists for all 5 variants (so simply
switching variants of the same master is not enough). A **fresh autoplay +
android** master did return clean content. This is the fallback now
implemented.

### 2.8 Fallback result

`cleanMediaFallback()` on an ad-only playlist:

1. cache hit for the channel -> return the cached clean media playlist;
2. otherwise probe token types: popout/web, autoplay/android,
   autoplay/web, site/web, mobile/android (once per 10s);
3. fetch up to 2 variants of each master, strip ads, require
   `contentCount > 0`;
4. cache the clean media playlist for 8s and serve it in place of the ad
   playlist.

Measured (`duda`, after reload, 45s monitoring):

```
probe.master popout/web variants 6
probe.media  ... content 0
probe.master autoplay/android variants 3
probe.media  ... content 15
probe.clean  { playerType: 'autoplay', platform: 'android', content: 15 }
playlist changed: 'adOnly->fallback'
ad UI: false for all 45s
video: paused:false readyState:4 currentTime 4.8 -> 15.1
```

The video was muted (autoplay policy after the source switch), but no ad was
shown. This is the first confirmed ad-free pre-roll.

### 2.9 Why the fallback is DISABLED in the shipped code

The 2.8 result was misleading: the ad UI disappeared, but the main `<video>`
stayed `paused:true rs:1` forever (no `buffered` ranges). Reproduced repeatedly:
`probe.clean autoplay/android content:15`, `changed:"adOnly->fallback"`, yet
the player never played. The autoplay/android media playlist uses an MSE
variant the web player cannot append (different container/codec/init segment).
Every web-container type (site, popout, mobile, android, all with
`platform:"web"` or `"android"`) is **ad-only during the ad window**, so there
is no clean, web-compatible playlist to swap in.

Also tested the PBP content player at ad time: the second `<video>` is an empty
placeholder (`rs:0 ns:0`, no `src`/`srcObject`, no child source); calling
`play()` hangs. It is not a usable bypass.

Decision (0.8.13): keep the all-ad fallback code for future work but set
`ALL_AD_FALLBACK = false`. Letting a normal ad play is bad, but leaving the
player permanently paused is worse. Remove the ineffective DNR blocks
(`amazon-adsystem`, `ads.twitch.tv`): they did not stop ads and could turn an
ad-click navigation into a blocked-page error.

### 2.10 Fullscreen rebuffer / stutter fix

`cleanMaster()` used to mint a second popout master for **every** master
request. Fullscreen/quality changes re-request the master, so this added a
GQL + usher round-trip and replaced the player's master, causing a visible
rebuffer/stutter. The page hook already rewrites the token to
`player_type:"popout" platform:"web"`, so `cleanMaster()` now decodes the
incoming token (`token` is URL-encoded JSON, not base64) and returns `null`
when it is already clean. The original master is passed through unchanged.

Repro note: the `token` usher query param is JSON, e.g.
`{"player_type":"popout","platform":"web",...}`. The old base64 decoder
returned `null` for every master, so the skip never happened before 0.8.13.

### 2.11 0.8.16: the clean source itself can turn into an ad

Measured on `necros` (2026-10-21): the overlay's own hls.js playlist changed
from clean to ad-bearing **after** the probe. The worker saw a clean
`site/web` media playlist (`adExtinf=0`) and started the overlay; seconds
later the same overlay URL returned:

```
#EXTINF:2.000,DCM|264402997
#EXTINF:2.000,DCM|...
#EXTINF:2.000,Amazon|...
```

The native player was hidden, so the user saw the overlay playing the ad. The
probe was not wrong; Twitch SSAI changed the playlist between refreshes. No
token type is immune: tokens for site/popout/mobile/autoplay all still say
`show_ads:true`.

Fix (0.8.16): `player-bridge.js` installs an hls.js `pLoader` that strips
Twitch ad segments from every media playlist **before hls.js parses it**. It
only touches `*.ttvnw.net` URLs, so the YouTube layer is unaffected. On an
ad-only refresh it returns the last clean live window (or an empty live
playlist on first load) instead of buffering the ad. This is a playlist-level
filter, not a UI hide: hls.js never receives the ad segment URLs.

Measured follow-up (0.8.16, `necros`, 17:59:30-18:00:14): the filter did stop
the ad (`adStrips` 22 -> 36, no ad segment requested), but hls.js stayed
`Buffering rs=0 ns=2 buffered=0` for ~40s and the overlay was stopped by its
60s timeout. The cached clean window is not enough once the live playlist is
ad-only: hls.js has no new fragments to append.

Fix (0.8.17): on the first ad-only refresh the bridge posts
`{t:'ev', e:'ad-only'}`. The page sends `need-source` to the worker; the
worker probes with `autoplay/android` first, then `mobile/android`, then the
web types, and posts a fresh `ad-start` that reloads the **same** overlay
iframe. `autoplay/android` is the type measured clean during SSAI ads and its
360p HLS plays in hls.js. This keeps the native player hidden and avoids both
the ad and the 40s black stall. A switch **tears down and recreates** the
iframe instead of calling `loadSource` on the wedged hls.js instance, and gets
a fresh 180s safety timeout. The old 60s timer was measured stopping a healthy
replacement source while the ad pod was still running.

---

## 3. Current extension behavior (0.8.16)

`kick-overlay/twitch-adblock.js`:

1. MAIN-world `fetch`/XHR hook rewrites every live `PlaybackAccessToken` body
   (`playerType:"popout"`, `platform:"web"`). Verified on the wire.
2. Wraps `window.Worker` for `blob:https://www.twitch.tv/*` sources; the
   replacement worker:
   - re-mints a popout master for any `/channel/hls/` URL (including PBP),
   - strips `#EXTINF` blocks that do **not** end in `,live`,
   - removes `#EXT-X-DATERANGE` with `twitch-stitched-ad` /
     `X-TV-TWITCH-AD-URL`, removes `#EXT-X-TWITCH-PREFETCH`,
   - rewrites ad tracking URLs in tags,
   - on **any** stitched ad, starts the clean hls.js overlay described in
     section 1.1,
   - sends `ad-end` after two consecutive clean playlists.
3. `stats` exposed as `window.__koTwitchAdblockStats` (`rewrites`,
   `workerHooks`, `workerFailures`, `lastPlayerType`, `pbpRewrites`,
   `adOnlySeen`, `pageId`, `adBypass`, `workerPlaylistLog`,
   `workerDebugLog`).
4. `adblock-bridge.js` mirrors `chrome.runtime.id` into
   `data-ko-ext-id`; the MAIN-world page script needs it to build the
   `chrome-extension://.../player.html` overlay URL.
5. `manifest.json` 0.8.15 adds `https://*.ttvnw.net/*` host permission so the
   hls.js overlay can fetch usher/playlists/segments. `rules.json` is back to
   the committed YouTube-origin rule only; the ineffective ad DNR rules are
   gone.

Git state at time of writing: see `git status`; 0.8.14 changes are not
committed yet.

---

## 4. External research: TTV-AB (GosuDRM)

Cloned to `G:\Temp\opencode\TTV-AB` (v21.x, updated 2026-10-13). It is the
most current maintained Chromium Twitch adblocker. Relevant findings:

- It **does not** block a `VideoAdRequest` GQL call either. It uses a rebuilt
  worker + stream pipeline and a playlists-first strategy.
- It explicitly handles **independent video ads**:
  - hides `<video>` whose `src`/`currentSrc` is `m.media-amazon.com` or whose
    adjacent text is "video advertisement"/"this advertisement";
  - hides containers via CSS:
    ```css
    .stream-display-ad__wrapper + div > div[style^="position:"] >
      div[class^="Layout-sc-"]:has(video[src^="https://m.media-amazon.com"])
      { display:none !important }
    .chat-shell > div[class^="Layout-sc-"] > div[style^="transition:"]:has(
      video[src^="https://m.media-amazon.com"]) { display:none !important }
    ```
  - `_INDEPENDENT_VIDEO_AD_SELECTOR = "video"`,
    `_INDEPENDENT_VIDEO_AD_LABEL = "video advertisement"`,
    `_INDEPENDENT_VIDEO_AD_LABEL_PREFIX = "this advertisement"`.
- It has "SDA iframe cleanup" selectors:
  `iframe[data-test-selector^="sda-iframe-"]`,
  `iframe[title="Stream Display Ad"]`,
  `iframe[class*="stream-display-ad__iframe_lower-third"]`.
- It has **UI-driven midroll recovery**: when in-player ad UI is visible but
  no suppressible Amazon MP4 node exists, it forces player reloads to get off
  the ad path (CHANGELOG ~line 2428). This matches our case: main video ad,
  no Amazon node.
- CHANGELOG ~line 2449: "Live Direct-Ad Video Cleanup - Direct player ad
  videos served from Twitch's Amazon media path are now suppressed on live
  streams too."
- README line 57: "TTV AB checks Twitch's HLS playlists before playback and
  blocks recognized client-side ad requests on VODs." (VOD-specific.)

Useful source locations:
- `src/modules/player.ts` ~2880-3600 (independent ad guard, CSS, suppression)
- `src/modules/hooks.ts` lines 5-40 (post-ad removable selectors), ~7700+
  (worker bridge / VOD ad handling)
- `src/modules/worker-entry.ts` (worker pipeline)

**Takeaway:** a proven extension deals with this by (a) hiding Amazon video
nodes if present, (b) cleaning iframes, and (c) reload/recover when the ad is
inside the main player. It does not rely on token flags.

---

## 5. Hypotheses, ranked

1. **CONFIRMED — Ad is stitched into an all-ad HLS playlist.** The worker
   sees it; the old all-ad guard returned the original text. Fixed by the
   autoplay/android fallback (section 2.8).
2. **CSAI is not the cause of this ad.** Blocking the CSAI chunk and Amazon
   did not stop it. Keep the DNR rules as hygiene, not as the fix.
3. **PBP promotion** remains a possible visual fallback for ads that are not
   cleanable at the playlist layer, but is not needed for the confirmed case.
4. **GQL `AdRequestHandling` response patch** (preroll/postroll flags) is
   untested and may be a cleaner long-term fix if Twitch changes the ad
   playlist behavior. Low priority now.
5. **Reload/recover on ad UI** (TTV-AB approach) is a last resort.

---

## 6. Repro + instrumentation recipes

### 6.1 Repro

- Persistent Chrome CDP: `9222`; guest harness: `9333`.
- `duda` pre-roll: navigate, click play, wait 0-10s (very frequent).
- `zerggyyyy` midroll: wait ~200s.
- Ad detector:
  ```js
  !!document.querySelector(
    '[aria-label*="Anúncio" i],[aria-label*="Advertisement" i]'
  )
  ```
- Play click (the player button often pauses if clicked while playing):
  use `[data-a-target="player-play-pause-button"]` rect + CDP mouse events.

### 6.2 Scripts (in `G:\Temp\opencode`, outside repo, may be gone)

- `ko-ad-deep.mjs` — navigate, play, wait for ad, full DOM/video dump.
- `ko-ad-scan.mjs` — loop channels until an ad, deep dump + screenshot.
- `ko-gql-ad.mjs` — inject GQL fetch/XHR logger at document_start, navigate,
  wait for ad, save `ko-gql-log.json`.
- `ko-ad-network.mjs` — `Target.setAutoAttach` for page/worker/service_worker/
  iframe, capture network + `.m3u8` bodies, save `ko-ad-network.json`.
- `ko-block-ads-chunk.mjs` — CDP `Network.setBlockedURLs` test for CSAI/
  Amazon; saves `ko-block-csai.json` and screenshot.
- `_tools/ko-cdp.mjs` — CDP helper (`connect`, `attach`, `evalMain`, `click`).

### 6.3 Useful one-liners

Token probe (Node, no cookies):

```js
const body={operationName:'PlaybackAccessToken',variables:{isLive:true,
  login:'duda',isVod:false,vodID:'',playerType:'popout',platform:'web'},
  extensions:{persistedQuery:{version:1,sha256Hash:'ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9'}}};
const r=await fetch('https://gql.twitch.tv/gql',{method:'POST',credentials:'omit',
  headers:{'Client-ID':'kimne78kx3ncx6brgo4mv6wki5h1ko','Content-Type':'text/plain;charset=UTF-8'},
  body:JSON.stringify(body)});
```

GQL log filter: parse each `text` as JSON, use
`extensions.operationName`; responses are **batched arrays**.

Deep DOM ad snapshot essentials: `video.src`, `currentSrc`, `aria-label`,
`paused`, `readyState`, rect, parent chain, all iframes with rect/src, all
`[class*="stream-display-ad"]`, `[class*="sda"]`, `[src*="media-amazon"]`.

---

## 7. Failed approaches (do not repeat blindly)

- Rewriting `playerType` to `popout` (0.8.10) — token flags unchanged, ads
  still play.
- Blocking `amazon-adsystem.com` + `ads.twitch.tv` with DNR initiator
  `twitch.tv` (0.8.11) — no effect.
- CDP-blocking the entire CSAI chunk + Amazon + ads.twitch.tv + tungstten +
  media-amazon — no effect, ad still at t=0.
- Worker playlist strip based on `#EXTINF` lacking `,live` — it **does** fire
  and removes ad lines, but the all-ad playlist guard returned the original
  when every segment was an ad.
- Returning the original all-ad playlist as a "safe" fallback — this is the
  bug. An all-ad pre-roll must be replaced with clean content, not preserved.
- Fetching other variants of the same clean master during the ad window —
  all 5 variants were also ad-only. Need a **different player type**
  (autoplay/android) for the fallback.
- Assuming the SDA wrapper is the ad — at ad time it is `__hidden` and 0x0.
- Assuming the second video is the ad — it is the **paused content** (PBP);
  the main video is the ad.

---

## 8. Next session checklist

1. **Verify a real midroll** after 0.8.14 (not just the all-ad preroll already
   measured): watch `adfix=true`, `bypass.probe`, overlay `Playing`, then
   `adfix=false` only after the Twitch ad UI is gone. `vegas` and
   `zerggyyyy` are the useful channels.
2. **Verify normal playback/seek/fullscreen after the overlay stops**: check
   `visibility`/`muted` restored, no leftover `#ko-adfix`, no paused native
   video, and quality returns to 1080p.
3. **HD clean source:** current reliable ad-time source is 360p. The
   `ADBLOCK-HD-RESEARCH.md` track is looking for a clean HD token type or a
   proxy design. Do not put `autoplay` back into the Twitch MSE.
4. **Tune the probe order/latency:** `site/web` (HD) first, then
   `popout/web`, `mobile/android`, `autoplay/android`; one rendition each.
   Measure the black-hold time during a real ad.
5. **Keep the debug ring buffers** (`workerPlaylistLog`, `workerDebugLog`,
   max 40) and `pageId`; they diagnose cross-tab and mixed-playlist reports.
6. Sync vendor, force-reload the unpacked extension, run
   `_tools/ko-harness-check.mjs`, then commit/push. Do not include
   `cookie-extension/` or `instagram-followguard/`.
7. If Twitch makes every token type ad-only, the overlay will `ad-fail` and
   the ad plays. Do not re-enable the old `ALL_AD_FALLBACK`.

## 0.8.20 (2026-10-21): best-effort fallback ladder + VOD CSAI block

### Research (GitHub / general adblockers)

- **pixeltris/TwitchAdSolutions** (archived 2026-03-05) recommends proxies as
  the only reliable method, then `vaft` / `video-swap-new`. `video-swap-new`
  detects the stitched ad, requests a clean **lower-quality** playlist from a
  different player type, swaps the source, and returns to HD after the break.
  That is exactly the user-approved trade-off: worse quality, but no ad and the
  live stays visible.
- 2026 forks (`TTV-AB`, ryanbr) put `site`, `popout`, `mobile_web`, `embed`
  first and use `autoplay` only as a last resort: `autoplay` is ~360p and can
  get stuck in an endless loading circle when used as a long-lived backup.
  `BackupSwapFirst` swaps immediately instead of stripping and showing black.
- **VOD ads are CSAI**, not HLS-stitched. `zurarah/twitch-ad-blocker-with-vods`
  intercepts `edge.ads.twitch.tv` (plus IMA/DoubleClick hosts) at the page
  `fetch`/XHR layer and returns an empty ad list `[]`. A 4xx/5xx makes the
  player retry the break, so 200 + `[]` is the safe shape.
- **TTV LOL PRO public proxies are not usable here.** The project explicitly
  forbids third-party use; public proxies are rate-limited, overloaded nodes
  get Twitch's "commercial break in progress" purple screen, and abuse can get
  the client permanently banned from their infrastructure. Random/open public
  proxies are worse: they see SNI/IP, are unreliable, and can change the
  account's apparent country. **Own VPS in an ad-free region is the only safe
  proxy route** (Russia/South Korea were capped at 720p as of 2025).
- No public proxy was used. The proxy mode remains opt-in and untouched.

### Implemented

- **VOD CSAI block** in `twitch-adblock.js` (MAIN world):
  - `window.fetch`: ad creative hosts return `new Response("[]", {status:200,
    content-type:"application/json"})`; ad telemetry (`countess`, ad-shaped
    `spade`) returns 204.
  - `XMLHttpRequest`: ad hosts are rewritten to
    `data:application/json;base64,W10=` (POST kept; Chrome accepts it), custom
    headers are skipped, and `stats.vodAdsBlocked` increments.
  - Hosts: `edge.ads.twitch.tv`, `imasdk.googleapis.com`,
    `securepubads.g.doubleclick.net`, `pubads.g.doubleclick.net`.
- **Live fallback ladder enabled** (`AD_OVERLAY_ENABLED = true`,
  `AD_BYPASS_ENABLED = true`):
  - On a live media playlist with `adExtinf>0`, the worker mutes the native
    player (`ad-hold`; it no longer hides it during the probe, so there is no
    black screen), probes a clean master, and covers only the video rect with
    the existing hls.js iframe.
  - Source order: `site/web`, `popout/web`, `mobile_web/web`, `mobile/android`,
    `embed/web`, `autoplay/android` last. On an overlay source switch,
    `mobile_web`/`popout` are tried first.
  - `ad-end` only after **two** clean native playlists. The native player is
    restored, unmuted, made visible, and `play()` is called.
  - Badge: `sem anúncio · conectando fonte limpa…` / `qualidade reduzida`.
  - Watchdog: no `Playing` after 7 s -> ask the worker for another source, at
    most twice, then restore the native player instead of leaving black.
  - First pointerdown unmutes the overlay (the native volume button is covered).
  - All native videos (main + PBP) are hidden **and muted**; original
    visibility/mute are restored on stop.
  - **Live-only guard**: `isLiveMediaUrl()` checks for
    `*.playlist.ttvnw.net/v1/playlist/` or `*.playlist.live-video.net/`; VOD
    playlists (no `,live` suffix) can never trigger the live bypass. A VOD
    master also clears `lastChannel`, so a live->VOD SPA navigation cannot
    show the old channel over the VOD.

### Tests (2026-10-21, CDP 9222, loaded 0.8.20)

- **VOD intercept**: on `twitch.tv/videos/2906724666`, direct `fetch` and XHR
  to `edge.ads.twitch.tv/2018-01-01/3p/ads` both returned HTTP 200 `[]`;
  `stats.vodAdsBlocked=2`. The VOD page did not show an ad.
- **Manual overlay playback**: minted a clean `mobile_web/web` master in Node,
  posted `ad-start` through `BroadcastChannel('ko-adblock-bypass')` on a live
  `auraritylp` tab. Result: `#ko-adfix` present, badge
  `sem anúncio · qualidade reduzida`, overlay `Playing` (started 480p, adapted
  to 1080p), native video hidden+muted, no freeze. Posting `ad-end` removed
  the iframe/badge and restored the native 1080p video unmuted and playing.
- **Automatic trigger (real ad, 2026-10-22 02:06)**: opened
  `twitch.tv/whyandr3w` in a background tab; a real midroll arrived ~13 s after
  load. Observed `lastWorkerPlaylist.adExtinf` rise `0 -> 3 -> 5 -> ... -> 29`,
  `adBypass.starts` `1..6`, `#ko-adfix` present, and `stops` `1..2`. This proves
  the real-ad path calls `maybeStartBypass()` and creates the overlay without a
  manual `ad-start`.
  - Caveat: that tab was backgrounded, so Chrome kept the native `<video>`
    paused at `rs=0` and the overlay never reached `Playing` (`playing=0`);
    the watchdog then switched/stopped it. Playback of the same overlay was
    already proven in a **visible** tab (manual test above). A visible real-ad
    run is the only remaining end-to-end check: expect `starts` to stay at 1,
    `playing>0`, no ad audio/video, then `stops=1` and native 1080p restored
    after two clean playlists.

---

## 0.8.21 (2026-10-22) - durable ad log + ad-UI detector fix

Why: ads arrive only after some refreshes; `console` and
`window.__koTwitchAdblockStats` die on reload, so "next time" there was no
evidence. The log is now persisted across page loads.

### Storage and reading it

`chrome.storage.local['ko.adlog']` is a ring buffer of **500 events**, oldest
dropped. Events are **appended**, never cleared on page load. Each load gets a
new `sid`; `boot.d.href` identifies the page.

Read from any extension page (hidden `popup.html` via CDP, or the extension's
console context):

```js
chrome.storage.local.get('ko.adlog', o => console.table(o['ko.adlog']));
```

Record shape: `{ t, sid, ev, d }`:
- `t` - wall clock (`Date.now()`).
- `sid` - page-load id; changes on every refresh.
- `d.ms` - ms since navigation start (`performance.now()`), so
  **content -> ad = ad-ui-on.d.ms - content-play.d.ms**.
- `recorder-ready.d.adblock` is the resolved toggle after the bridge's async
  storage read. `recorder-start` intentionally omits `adblock` because at
  `document_start` the bridge has not applied storage yet.

### Events

- `boot` (bridge), `script-start`, `recorder-start`, `recorder-ready`
- `content-play` / `content-stop` - only while the ad UI is absent
- `ad-video-play` - video playing while the ad UI is present
- `ad-ui-on` / `ad-ui-off` - includes `d.match` (`{kind:"wrapper"}` or
  `{kind:"aria",label}`) and `d.adSec`
- `ad-tick` - every 1s during an ad, with `adSec`
- `ad-net` - PerformanceObserver resource entries for
  `edge.ads.twitch.tv`, `amazon-adsystem`, `doubleclick`, `imasdk`, with
  `start`/`dur`/`initiator`. This also captures display/banner ads, so
  `ad-net` alone is **not** proof of a video preroll.
- `video-playing/pause/waiting/stalled/loadedmetadata/emptied/error`
- `bypass-msg` - `ad-hold`/`ad-start`/`ad-end`/`ad-fail`; only `hasUrl`, the
  playback token is never written to storage
- `worker-playlist` / `worker-debug` - only ad-related playlists/decisions

### Detector fix (important)

The old `adUiPresent()` accepted **any** `aria-label` matching
`/an.ncio|advert/`. Twitch's ad-free promo button
`aria-label="Experimenta 1 mês sem anúncios"` (32x32) matched it. That caused:
- fake `ad-ui-on` events in the log;
- `finishAdOverlay()` waiting on a non-ad element before uncovering the native
  player.

New detector:
- scans **all** `[class*="stream-display-ad__wrapper"]` elements (Twitch can
  keep a hidden squeezeback wrapper first, so `querySelector()` only saw the
  hidden one);
- accepts a visible wrapper, or an aria-label with a numeric countdown;
- excludes `sem anúncios` / `without ads` / `no ads` / `ad-free` /
  `remove ads` / `experimenta` / `teste` / `try`.

Unit test with mocked `getBoundingClientRect`:
`promoOnly -> null`, `wrapDetail -> {kind:"wrapper",w:300,h:200}`,
`hidden first + visible second -> {kind:"wrapper",w:320,h:180}`.

Live smoke (zayco01, adblock off, hidden tab): no fake `ad-ui-on`;
`content-play` at 3.25s; only `ad-net` display requests.

### Persistence check

Hidden tab `zayco01`, adblock off:
- first load: 13 events, `sid=mvk2zt28-443fo`;
- after reload: 28 events, sids `mvk2zt28-443fo` + `mvk2zwub-r6uw6`.
Both sessions are present, proving append-without-clear across refresh.

### Note for the next real ad

The tabs currently open were loaded with the old content script. Refresh one
Twitch tab after extension reload 0.8.21 to inject the new bridge/recorder.
With adblock off, the next preroll should produce `ad-ui-on` with
`match.kind="wrapper"` and `content-play` (or `ad-video-play` if it starts
during the ad). Use `d.ms` for the content -> ad delay.

---

## 2026-10-23 - "refresh infinito" (session carousel) verdict

User's idea: after opening a live and taking a preroll, a page refresh gives
~4-5s of live before the ad returns; keep refreshing that window invisibly to
make it infinite.

Measured on `jubilausz`, visible tab, adblock ON (the worker still logs the
ad-only playlist before stripping it), 6 reloads alternating normal/paused:

| load | mode | first ad-only playlist | content-play |
|---|---|---|---|
| 1 | normal | 3.785s | 4.618s |
| 2 | paused from load | **2.852s** | 9.364s (after resume) |
| 3 | normal | 10.638s | 4.147s |
| 5 | normal | 6.574s | 3.824s |

The decisive result is load 2: the ad-only playlist appeared at **2.85s even
with the video paused**. The window is tied to the page load/playback session,
not to playback time. A preloaded second session therefore consumes its own
window while hidden and is already in the ad when swapped in. Native
`video-playing` also takes ~3.3-4.0s on these loads, so a swap cannot happen
before 2.8s. **The invisible infinite-refresh/carousel is not viable.**

## Hybrid rewind + first-frame reveal (0.8.22 branch `hybrid-ad-rewind`)

Implemented:
- `ad-hold` rewinds the native player 5s (logged as `ad-rewind`) before mute.
- The clean iframe starts at `opacity:0.01` (not 0) so Chrome keeps it
  composited.
- The native stays visible until the clean player emits `firstframe` (new
  event from `player-bridge.js` on the video's `playing` event) or a 5s
  fallback; only then does `revealOverlay()` hide the native.
- `stopAdOverlay()` retries the native resume at 0/300/1200ms and clicks
  Twitch's play button as a last resort (`native-resume`,
  `native-resume-click`).

Real ad in the separate background Edge instance (logged out, extension
0.8.22, `jubilausz`):
- `ad-hold` 2.514s (rewind skipped: native not playing yet on cold load)
- `ad-start` 11.633s (source probing)
- `overlay-reveal` **13.110s, reason `firstframe`**, overlay 360p
- `ad-end` 62.663s, native restored
- before the resume retry the native stayed paused after `ad-end`; the retry
  is the fix under test.

The 1%-opacity iframe alone is not enough to make hls.js start while the
native is visible: a deterministic test with a VOD HLS source stayed
`Idle/Buffering` for ~5s and only reached `Playing` 0.5s after the native was
hidden. The first-frame event still removes the *fallback* black window
(reveal at 1.48s after ad-start vs 5s timeout), but the clean player cannot
buffer without hiding the native. A real freeze/black-free swap remains
unsolved; the current best is a short native freeze/loading gap followed by
the 360p clean stream.

## Background test harness

Chrome 155 (branded) ignores `--load-extension`; Edge 155 accepts it. The
background tests run in a separate Edge instance:
- profile `G:\Temp\opencode\ko-edge-profile`
- CDP port `9335`
- extension copied to `G:\Temp\opencode\ko-ext` (path without spaces)
- extension id `jkenjkmpfhknffakflcbgkkclchfdaip`
- watcher writes `G:\Temp\opencode\ko-bg-results.jsonl` and
  `ko-bg-summary.txt`.

The user's Chrome (port 9222) is not used by the watcher.

### Background run (separate Edge, 2026-10-23)

First real ad captured in the harness, `gragolandia1`:
- `content-play` 2.281s, first ad playlist 8.005s, `ad-hold` 7.999s,
  `ad-start` 8.000s
- `overlay-reveal` 10.460s, reason **`firstframe`** (2.46s after ad-start)
- overlay quality **1080p**, `Playing`, native hidden
- the first watcher navigated away at 15s, so `ad-end`/resume was not observed;
  the second watcher stays on the channel until the pod ends.

### 0.8.23 cold-preroll source order

The 0.8.22 background run measured `ad-hold` at 1.693s and `ad-start` only at
11.144s on a cold preroll: the probe tried all web types before
`autoplay/android`, which is the type that is actually clean during SSAI.
0.8.23 tries `autoplay/android` first in the ad-start path (360p immediately),
then falls back to the web/HD types. `switchCleanSource()` still prefers the
web types if the first source goes ad-only. A background run is measuring the
new hold -> start delay.

### 0.8.23 background run (separate Edge, 43 loads / 25.4 min)

The watcher counted 8 "ad" loads, but two (`auraritylp` loads 3 and 4) were
`worker-playlist` probe results (`adExtinf:1760`, `adOnly:true`) with no
`ad-hold`, `ad-start`, or `overlay-reveal`; the probe result alone is not an
ad trigger. The six real pods:

| channel | ad playlist | ad-hold | ad-start | overlay-reveal | ad-end | quality |
|---|---|---|---|---|---|---|
| kittykat02_ | 2.680s | 2.679s | 7.216s | 8.619s (firstframe) | 64.719s | 360p |
| hiyo | 2.269s | 2.268s | 6.718s | 8.111s (firstframe) | 62.612s | 360p |
| kittykat02_ | 1.974s | 1.973s | 6.291s | 7.460s (firstframe) | 64.954s | 360p |
| agurin | 7.849s | 7.843s | 7.844s (prewarm hit) | 9.790s (firstframe) | 61.859s | 1080p |
| gasogo | 1.995s | 1.994s | 6.772s | 8.197s (firstframe) | 52.080s | 360p |
| agurin | 6.599s | 6.593s | 6.594s (prewarm hit) | 8.314s (firstframe) | 70.598s | 1080p |

- 6/6 `firstframe`, 0 fallback timeouts.
- reveal -> ad-start: 1.17-1.95s.
- cold hold -> start: 4.30-4.83s (the 3.5s prewarm wait plus the autoplay
  probe); warm prewarm hits start immediately.
- resume: every pod logged `native-resume now paused:false`; ct advanced in
  5/6. `hiyo` was still `paused:true` at the final sample at ct 0.3 (cold
  stream; Twitch may have paused/buffered after the stop), and the watcher
  read the page as soon as it saw `ad-end`, so the `1200ms` retry had not
  logged yet. `agurin` load 4 had `starts:2` (a second ad began), so its
  final paused state is expected.

### 0.8.24 prewarm wait 800ms

3.5s of the cold 4.3-4.8s hold -> start is the prewarm wait. A cold prewarm
rarely resolves in that window, so 0.8.24 waits only 800ms and then starts
`autoplay/android` (360p); the prewarm can still populate the next ad. A
background run is measuring the new hold -> start and the resume again.

### 0.8.24 background run (separate Edge, 6 real pods, ~20 min)

| channel | ad-hold | ad-start | hold -> start | reveal | reason | ad-end | quality | final |
|---|---|---|---|---|---|---|---|---|
| kittykat02_ | 2.524s | 4.444s | 1.920s | 5.916s | firstframe | 64.644s | 360p | playing, rs=4 |
| gragolandia1 | 1.849s | 3.764s | 1.915s | 5.874s | firstframe | 61.285s | 360p | playing, rs=4 |
| agurin | 10.139s | 10.140s | 0.001s (prewarm) | 12.086s | firstframe | 74.138s | 1080p | playing, rs=4 |
| kittykat02_ | 2.240s | 4.095s | 1.855s | 5.536s | firstframe | - | 360p | still active at 80s cap |
| agurin | 8.464s | 8.464s | 0.000s (prewarm) | 10.378s | firstframe | 92.433s | 1080p | playing, rs=4 |
| kittykat02_ | 1.402s | 3.258s | 1.856s | 4.666s | firstframe | 63.991s | 360p | playing, rs=4 |

- 6/6 `firstframe`, 0 fallback timeouts.
- Cold hold -> start: **1.855-1.920s** (0.8.23 was 4.30-4.83s). Warm
  prewarm: 0-1ms, 1080p.
- Every completed pod logged `native-resume` at now/300ms/1200ms with
  `paused:false`; `ct` advanced and the final native was `rs=4` playing.
- The `kittykat02_` pod without `ad-end` was still active at the watcher's
  80s observation cap (frame visible, `stops:0`), not a failure.

Seventh pod completed after the table: `hiyo` hold 2.005s, start 3.817s
(1.812s), reveal 5.107s (`firstframe`), ad-end 51.491s, 360p. Resume
now/300/1200ms all `paused:false`, ct 0.1 -> 0.7; final native `rs=4` but
Twitch reported paused (cold-start re-pause, same as the earlier `hiyo`
run). Watcher4 final: **runs=30 withAd=7 firstframe=7 fallback=0
resumeStillPaused=0**.

### User Chrome live verification (0.8.24)

The vendor copy (`ojdhhbnnmdhlkinhddgoikfpbhehnojc`) was reloaded from
0.8.22 to 0.8.24 and a live tab on `kittykat02_` was reloaded. Chrome was
occluded, so the page was kept visible with CDP focus emulation/lifecycle
for the test (the real user tab is unaffected when focused normally).

- `ad-hold` 7.968s, `ad-start` 10.116s (**2.15s**)
- iframe at `opacity:0.01` while the native stayed visible
- `overlay-reveal` 13.322s, reason **`firstframe`** (3.21s after ad-start)
- overlay **360p Playing**, native hidden; no fallback timeout
- `ad-end` 55.783s; `native-resume` now paused:true, 300ms paused:false
  ct=35269.7, 1200ms paused:false ct=35270.6; final native `rs=4` playing
- CSS opacity became 1 only at reveal; the hidden-native gap was covered by
  the 360p clean frame, not by a black element.

The diagnostic `testOverlay()` with a stale playlist URL did not reach
`Playing`; it is not used by the real ad path.

### 0.8.25 (2026-10-23): muted autoplay + 1-segment live sync

The 5s loading was two separate costs, not one:
1. `V.play()` was unmuted, so Chrome/Edge autoplay policy parked the clean
   player in Idle/Buffering until the 2.5s mute retry (or forever in a hidden
   tab).
2. hls.js `liveSyncDurationCount:3` waited for three live segments before it
   would render.

0.8.25 changes:
- Twitch HLS iframe is built with `&tw=1`; `player-bridge.js` sets
  `V.muted = true` for that mode and the parent sends `mute:true` before
  `load`/`play`.
- Twitch HLS uses `liveSyncDurationCount:1`, `maxBufferLength:15`,
  `liveBackBufferLength:15`, `startPosition:-1`. The YouTube layer keeps its
  previous 30s/3-segment config.
- Badge is clickable and reads `sem anuncio · <quality> · clique para som`
  while the clean player is muted; the first page gesture also unmutes.

Background Edge 155.0.4283.62, **default autoplay policy** (no
`--autoplay-policy=no-user-gesture-required`), extension 0.8.25, 3 real pods:

| channel | ad-hold | ad-start | hold -> start | reveal | reason | start -> reveal | quality | muted at reveal | ad-end |
|---|---|---|---|---|---|---|---|---|---|
| Necros | 4.990s | 4.991s | 1ms | 7.435s | firstframe | **2.444s** | overlay Playing | yes | 54.943s |
| Rakin | 7.488s | 7.491s | 3ms | 9.365s | firstframe | **1.874s** | 1080p | yes | 71.105s |
| Rakin | 11.287s | 11.288s | 1ms | 12.906s | firstframe | **1.618s** | 1080p | yes | >80s cap |

- 3/3 `firstframe`, 0 fallback.
- Completed pods resumed at now/300/1200ms with `paused:false` and final
  native `rs=4`.
- The long Rakin pod was still active at the 80s observation cap
  (`starts:3`, `stops:0`, frame visible); the extra starts were ad-only source
  switches, and the final source was 1080p playing.
- Compare 0.8.24 in the user's Chrome: `ad-start` -> reveal was **3.206s**.
  0.8.25 measures **1.618-2.444s** for the same segment-fetch step.
- The native is rewound and remains visible during those 1.6-2.4s, so a
  midroll continues on buffered content instead of showing a loading box. A
  cold preroll can still show the ad for that window.

### User Chrome 0.8.25 verification (Necros)

The vendor copy was synced to 0.8.25 and the extension reloaded
(0.8.24 -> 0.8.25). A fresh Chrome window on `Necros` produced a real pod:

- `ad-hold` 65.006s, `ad-rewind` 61.55 -> 56.55 (-5s)
- `ad-start` 65.013s
- `overlay-reveal` 67.657s, reason **`firstframe`** (2.644s after ad-start)
- overlay **1080p Playing**, `muted:true`; no fallback timeout
- native rewound content covered the 2.644s, so the swap itself did not show
  a loading box
- the test window was closed before `ad-end`; the 0.8.24 run covers resume
  (0/300/1200ms, final native rs=4)

### 0.8.26 (2026-10-23): permanent hidden standby player

The remaining gap in 0.8.25 was structural: every ad paid the hls.js
`loadSource` + first-segment cost (1.6-2.6s), and a cold preroll could show
that much ad. 0.8.26 keeps a second clean player **already running** behind
the native surface, so a midroll only has to change opacity.

Implementation (`kick-overlay/twitch-adblock.js`, `manifest.json` 0.8.26):

- The page starts a hidden clean iframe (`#ko-adfix`, `opacity:0.01`,
  `pointer-events:none`, muted) when the worker has a fresh prewarm and the
  tab is visible. It is a normal `startAdOverlay(..., standby=true)`: no badge,
  no fallback timer, no native hiding, 300s lifetime.
- The worker emits `standby-start` on the `ko-adblock-bypass` BroadcastChannel
  after a fresh prewarm (`postStandbyStart`). It also emits `standby-request`
  from the page after ad-end/visibility recovery; the worker reuses a fresh
  prewarm or probes a new clean master.
- `ad-hold` reveals a standby that is `Playing` (`overlay-reveal` reason
  `standby`, opacity 1) and leaves the native hidden/muted. `ad-start` adopts
  a playing standby or rebuilds normally if it never became ready.
- `firstframe`/`Playing` only mark a standby ready while `adActive` is false.
  Pure standby shutdowns (timeout, ad-only, player error, channel change) do
  not post `overlay-stop` and do not resume/seek the native player.
- Adopting a standby increments `bypassStats.starts` and resets the overlay
  timeout to 180s from the ad.
- Ad-end still waits for the worker's two-clean-playlist signal, then restores
  the native video and schedules a new standby.

Fixes found while validating 0.8.26:

- **Native resume was blocked by the new standby.** The 1200ms retry bailed
  out on any `overlay.frame`; the new hidden standby is created at ~1s, so a
  real pod left the native paused after ad-end. The retries now ignore a frame
  only when it is an ad overlay (`overlay.frame && !overlay.standby`).
  Synthetic proof: pause the native while it is hidden, send `ad-end`; 3s later
  native `paused:false`, new standby started, both playing.
- **SPA channel changes could reveal the previous channel.** The page compares
  `location.pathname` with `msg.channel`; a mismatch on `standby-start` replaces
  the standby, and a mismatch on `ad-hold` tears it down and falls through to
  the normal cold path instead of showing stale video.
- **Source switches had a black gap.** On a long `Necros` pod the clean token
  went ad-only and the worker rebuilt the iframe while the native was hidden;
  removing the old iframe immediately produced ~2.4s of black. 0.8.26 keeps
  the last visible clean frame underneath (`z-index` one lower,
  `pointer-events:none`) until the replacement reveals, then removes it. The
  original native mute state is also carried across the rebuild (previously it
  was re-read while the native was muted by the overlay).
- **Native mute/visibility is restored with the original state.** The switch
  path no longer overwrites `overlay.wasMuted` with the temporary muted state.

Evidence:

| test | result |
|---|---|
| Synthetic standby, Edge 9335 | 1080p standby ready; `ad-hold -> reveal` **58ms** first run, **2ms** later; no fallback; `ad-end` 35ms; native restored; new standby ready |
| Real `Necros` pod (worker log) | `standby-start` 2739ms, `ad-hold` 8172ms, `overlay-reveal` reason **standby 8174ms** (**2ms**), `ad-start` 8174ms; 1080p clean picture; native hidden/muted |
| Earlier real pod (watcher log) | `ad-hold` 11746ms -> `overlay-reveal` reason `standby` 11747ms (**1ms**) |
| Native paused while hidden | `ad-end` -> native `paused:false` at T+3s, new standby `Playing` by T+6s |
| Source-switch fallback | two iframes during a forced switch: old `opacity:1 z=...646`, new `opacity:0.01 z=...647`; new error -> both removed, native restored (no black gap) |

Limitations / open issues:

- The long `Necros` pod (~130s) triggered repeated ad-only source switches
  (~37s/69s/100s). The first standby was clean 1080p; rebuilds can report
  `firstframe` with `playing:false` and the replacement can be frozen for a
  beat. The old frame is now kept during the switch, so the failure mode is a
  held clean frame, not black.
- The standby runs continuously at up to 1080p (bandwidth/CPU). The owner
  explicitly approved this tradeoff. Set `AD_STANDBY_ENABLED=false` to fall
  back to 0.8.25's on-demand overlay.
- A channel whose native video is paused by autoplay policy cannot reveal a
  standby; `ad-start` falls back to the normal cold rebuild. The user's normal
  interactive Chrome does not hit this.
- Real-ad end-to-end with the **final** 0.8.26 (after the resume and
  switch-frame fixes) was not re-observed; the four `Necros` reloads after the
  fixes had no ad. The earlier real pod proves the 1-2ms reveal; the resume and
  switch-frame fixes are covered synthetically.
- HD remains limited by the clean token; an own VPS in an ad-free region is
  still required for reliable 1080p (see `ADBLOCK-HD-RESEARCH.md`).

### 0.8.27 / 0.8.28 (2026-10-23): freeze + duplicated-audio fixes

A real `Necros` watch on 0.8.26 reproduced two failures the earlier tests did
not cover:

1. **Backward jump + freeze.** At ~1:50 the ad path ran `ad-rewind`
   `86.76 -> 81.76` (5s), then revealed the warm standby in **3ms**. The clean
   token later went ad-only (`adOnly`), the worker sent `ad-start switch:true`,
   and the replacement iframe emitted `overlay-reveal reason=firstframe
   playing:false`. It was stalled (`bufferStalledError`, `rs=2`, `buffered=0`)
   while the native video was hidden/muted, so the user saw a frozen frame at
   the point where the ad had started.
2. **Doubled audio, ~1.5-2s apart.** The pointerdown unmute handler was
   installed for the hidden standby too. Any click on the Twitch page sent
   `mute:false` to the hidden 1%-opacity player, which runs ~1.5-2s behind the
   native. Re-muting was also missing: `hideNativeVideos()` skipped videos it
   had already stored, so if Twitch unmuted a hidden native video again the
   native audio came back behind the clean overlay.

0.8.27/0.8.28 changes:

- **No rewind on a warm standby.** `ad-hold` logs `ad-rewind-skip`; the 5s
  rewind remains only for the cold path. This removes the visible backward
  jump on the 1-2ms swap path.
- **Never reveal a frame that is not moving.** `firstframe` no longer reveals if
  `overlay.playing` is false. `Playing` is accepted only with `rs>=3`
  (`playing-not-healthy` is logged otherwise), and the 5s fallback now stops and
  restores the native player (`overlay-no-playing`) instead of revealing a
  black/frozen frame.
- **Stall recovery.** A visible clean player that reports
  `bufferStalledError`, stays at `rs<3`, goes ad-only, or starts with
  `firstframe playing:false` gets a 2.5-4s grace timer. If it does not recover,
  `overlay-stall-stop` stops the overlay and restores the native surface. A
  healthy `Playing` clears the timer.
- **Doubled audio.** The page gesture handler returns early unless
  `overlay.revealed && !overlay.standby`; a hidden/unrevealed player can never
  be unmuted by a click. The handler stays installed so the next click after
  reveal still unmutes the clean audio.
- **Native re-mute/re-hide every tick.** `hideNativeVideos()` now re-applies
  `visibility:hidden` and `muted=true` to already-known videos on each 500ms
  position tick, instead of trusting the first hide. This covers Twitch
  un-muting a hidden native video.
- **Source-switch fallback frame** (0.8.26) is retained: the old visible clean
  frame stays underneath until the replacement reaches a healthy `Playing`.

Edge 0.8.28 validation (separate profile, `--mute-audio`):

- standby 1080p, `lastMsg.st.muted:true`; a synthetic `pointerdown` left it
  muted (no hidden-player unmute);
- `ad-hold` revealed in **35ms** (10ms poll); `ad-rewind`/`ad-rewind-skip`
  showed no native rewind on the warm path;
- after revealing, manually setting the native `video.muted=false` was
  corrected back to `muted:true` within 800ms (re-mute tick);
- a forced source switch kept two iframes while the new source buffered
  (`old opacity:1 z=...646`, new `0.01 z=...647`); the old frame remained until
  the new `Playing` (`rs=4`), then the old was removed;
- `ad-end` restored the native, started a new standby, and left native
  `muted` at its original state.

The user's Chrome extension was reloaded to 0.8.28; an existing tab keeps the
old content script until it is refreshed. A temporary page-side mute guard was
used on the live tab (mutes hidden iframes and native videos while an overlay is
visible) so the doubled audio stops immediately without forcing a reload.

Open limitation: real-ad end-to-end with 0.8.28 has not been re-observed; the
0.8.26 real pod remains the timing proof, and the freeze/audio fixes are covered
by the Edge scenarios above plus the incident log. Cold-start ads can still show
the native ad (muted) while waiting for a healthy clean `Playing`; that is the
deliberate alternative to a frozen clean frame.

### 0.8.29 (2026-10-23): clean-during-SSAI standby + volume restore

Two remaining issues after 0.8.28:

1. **The warm standby could still go ad-only mid-pod.** `prewarmCleanSource()`
   called `findCleanHlsUrl(channel, true)` with `prewarmMode=false`, so the
   hidden standby was minted from `mobile_web`/`popout`/`site` HD. Those types
   are clean *outside* the ad window but can become ad-only when a long SSAI
   pod starts. The warm HD frame then had to switch sources during the ad, which
   is the path that produced the 0.8.26 freeze. The `prewarmMode` ladder
   (`autoplay/android` first) existed but was never used by the prewarm or the
   ad-time switch.
2. **Unmuted live, no audio after the ad.** Twitch reacts to
   `video.muted=true` by setting `video.volume=0`. The extension restored only
   `muted` after the ad, leaving the element at volume 0 while the volume icon
   could show unmuted. The user had to click the volume button; real report:
   “a live tava desmutada e não tinha áudio”. Hidden native videos had the same
   missing volume record.

0.8.29 changes:

- `prewarmCleanSource()` and `switchCleanSource()` now pass `prewarmMode=true`.
  The standing hidden player is **360p `autoplay/android`**, the only type
  measured clean during SSAI. The native player is still 1080p whenever no ad
  overlay is visible; during an ad the clean overlay is lower quality, which the
  owner explicitly accepted. This removes the HD-token-goes-ad-only source
  switch from the normal long-pod path.
- Capture `volume` alongside `muted` at ad-hold / overlay start and in every
  hidden native video. Restore both in `restoreHeldMute()`,
  `stopAdOverlay()`, and `restoreNativeVideos()`. Restoring `muted=false` alone
  was not enough because Twitch had already zeroed the volume.
- Removed the UI-label mute heuristic: the icon reflects our own induced mute,
  so it cannot be trusted to infer the user's pre-ad intent. The captured
  pre-ad `muted` + `volume` pair is the source of truth.

Edge 0.8.29 validation (separate profile, `--mute-audio`):

- standby is `360p` (`autoplay/android`, `qcount:2`) and reaches `Playing`
  with `muted:true`; it is hidden at `opacity:0.01`;
- `ad-hold` reveals it at opacity 1; native goes `muted:true, volume:0` while
  covered;
- `ad-end` restores native `muted:false, volume:0.5`; the Twitch button reads
  “Mudo (m)” (audio on) and no click is needed. Before 0.8.29 the same sequence
  left `volume:0`.
- pointerdown on the hidden standby still leaves it muted; no doubled audio.

The extension in the user profile was reloaded to 0.8.29. Existing tabs still
need one refresh to replace the old content script; until then they keep 0.8.28
behavior. HD *during* an ad is still only possible with the owner's VPS egress
in an ad-free region; 360p clean is the accepted no-VPS fallback.

### Owner validation (2026-10-23): accepted, 0.8.29

The owner used 0.8.29 on a real live and reported:

> "testei. parece que funcionou muito bem."

This closes the real-ad validation item that had been open since 0.8.26. The
previously reported "unmuted but silent after the ad" failure did not reproduce:
0.8.29 restores the captured `muted` + `volume` pair. No new freeze, rewind, or
doubled-audio report came with this validation.

Accepted behavior, no longer considered a defect:

- during a live ad pod the clean overlay is 360p; the native player is back at
  the user-selected quality (up to 1080p) when the pod ends;
- a cold preroll can briefly show the muted native ad while the clean player
  reaches a healthy `Playing`; a frozen clean frame is deliberately avoided.

Version 0.8.29 is the validated adblock release. Any future change to
`twitch-adblock.js` should re-run the Edge scenarios in this section before it
is called stable.

## 0.8.30 (2026-10-23): overlay-only follow-up

0.8.30 does not change the adblock path. It fixes the YouTube mode seek bar
color (YouTube red; Kick stays green) and adds the YouTube-to-Kick fallback
when a selected YouTube source is missing or not live. The 0.8.29 adblock
validation above still applies.

## 0.8.31 (2026-10-23): faster cold-preroll standby

The complaint was that a cold open still showed the muted native ad long
enough to look like the ad would play in full, which invited a manual F5.
The slow part was not ad detection; it was the clean standby becoming
healthy. Three changes move that earlier:

1. **Early prewarm requests.** The page asks for a prewarm from the channel
   in the pathname at 200ms, 1s, 2.5s and 5s after load. The live-master hook
   remains the fallback for SPA switches and when the early request did not
   reach the worker yet.
2. **Fast standby handoff.** `prewarmCleanSource()` mints `autoplay/android`,
   checks that the master responds OK, publishes that URL and posts
   `standby-start` immediately. The full variant probe keeps running and
   replaces the cached URL when it finds a different clean source. A minted
   URL that 403s is discarded before it reaches the player, so an offline
   channel does not create a mint/error loop.
3. **Player and adoption tuning.** `startLevel: 0` makes the Twitch HLS
   standby begin at the lowest rendition instead of racing a 1080p segment.
   A standby may start before Twitch creates its `<video>`; the hidden frame
   is a full-viewport 1% surface until `positionOverlay()` attaches it.
   `ad-hold` marks a buffering standby as adoptable, and `ad-start` gives a
   young standby 300ms or one older than 1.2s up to 900ms to reach healthy
   `Playing` before rebuilding.

Measured in the separate Edge profile (9335), same code:

- Warm standby, synthetic `ad-hold` at 8.5s: reveal after **547ms**.
- Warm standby, synthetic `ad-hold` + `ad-start` at 8.5s: reveal after
  **136ms**.
- `alanzoka`: `prewarm.fast` at 3.3s, frame at 3.4-3.9s, standby healthy
  later; no preroll occurred in the 38s run.
- `rodil`: real prerolls at 3.3s and 4.3s, fast prewarm at 2.6s and 3.3s.
  The standby was only 0.26-0.45s old, so it was rebuilt; overlay revealed
  at 6.8-7.8s. This is the remaining worst case: an ad that arrives before
  the standby is healthy cannot be covered without a frozen/black frame.
- `duda` (offline): no fast URL, no standby, no retry loop after the master
  check and the 4s forced-retry cooldown.

Not yet measured: a real cold preroll in the owner's Chrome on 0.8.31/0.8.32.
The earlier owner baseline had `prewarm.ok` at 4.47s, `ad-start` at 5.19s and
reveal at 7.34s. The fast path is intended to move the standby well before
that 5.19s mark; the owner needs to F5 a real live to confirm the practical
window. A manual F5 is still not part of the design: the page never reloads
itself.

## 0.8.32 (2026-10-23): player 1:1 decision

This release changes no adblock code. It records why the Kick/YouTube player
is not cloned and adds an official-site link to the popup. See
`kick-overlay/PLAYER-1TO1-RESEARCH.md`.

## 0.8.33 (2026-10-24): clean player keeps its live buffer

On `jynxzi` the 4 s readiness gate never opened: `standbyReady` stayed 0 for
60 s and four ads played. The clean player reported `rs=4` / `state=Playing`
with only **1.21-2.38 s** of forward buffer, so lowering the gate would have
revealed a starving picture, not fixed the bug.

The cause was `jumpToLiveEdge` in `player-bridge.js`. With
`liveSyncDurationCount: 2` and 15 s segments, hls.js correctly places the
clean player about 30 s behind the edge. The jump test `behind > 20` read that
as a DVR playlist starting at its oldest segment and seeked to `end - 2`,
throwing away the buffer. A follow-up run measured 0.38-1.17 s after the jump.
The gate is back at 4 s.

The jump now only fires when `behind > 120` or `behind < 1.5`. Measured in the
isolated Edge profile (9335), same code:

- `jynxzi`: `prewarm.fast` 1.8 s, `prewarm.ok` 2.1 s. A pre-roll at 2.6 s was
  not covered (cold case). The next ad at 18.6 s revealed the clean overlay at
  23.7 s at 360p and kept it up to the end of the 70 s run: `playing=48` ticks,
  `buffered=11.38 s`, native hidden.
- `rodil`: `prewarm.fast` 2.4 s, ad at 3.1 s, `overlay-reveal` at 7.5 s. The
  frame stayed opaque for the rest of the 60 s run: `playing=53` ticks,
  `buffered=11.54 s`, `stops=0`.

Still not fixed: an ad that starts before the standby has three healthy ticks
(about 3 s after prewarm) shows the native ad until the clean player is ready.
That was 4.4 s on `rodil` and the whole first pre-roll on `jynxzi`.

`standbyReady` stays 0 on cold prerolls because it only counts the
warm-standby transition. The reveal counter (`playing`) is the useful signal
for these runs.

`AD_REWIND_SEC = 0` and the native resume retries stay. The earlier native
stalemate at `readyState 2` was not observed after this change: `jynxzi`
resumed at `rs=4` with advancing `currentTime` after the first overlay stop.

## 0.8.34 (2026-10-24): longer cold-preroll window

0.8.33 fixed the buffer, but a pre-roll that lands before the standby is
healthy still showed the native ad. Two timers stopped the hidden clean
player early:

- the 5 s `hideTimer` in `twitch-adblock.js`;
- the stall fallback, which gave up as soon as `maybeNudgeOverlay` had
  nothing to rewind into (`pos <= 2`).

Both now allow 12 s while `overlay.adActive`. The frame stays at 1% opacity
until it is healthy, so the longer window adds no visible artifact, and the
ad-end path still stops it earlier.

Measured, same build, isolated Edge profile (9335):

- `jynxzi` warm: `prewarm.fast` 2.86 s, `prewarm.ok` 3.4 s, `ad-hold` at
  10.2 s. The standby was already ready, so `overlay-reveal` fired at the same
  instant with `reason:"standby"`. `starts=1`, `stops=0`, `playing=61`,
  `buffered=11.86 s`, native hidden.
- `rodil` cold: ad at 2.75 s, `firstframe-not-playing` at 4.6 s,
  `overlay-reveal` at 7.35 s. `buffered=11.88 s`, `stops=0`, frame opaque to
  the end of the 60 s run.
- `rodil` cold, earlier run: ad at 3.07 s, reveal at 7.46 s.

The cold path now covers the ad 4.4-4.6 s after it starts instead of missing
the whole pod. The remaining delay is the clean source mint plus buffer time;
it cannot be removed without revealing a frame that is still filling.

## 0.8.35 (2026-10-25): unmute on reveal, catch up a drifted standby

Real Chrome report on `srdogg`: the ad was replaced by silent content, and
after the ad the stream looked delayed. The installed extension was still
0.8.32 (`VOD.RIP\vendor\kick-overlay`), but both symptoms are design gaps that
also exist in 0.8.34:

- the clean player starts muted for autoplay and stayed muted until a click;
- a standby that sat hidden while the tab was throttled can be far behind
  live. In the owner's Chrome the clean player reported `lat=115.8 s` with
  `dur=224 s`, so revealing it showed a delayed stream and then a jump at
  ad-end.

Changes:

1. `revealOverlay()` sends `mute:false` and `play`, then checks the next state
   after 1.5 s. If the player is still muted or paused, it re-mutes and leaves
   the click-to-sound badge. Measured in the isolated Edge: `unmute-ok` 1.5 s
   after reveal.
2. An ad overlay with `lat > 20` seeks to `pos + lat - 3` (at most every 2 s)
   and stays hidden until `lat <= 20`, `rs >= 3` and `buffered >= 4`.
   A standby adopted with `lat > 20` does the same inside `revealOverlay()`
   and gets a 12 s catch-up bound before the native surface is restored.

Measured on `srdogg` (isolated Edge, 90 s):

- `prewarm.fast` 1.5 s, `prewarm.ok` 2.0 s, ad at 2.15 s.
- standby `lat=30`, `pos=0`, then `overlay-catchup`, reveal at 10.5 s.
  A source switch rebuilt the frame and revealed again at 14.7 s;
  `unmute-ok` at 16.2 s.
- `ad-end` at 62.8 s, native resumed with `muted:false` and advancing
  `currentTime`.

Not verified in the owner's Chrome: its installed copy is still 0.8.32 and
needs the 0.8.35 files plus an extension reload. The cold-preroll lead time
(about 8 s on this run) is unchanged.

## 0.8.35 real Chrome, srdogg reload (2026-10-25 18:26)

The owner reported an ad at the exact reload and a replay afterwards. The
adlog confirms both, in the owner's Chrome with 0.8.35 loaded:

- `overlay-reveal` at +7.4 s after boot: the cold preroll was visible for the
  whole mint/buffer window. The cold-open bug is **not** fixed; the earlier
  `fixed-not-verified` status is now falsified on a real cold open.
- `unmute-ok` at +9.3 s (1.5 s after reveal): the clean overlay came back with
  sound in real Chrome.
- At ad-end the native `<video>` was replaced. The old element reported
  `ct=36.1`; the replacement reported `ct=0.00`, then `0.70`, `2.20` on the
  resume retries. That is the replay the owner saw.
- The native live edge is its own `buffered.end` (209.8 s when measured), not
  the clean window edge (200 s). Seeking the native to `2^30-2` stalls at
  `rs=1`; seeking to the clean edge (198) also stalls while unbuffered.
  Seeking to `buffered.end - 1.5` plays normally.

Open work:
1. Cover the cold preroll instead of showing it, at the cost of a black/loading
   overlay for the mint window (~7 s on this run).
2. Do not resume a replaced native element at `ct=0`; either wait for Twitch
   to position it or seek inside its own buffered range and retry `play()`.

## 0.8.36 (2026-10-25): cover the cold preroll, log the native handoff

The 0.8.35 real-Chrome run showed the preroll for 7.4 s and then a native
element replaced at `ct=0`. 0.8.36 changes the cold path and adds the missing
measurement:

1. `ad-hold` now covers the native immediately when the standby is not yet
   playing: the frame goes to opacity 1, the native videos are hidden, and the
   existing "sem anúncio · carregando…" badge is shown. The user sees a
   black/loading player for the mint window instead of the ad. `revealOverlay()`
   finishes normally when the clean player is healthy; the 12 s stall bound
   still restores the native if it never gets there.
2. `stopAdOverlay` logs `native-handoff` with `replaced`, `ct`, `buf`, `se`,
   `cleanPos` and `cleanLat` before resuming. The next ad decides whether the
   replacement at 0 is live or the DVR start.

Not yet changed: the resume at `ct=0` itself. The handoff log is the evidence
needed to choose between waiting for Twitch, seeking inside `buffered.end`, or
keeping the clean frame longer.

## 0.8.37 (2026-10-25): bound the cold cover

0.8.36 measured in the owner's Chrome on `srdogg`: `cold-cover` fired at
`ad-hold`, the owner saw about 2 s of black instead of the preroll, and
`unmute-ok` followed the reveal.

- `native-handoff`: `ct=3.9`, `buf=12.1`, `replaced=false`, `cleanPos=59.5`,
  `cleanLat=10.5`. The native and the clean were at the same content point,
  about 10.5 s behind the clean edge.
- After the handoff the native advanced at 1x with a stable 1.55 s forward
  buffer (`ct` 3.6 -> 8.6, `buf` 5.2 -> 10.2 in 5 s), i.e. at its own live
  edge. The hidden clean standby showed ~20 s of latency because it is
  throttled; it is not a live reference.

0.8.37 adds a 12 s bound to the cold cover: if the clean player never reveals,
`stopAdOverlay('cold-cover-timeout')` restores the native instead of leaving a
black frame.

## 0.8.38: catch the native up to its own buffer at handoff

At ad-end the native reported `ct=3.9` with buffered end `12.1`. Playing at 1x
never closes that gap. `resumeNative` now seeks to `buffered.end - 0.5` when
the buffer is more than 3 s ahead; the seek stays inside the buffered range
and is instant. Measured manually on srdogg: seek to `buffered.end - 0.5`
played without a stall (`ct` kept advancing, buffer stayed ~1.5 s ahead).
