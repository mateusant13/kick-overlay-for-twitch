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
