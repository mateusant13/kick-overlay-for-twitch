# Twitch adblock — investigation log (for a future zero-context session)

Last updated: 2026-10-20. Chrome 155, extension **0.8.15**, persistent profile
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

---

## 3. Current extension behavior (0.8.15)

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
