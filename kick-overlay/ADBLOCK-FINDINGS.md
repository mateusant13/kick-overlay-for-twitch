# Twitch adblock — investigation log (for a future zero-context session)

Last updated: 2026-10-22. Chrome 155, extension **0.8.21**, persistent profile
(`C:\Users\Administrador\Desktop\Nova pasta (3)\TESTE\VOD.RIP\vendor\kick-overlay`),
CDP port 9222. Channels used for repro: `twitch.tv/duda` (pre-roll appears most
reloads), `twitch.tv/zerggyyyy` (midroll after ~3 min), `twitch.tv/vegas`
(midroll/preroll).

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
