# KO fixes + Twitch adblock — TODO

- [x] 1. Isolated test browser (headless/offscreen, own profile, own port) — never touch the user's visible Chrome
- [x] 2. Reproduce Kick player bugs (back-to-live, seek, pause, DVR) on rodil
- [x] 3. Reproduce YouTube layer failure (mint/resolve/HLS playback) on rodil YT live
- [x] 4. Fix Kick bridge/content sync: return-to-live, seamless live/DVR, no reload storms
- [x] 5. Fix YouTube layer: resolve video, mint HLS, live edge, controls
- [x] 6. Implement default Twitch adblock (SSAI/playlist level; no overlay required)
- [x] 7. Test rodil on Twitch: Kick layer, YouTube layer, native Twitch adblock
- [x] 8. Backup + sync to vendor KO + reinstall/update extension
  - backup: `G:\Temp\opencode\backup-20261020-015708-ko-final`
  - vendor synced (hashes match); persistent profile reloaded 0.8.6 -> 0.8.8
    via a hidden extension page (`_tools/ko-reload-persistent.mjs`), no window,
    tab, or Chrome restart.

## 0.8.8 (2026-10-20, live jb_sniper test)

- [x] Twitch adblock fetch rewrite actually forwards the modified body.
  `stats.rewrites` used to increment while `realFetch.apply(this, arguments)`
  sent the original `playerType:"site"` token — the page kept minting
  ad-bearing playback. New `ko-harness-check` step **adblock.token-body**
  captures the wire request and asserts `playerType:"popout"` (20/20 suite).
- [x] Arrow-left on the Kick live player is a real 5s step. It used the
  broadcast duration (`KO.kickDur`) as the seek base while `pos` is
  session-relative, which targeted ~0s; now it sends `pos + delta` to the IVS
  bridge. The bridge uses `p.seekTo()` (not `video.currentTime`), retries a
  dropped first seek, cancels a stale retry on `seekToLive`, and the content
  caps accumulated rewind at 25s instead of reloading the live url.
- [x] Overlay no longer sticks to the viewport when the page scrolls: the
  400ms rect tick no longer clamps `left/top` to 0; `bindRectScroll()` updates
  on rAF scroll/resize. `scrolltest` confirms wrapTop == anchorTop == -550 at
  scrollY 600.
- [x] Manifest display name is **Kick & YouTube Overlay for Twitch**; version
  0.8.8. Persistent install verified 0.8.8 with the fixed scripts.

Harness additions in this round: `key ArrowLeft|ArrowRight|f`,
`scrolltest`, and `adblock.token-body`. Full suite: **20/20 PASS** on a fresh
profile at `twitch.tv/jb_sniper` + a live YouTube HLS video.

## 0.8.9 (2026-10-20, live jb_sniper test)

- [x] Kick 5s steps were directionally wrong because the IVS bridge reported
  `getLiveLatency()`, which does **not** update after `seekTo()` for ~5s.
  Measured: the playhead dropped 5s instantly while latency still read 1.5s,
  so the UI stayed on LIVE and `seekToLive()` targeted only 1.5s ahead.
  The bridge now derives latency from `getBuffered().end - getPosition()`
  (updates immediately) and falls back to `getLiveLatency()` only if the
  buffered range is unavailable. On the DVR url latency is forced to 0 (the
  replay buffers far ahead, which had shown `LIVE -38s`), keyed on a **finite**
  duration - live IVS reports `Infinity`, not 0, and that distinction matters.
- [x] ArrowRight while behind live is now a real +5s step instead of always
  jumping to live; it only goes live when within one step of the edge.
  `seekToLive()` targets the buffered edge (not `pos + stale latency`).
  Verified: 0.98s -> 6.78s -> 13.06s -> 9.10s -> 4.97s -> 1.11s.
- [x] Harness check `kick.step-5` added (21 checks).
- [x] YouTube on Twitch mapping verified with `jb_sniper -> @JBSniperPRIME`:
  resolved channel `UCPnSTVabEHxpiIScMrD_47w`, minted live HLS, `ko-yt`
  visible and playing; ArrowLeft/Right moved roughly 5s per press.
  The mapping is per-channel because YouTube handles can differ from the
  Twitch slug (this one does), so it cannot be inferred safely.

