# TODO - Kick & YouTube Overlay for Twitch

**Status: COMPLETE.** Version **0.8.29** was validated by the owner in real use
on 2026-10-23. Version **0.8.30** adds two follow-up fixes for YouTube mode and
the YouTube-to-Kick fallback. There are no open items.

The detailed evidence for every fix is in
`kick-overlay/ADBLOCK-FINDINGS.md`. Older revisions of this TODO, including the
investigations that led to 0.8.8-0.8.29, remain in the git history.

## Final validation (2026-10-23)

- [x] Owner tested 0.8.29 on a real Twitch live and reported:
  > "testei. parece que funcionou muito bem."
- [x] The previously reported **unmuted but silent after the ad** failure did
  not reproduce. 0.8.29 captures and restores both `muted` and `volume`.
- [x] No new freeze, backward jump, or doubled-audio report came with this
  validation. The 0.8.27-0.8.29 guards remain in place:
  no warm rewind, reveal only after a healthy `Playing` (`readyState >= 3`),
  stop/restore native on stall or ad-only, never unmute a hidden/unrevealed
  standby, re-mute/re-hide native videos on every position tick.
- [x] The hidden standby uses `autoplay/android` (360p), the source measured
  clean during SSAI. HD web tokens no longer become ad-only mid-pod and force a
  source switch during a long pod.
- [x] Vendor copy synced to 0.8.29; extension reloaded; existing tabs pick it up
  after one refresh.

## Follow-up 0.8.30 (2026-10-23)

- [x] YouTube mode now uses YouTube red for the seek fill and thumb. Kick keeps
  its green. The green bar was the remaining Kick visual while YouTube was
  selected.
- [x] If YouTube is selected but no usable source exists, the overlay probes
  Kick before giving up. It switches only when Kick is live, so an offline
  same-name channel cannot create a black frame.
- [x] The fallback uses the mapped Kick channel, or the same Twitch name when
  there is no mapping. The stored preference stays YouTube; the fallback is
  session-only and the next page load tries YouTube again.
- [x] README now explains same-name multi stream, the YouTube-to-Kick fallback,
  the bar colors, and the cold-open ad path. It also states that the page is not
  auto-refreshed.
- [x] Manifest and vendor copy synced to 0.8.30. Edge tests: `rodil` rendered
  YouTube at 1080p with a red bar; `FaturetoSL` with no YouTube mapping fell
  back to a live Kick player.

## Delivered

- [x] Isolated test harness (separate profile/port; never the visible Chrome).
- [x] Kick overlay: live/DVR, seek, pause, mute, quality, back-to-live.
- [x] YouTube overlay: resolve live/video, mint HLS, live edge, controls.
- [x] Per-channel Kick/YouTube mapping, saved locally and editable in the popup.
- [x] Twitch live adblock:
  - [x] playback-token rewrite (`popout`) and worker playlist hooks;
  - [x] stitched-ad line stripping, including PBP/stream-display-ad playlists;
  - [x] permanent hidden standby player, revealed only when healthy;
  - [x] no black frame: keep the previous clean frame during a source switch;
  - [x] no 4-5s rewind on the warm path;
  - [x] no doubled audio: hidden standby stays muted; native videos are
    re-muted/re-hidden while covered;
  - [x] stall/ad-only recovery restores the native player instead of freezing.
- [x] Audio restoration after an ad: `muted` + `volume` saved/restored for the
  native video, the hold state, and every hidden native video.
- [x] Twitch VOD CSAI ad-request blocking.
- [x] Durable local ad log (`ko.adlog`, ring buffer) for zero-context diagnosis.
- [x] Docs: `README.md`, `kick-overlay/ADBLOCK-FINDINGS.md`,
  `kick-overlay/ADBLOCK-HD-RESEARCH.md`, this TODO.
- [x] Commit/push on `main` and `hybrid-ad-rewind`.

## Accepted behavior (not defects)

- **Live ad quality:** the clean overlay is 360p during an ad pod; the native
  player returns to the selected quality (up to 1080p) when the pod ends. This
  is intentional: it avoids the HD-token-goes-ad-only path that caused freezes.
- **Cold preroll:** the native ad can be visible and muted for a few seconds
  while the clean player reaches a healthy `Playing`. A frozen clean frame is
  deliberately avoided.
- **Twitch changes:** if Twitch changes the SSAI format, the adblock may need an
  update. The findings log is the starting point for diagnosis.
- **VOD:** the block targets CSAI requests; a future Twitch delivery change may
  require new hosts.
- The extension is not affiliated with Twitch, Kick, or YouTube.

## Reproduce the checks

```powershell
node _tools/ko-harness.mjs check --fresh --yt='https://www.youtube.com/watch?v=3cOk_W3ewcE'
```

The harness uses a separate profile/port so it does not touch the user's visible
Chrome. Report: `G:\Temp\opencode\ko-harness-report.json`.

For the ad path, the Edge scenarios in `ADBLOCK-FINDINGS.md` cover:
standby 360p `Playing`; `ad-hold` native `muted:true, volume:0`; `ad-end` native
`muted:false` with the original volume; pointerdown cannot unmute the standby;
a forced source switch keeps the old visible frame until the replacement is
healthy.
