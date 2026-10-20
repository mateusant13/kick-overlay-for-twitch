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
  - vendor synced (hashes match); persistent profile reloaded 0.8.6 -> 0.8.7
    via a hidden extension page (`_tools/ko-reload-persistent.mjs`), no window,
    tab, or Chrome restart.

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