## 0.8.10 (2026-10-20, Twitch PBP ad report)

- [x] A live view on `twitch.tv/duda` reported an ad while the extension was
  enabled. The page-side token rewrite was working (`lastPlayerType` showed
  `picture-by-picture -> popout`, `rewrites=5`, `workerHooks=2`,
  `workerFailures=0`), but the worker's fallback cleaner explicitly skipped
  `/channel/hls/` masters whose URL contained `picture-by-picture`. Twitch's
  2025 stream display ads use that player type, so the clean-master path was
  bypassed.
- [x] Removed that skip: every `/channel/hls/` master, including PBP, is now
  replaced with a freshly minted popout master (falls back safely if the mint
  fails). Added `stats.pbpRewrites` so a future report can be diagnosed
  without guessing.

## 0.8.13 (2026-10-20, stability + SSAI findings)

- [x] The 0.8.11 DNR blocks (`amazon-adsystem`, `ads.twitch.tv`) did **not**
  stop the ad. CDP also blocked the whole `client-side-video-ads` chunk plus
  Amazon/tungsten/media-amazon; the preroll still played. So the ad is not
  CSAI. Removed both DNR rules + their host permissions in 0.8.13: no benefit,
  and blocking a top-level Amazon ad navigation produced a scary
  `ERR_BLOCKED_BY_CLIENT` page.
- [x] Added a worker digest via `BroadcastChannel('ko-adblock-debug')`. It
  proved the preroll playlist is **all ads**:
  `#EXTINF:2.002,Amazon|...` x3-4 with
  `CLASS="twitch-stitched-ad"` and `X-TV-TWITCH-AD-ROLL-TYPE="PREROLL"`.
  `stripAds()` removed every ad line and then its all-ad guard returned the
  original text (`changed:false`) -> ad played.
- [x] Tried replacing the all-ad playlist with a clean playlist from another
  token type. `autoplay/android` was clean (15 content segments) and removed
  the ad UI, but its MSE output is **not playable in the web player**: video
  stayed `paused rs=1` forever. All web-container types are ad-only during
  the ad. PBP promotion also failed (empty placeholder video). Fallback is
  **disabled** (`ALL_AD_FALLBACK = false`).
- [x] **Fullscreen stutter fix:** `cleanMaster()` no longer mints a second
  master when the incoming usher token is already `popout/web`. The old
  `tokenInfo()` assumed base64 and always returned null, so every fullscreen /
  quality-triggered master request paid an extra GQL+usher round-trip and got
  a replacement master. The token is URL-encoded JSON; fixed.
- [x] Stats counters added: `adOnlySeen`, `fallbacks`, `lastFallbackType`,
  plus `workerPlaylistLog` / `workerDebugLog` ring buffers (worker id included).
- [ ] Re-run normal playback + fullscreen check after 0.8.13, rerun harness,
  commit. Harness on 0.8.12: `adblock.stats` + `adblock.token-body` PASS;
  Kick/YT FAIL because the tested channels were offline; native Twitch video
  was `paused=false rs=0` in the guest (environment, not adblock).

Full evidence and next steps: `kick-overlay/ADBLOCK-FINDINGS.md`.

## 0.8.15 (2026-10-20, real ad on `vegas`)

- [x] **Clean HLS overlay** replaces the old MSE fallback. On **any** stitched
  ad (`adExtinf > 0`, including mixed midrolls), the worker posts `ad-hold`;
  the page hides/mutes all native `<video>` elements and covers the player
  with `player.html?m=hls` fed by a freshly minted clean master.
- [x] Probe order: `site/web` (HD), `popout/web`, `mobile/android`,
  `autoplay/android` (360p). During the measured ad, all web/mobile types were
  ad-only; `autoplay/android` was clean, so the overlay played 360p. Outside
  the ad, `site/web` plays 1080p in the hls.js overlay.
- [x] Hiding the native video is **required**: with it visible, hls.js stayed
  `rs=0/ns=2` forever on channel pages. Restoration verified on `ad-end`.
- [x] `ad-end` requires **two consecutive clean playlists**, then waits up to
  3s for Twitch's ad DOM to clear before uncovering the native player.
- [x] Fixed an origin-wide `BroadcastChannel` bug: every worker now carries a
  random `pageId`, so an ad in one Twitch tab cannot start overlays in other
  tabs.
- [x] Added host permission `https://*.ttvnw.net/*`; debug `st` now exposes
  `rs/ns/err/buffered`, and HLS errors are surfaced.
- [x] Real-ad evidence (`vegas`, 23:38): `adfix=true`, `site/web adExtinf=3`,
  `mobile/android adExtinf=3`, `autoplay/android adExtinf=0`, overlay
  `Playing`, `adfix=false` after clean playlists.
- [ ] Independent verification of normal playback/seek/fullscreen and
  Kick/YouTube overlays (separate subagent).
- [ ] Harness 21 checks, vendor sync + force reload, commit/push.
- [ ] HD clean source during ads (see `ADBLOCK-HD-RESEARCH.md`); current
  reliable source is 360p.

## 0.8.16 (2026-10-21, real ad on `necros`)

- [x] Reproduced the remaining leak: the overlay's own clean `site/web` source
  turned ad-only on a later playlist refresh (`DCM|...` / `Amazon|...`), so
  hiding the native player only exposed the ad inside the overlay.
- [x] `player-bridge.js` now installs an hls.js `pLoader` that strips Twitch
  stitched ad segments from every `*.ttvnw.net` media playlist **before**
  hls.js parses it. It caches the last clean live window for ad-only refreshes
  and never touches YouTube HLS.
- [x] Parent stats: `adStrips`, `adStripErrors`, `lastAdStrip`.
- [ ] Verify on the next real `necros` ad: `adStrips > 0`, overlay stays on
  content (or freezes on the last clean frame), then `stops=1` after two clean
  playlists.
- [ ] Commit/push 0.8.16 after the real-ad check.

## 0.8.17 (2026-10-21, follow-up to the same `necros` ad)

- [x] 0.8.16 stopped the ad but left hls.js `Buffering rs=0 ns=2 buffered=0`
  for ~40s on an ad-only refresh; the overlay hit its 60s timeout and was
  removed (`stops=2`, reason `timeout`).
- [x] `player-bridge.js` posts an `ad-only` event when the stripped playlist
  has no content. The page asks the worker for another source; the worker
  probes `autoplay/android` first (clean during SSAI, 360p, plays in hls.js),
  then the other types, and recreates the overlay iframe.
- [x] First real test: `adOnly=1`, `bypass.switch` found `autoplay/android`
  clean and the overlay eventually played 360p content (no ad). But the old
  `loadSource` path stayed `Buffering` ~45s, and the 60s timeout removed the
  overlay while the ad pod was still running (`stops=1`, reason `timeout`).
  Fixed by recreating the iframe on switch and raising the safety timeout to
  180s.
- [ ] Verify the final switch on the next real ad with the tab visible:
  `adOnly` increments, `bypass.switch` appears, overlay returns to `Playing`
  quickly, and `stops` happens only after two clean native playlists.
- [ ] Commit/push 0.8.17 after the real-ad check.

## 0.8.18 (2026-10-21, user report: player changed and froze)

- [x] User report: the 0.8.17 mid-ad `ad-only` switch recreated the overlay
  iframe as a 360p hls.js player with Chrome controls and stalled around the
  switch. "mudou o player ... era pra ser smooth".
- [x] `AD_OVERLAY_ENABLED = false`: `ad-hold`/`ad-start`/`ad-end` no longer
  hide, mute, or cover the native player. The Twitch video and controls are
  untouched; no source probe runs during an ad.
- [x] Worker still records ad playlists and strips ad lines from native
  playlists; the Kick/YouTube HLS overlay path is unchanged.
- [ ] Find a token type/platform that is **clean during an ad AND HD** so the
  **native** player (no overlay) can be pointed at it. Watcher:
  `G:\Temp\opencode\ko-necros-ad-matrix.mjs` ->
  `G:\Temp\opencode\necros-ad-matrix.log`. If found, set the clean
  type/platform in `twitch-adblock.js` and prove it on a real ad.
- [ ] Re-test the native player on the next real ad: no `#ko-adfix`, no hidden
  video, `paused=false`, `rs>=2`, controls/seek/fullscreen normal.

## 0.8.19 (2026-10-21, proxy HD mode)

- [x] User chose the TTV LOL PRO-style proxy path for HD + no ads + native
  player.
- [x] `twitch-proxy/`: dependency-free HTTP CONNECT proxy (basic auth, optional
  IP allowlist, `/health`), `install.sh` systemd installer and README. It does
  not strip playlists: the clean HD playlist comes from an ad-free egress region.
- [x] `background.js`: `chrome.proxy` PAC for `usher.ttvnw.net`,
  `gql.twitch.tv`, `*.playlist.ttvnw.net`, `*.playlist.live-video.net`;
  `DIRECT` for everything else, including video segments. `PROXY …; DIRECT`
  fallback. `webRequest.onAuthRequired` supplies proxy credentials.
- [x] `popup.html/js`: `Proxy HD (sem ads)` host:port/user/pass + save.
- [x] Local routing test: PAC applied, CONNECTs to gql/usher/playlist observed,
  `extinf:14 adExtinf:0`, native video present, PAC returns to `system` when
  disabled.
- [ ] Deploy `twitch-proxy/` on a VPS in an ad-free region (e.g. Russia) and
  confirm on a real ad that the native player stays HD and
  `workerPlaylistLog` never shows `adExtinf>0`.
- [ ] If GQL latency is bad, replace the broad `gql` PAC route with a
  body-aware redirect of only `PlaybackAccessToken`.


## Diagnostic harness (added 2026-10-20)

One command now drives a clean guest profile and checks every layer:

```powershell
node _tools/ko-harness.mjs check --fresh --yt='https://www.youtube.com/watch?v=3cOk_W3ewcE'
```

- `start [url] [--fresh]`, `stop`, `status`
- `state`, `set`, `eval`, `click`, `shot`, `net`, `console`
- `check` runs: Kick activate/pause/play/mute/quality/DVR/LIVE; YouTube
  activate/playing/iframe/segments/quality/pause-mute/rewind-LIVE; adblock
  stats + native Twitch playback; console exceptions; screenshot.
- Report: `G:\Temp\opencode\ko-harness-report.json`
- PASS suite on fresh profile: 19/19 (2026-10-20).

Two harness bugs found and fixed along the way:
- old `ko-harness-*` Chromes were not killed by `ko-guest.mjs stop` and kept
  port 9333, so "fresh" runs loaded stale extension code;
- `--yt=<url>` was split on every `=`, truncating watch URLs at `?v`.

Extension fixes in this round:
- popup mapping edits for the **current** channel now apply immediately
  (storage listener mirrors the row into `KO.ytRaw/ytId/kickSlug`);
- disabling the overlay / selecting `player=twitch` now starts the page's own
  paused player instead of handing back a frozen `<video>`.

## 0.8.20 (2026-10-21, best-effort fallback + VOD CSAI)

- [x] Research GitHub adblockers: proxy is the only reliable HD path;
  `video-swap-new`/`vaft` use a clean lower-quality backup and swap back;
  `autoplay` is a last resort because it can hang in loading; VOD ads are CSAI.
- [x] Public proxies rejected: TTV LOL PRO forbids third-party use, public
  nodes are rate-limited and can show "commercial break in progress"; random
  open proxies are unsafe. Own VPS remains the only recommended proxy.
- [x] VOD CSAI block: page `fetch`/XHR intercepts `edge.ads.twitch.tv` and
  IMA/DoubleClick hosts, returning `[]` (200). Verified fetch+XHR return 200
  `[]` and `stats.vodAdsBlocked` increments on the VOD tab.
- [x] Live fallback ladder enabled: on `adExtinf>0`, mute native (no hide
  during probe), mint a clean backup, cover with the hls.js iframe; source
  ladder `site`/`popout`/`mobile_web`/`mobile`/`embed`/`autoplay` last.
- [x] Restore after two clean native playlists; restore visibility, mute state
  and `play()` on all native videos.
- [x] Overlay watchdog (7s, 2 switches), quality badge, click-to-unmute, and
  live-only guard so VOD playlists never trigger the live bypass.
- [x] Manual overlay test on live `auraritylp`: iframe Playing (480p -> 1080p),
  badge visible, native hidden/muted; `ad-end` restored native 1080p playing.
- [x] Automatic trigger on a real live ad (2026-10-22 02:06, `whyandr3w`):
  `adExtinf` rose `0 -> 3 -> ... -> 29`, `bypass.starts` `1..6`,
  `#ko-adfix` appeared with no manual `ad-start`, `stops` `1..2`.
  That tab was backgrounded, so the native video stayed paused at `rs=0` and
  the overlay never reached `Playing`; the watchdog switched/stopped it.
- [ ] Visible real-ad end-to-end check: `bypass.starts=1`, overlay `Playing`,
  no ad audio/video, then `stops=1` and native 1080p restored after two clean
  playlists. (Playback itself is already proven by the manual visible test.)
- [ ] If a real ad still shows for several seconds during the clean-source
  probe, probe `autoplay/android` first during ads (fastest known clean) and
  keep `mobile_web`/`popout` for the switch.
- [ ] Proxy HD still needs an own VPS in an ad-free region; RU/KR egress is
  reportedly capped at 720p.

## 0.8.21 (2026-10-22, durable ad log + detector fix)

- [x] Persist ad events to `chrome.storage.local['ko.adlog']` (ring buffer 500,
  new `sid` per page load, append-only across refresh).
- [x] Bridge logs `boot`, `adblock-change`, `visibility`, `pagehide`.
- [x] Recorder logs `content-play`/`content-stop`, `ad-video-play`,
  `ad-ui-on`/`ad-ui-off`, `ad-tick`, `video-*`, `ad-net` with `ms` since
  navigation.
- [x] Fix false ad UI: ignore "Experimenta 1 mes sem anuncios" promo and scan
  all `stream-display-ad__wrapper` elements (hidden squeezeback can be first).
- [x] Cross-refresh check: 13 -> 28 events, two `sid`s, same storage key.
- [ ] Real preroll with adblock off after a user refresh: read
  `ad-ui-on.d.ms - content-play.d.ms` and use observed + 1s as the delay
  target. Current log is cleared for this run.

## 0.8.22-0.8.24 (2026-10-23, hybrid rewind + first-frame reveal)

- [x] Measure the "4-5s refresh window": ad-only playlist appears 2.85-10.6s
  after load; it appeared at 2.85s **while paused**. The window is
  load/session-based, so a preloaded second player consumes it. The invisible
  infinite-refresh/carousel idea is not viable.
- [x] `ad-hold` rewinds the native 5s (`ad-rewind`) when it is actually
  playing; cold prerolls log `skipped:"not-playing"`.
- [x] Clean iframe starts at `opacity:0.01`, reports `firstframe` from
  `player-bridge.js`, and the native is hidden only on that event (5s fallback
  kept as a safety net).
- [x] Background Edge harness (separate profile/port 9335) so tests do not
  touch the user's Chrome.
- [x] Real ad in the harness: `overlay-reveal` reason `firstframe` 1.48s after
  `ad-start`; overlay 360p played; `ad-end` restored.
- [x] Post-`ad-end` native resume retry (`native-resume` at 0/300/1200ms plus
  Twitch play-button click).
- [x] Confirm resume retry across the channel list (background watcher
  `ko-bg-results3.jsonl`; 6 real pods, every `native-resume now` logged
  paused:false; `hiyo` was paused again at the final sample, likely Twitch
  buffering, and `agurin` load 4 had a second ad).
- [x] Probe `autoplay/android` first on a cold preroll: 0.8.23 cut cold
  hold -> start from 9.4s to 4.30-4.83s (the remaining 3.5s was the prewarm
  wait).
- [x] Validate 0.8.24 prewarm wait 800ms (background `ko-bg-results4.jsonl`):
  7 real pods, 7/7 firstframe, cold hold -> start 1.812-1.920s, prewarm hits
  0-1ms at 1080p, resume 0/300/1200ms all paused:false with rs=4.
- [x] User Chrome live verification on 0.8.24 (`kittykat02_`): ad-hold 7.968s,
  ad-start 10.116s, firstframe reveal 13.322s, 360p Playing, ad-end 55.783s,
  native resumed at 300ms and final rs=4.
- [x] Merge `hybrid-ad-rewind` into `main` and push (main `2e19adc`).
- [x] Sync the user's vendor copy to 0.8.24 (hashes match) and reload the
  extension; the existing tab picks it up on reload.
- [ ] The true no-black/no-freeze swap is still unsolved: hls.js does not
  buffer while the native video is visible; the current best is a short
  native freeze/loading gap, then the clean 360p stream.
