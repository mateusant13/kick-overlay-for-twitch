# TODO - Kick & YouTube Overlay for Twitch

**Status:** Version **0.8.41** adds instrumentation only (no behaviour change)
and names the cause of the YouTube `player=kick` black box: the IVS frame posts
`ready` to the hardcoded `https://www.twitch.tv` origin, which the browser drops
on a youtube.com page, so the handshake never starts. Version **0.8.40** makes
the ad path respect the user's last mute decision: a muted user keeps a muted
clean player through an ad pod, and an unmute asked for during the pod survives
the ad-end. Version **0.8.39** stops the overlay from following a stale player
after an SPA navigation inside a channel (`/<canal>/clips`, `/videos`, …) and
from doing the same on YouTube channel pages. The owner's click-through
validation of 0.8.39 is with the manager.

The detailed evidence for every fix is in
`kick-overlay/ADBLOCK-FINDINGS.md`. Older revisions of this TODO, including the
investigations that led to 0.8.8-0.8.29, remain in the git history.

## 0.8.41 (2026-10-26) instrumentation: black box over a YouTube watch page with `player=kick`

Not part of 0.8.39. Reproduced in the isolated guest profile on 2026-10-26;
not reproduced in the owner's Chrome, not claimed as fixed.

Reproduction:

1. `node _tools/ko-harness.mjs start https://www.youtube.com --fresh`
2. Write `ko.v2` with `{ enabled: true, player: "kick", mappings: { rodil: { kick: "rodil", yt: "https://www.youtube.com/watch?v=jfKfPfyJRdk" } } }`.
3. Open `https://www.youtube.com/watch?v=jfKfPfyJRdk`.

Measured before instrumentation (guest profile, 2026-10-26, 250ms sampling plus
the content script's own console lines):

- `#ko-wrap` covers the YouTube player, `display:block` with
  `ko-kick ko-placed ko-offline`, 749x316 at (0,56), from 3.4s after load.
- At the moment the box appears (3.4s) `#ko-ivs` already exists with a live
  `contentWindow` (frame token `aaeaca`, `KO.frameSeq` 1): `KO.kickReady=false`,
  `KO.kickState=null`, no state yet. The pending `playback_url` (u1) was set at
  3.4s and is only handed to the frame on `ready`.
- First and only frame state arrives at 22.9s: `Idle`. It stays `Idle`.
  `KO.kickEverPlayed=false` for the whole run.
- Page-side capture listener (separate run, armed at 4s): 14 messages in 13s,
  all `st:Idle`; no `ready` and no `ev:error` ever arrived.
- Teardown is the 15s never-played watchdog, measured by its own log line:
  `[ko] kick url never played — teardown rodil Idle` at 41.8s, together with
  `#ko-wrap` and `#ko-ivs` disappearing. It fires on the first probe that sees
  both a non-null state and `urlAge > 15s`; the probe at 21.8s still saw
  `kickState=null`, the next one at 41.8s qualified.
- A new cycle starts at 62.9s (`KO.frameSeq` 2, new frame token `ad5f0b`, new
  url u2): the box covers the player again. Visible cover ~38s, gap ~21s,
  repeating.

### Cause, measured (0.8.41), not inferred

0.8.41 adds counters only: `KO.kickDiag` in `content.js` (what reached the page,
which guard dropped it, what the page sent) and `window.__koBridgeDiag` in
`player-bridge.js` (what the frame posted, to which origin, whether the parent
origin had been learned, and what it received). Nothing changes behaviour.

One correlated sample, guest Chrome, frame token `d20935ab` equal on both sides:

- Frame: `posts.ready=1` at ms=684, `to: "https://www.twitch.tv"`,
  `learned:false`; `posts.st` also to `twitch.tv`; `parentLearnedAt=0`;
  `inbound.total=0`.
- Page: `accepted=0`, `drops={}` — nothing was dropped by the page guards
  (`origin`, `source`, `yt-frame`), `KO.kickReady=false`, `KO.pendingUrl=true`.
- Primitive check on the same frame: a frame→page `postMessage` with
  targetOrigin `https://www.twitch.tv` is delivered **0 times** when the parent
  is `youtube.com`; page→frame with `'*'` and with the extension origin are both
  delivered.
- Causal arm: ONE valid inbound `getState` makes the frame report
  `parentLearnedAt=8432ms`, `learnedFrom={origin:"https://www.youtube.com",
  fromParent:true}`; the page immediately accepts `st` (0 → 2,
  `firstAt.st=9393`). `ready` is still never accepted: it was posted once, at
  684ms, before the origin was known.

So: `player-bridge.js` posts `ready` to `PARENT_ORIGIN`, which stays
`https://www.twitch.tv` until a valid inbound message teaches the frame the real
parent. On a youtube.com page the browser silently drops that post (targetOrigin
mismatch). The content script only sends `load` on `ready`, so the handshake is
circular. It is broken open only when some later show sends `mute/volume/play`
after the frame's `load` event (that is the 21.2s `kickSend` in the earlier run,
which is why `st` appeared at 21.4s and not before). `ready` is never re-posted,
so that frame stays half-initialised until the watchdog tears it down.

Instrumentation is in 0.8.41; the fix is NOT applied.

Proposed fix (needs the manager's go-ahead, new version): address the parent
before the origin is known (post to `'*'` while `parentLearnedAt` is 0 — the
message carries the per-page token and the content script still validates
`ev.origin` and the source) and/or re-post `ready` when the origin is learned.
Falsifier for the fix: on the same URL, `KO.kickReady` becomes true and the
layer reaches `Playing`, with the frame's first `ready` post still
`learned:false`.

Acceptance for closing this item:

- the four reproduction facts above stay true and reproducible: exact video
  URL, `player=kick`, the IVS frame state when the box appears, and the log line
  that identifies the teardown branch;
- the same sample in the owner's Chrome, not only the guest profile.

## 0.8.40 (2026-10-26)

- [x] The clean ad player no longer unmutes a user who had muted. Owner report:
  "when i mute, the ad comes, player swaps, it unmutes. respect the last user
  decision." `revealOverlay()` sent `mute:false` unconditionally; the native
  mute was captured but only used to restore the native player at ad-end.
  Now `overlay.muteIntent` holds the decision, seeded from the native `<video>`
  at takeover (`adoptNativeMute()` on ad-hold and on a standby adoption, so a
  standby minted at page load cannot carry a stale state), flipped only by an
  explicit badge click, read at reveal (stay muted, badge says "clique para
  som") and at ad-end (`v.muted = overlay.muteIntent`).
- [x] A generic page click (chat, layout) no longer restores audio: the
  document-wide `pointerdown` handler only retries the autoplay unlock when the
  user had sound on. The badge click is the explicit request.
- [x] `kick-overlay/mute-decision-test.cjs` runs the real `twitch-adblock.js`
  through the real ad path in a stubbed DOM (ad-hold, ad-start, frame ready,
  3 healthy `Playing` ticks, reveal) and asserts the wire messages, the badge
  text and the ad-end restore. Its negative arm replays the pre-fix gate and
  must see `mute:false`. Runs in the gate as check `mute-decision`.
- [x] Gate: `RESULT PASS checks=12 failed=0`.
- [ ] Owner validation: mute the stream, wait for a pod, confirm silence + the
  click-to-sound badge, and that the native player returns muted.

## 0.8.39 (2026-10-26)

- [x] The overlay only mirrors a player on routes that own one. Twitch keeps
  `.persistent-player` (and its `<video>`) in the DOM after an SPA navigation,
  so the layer stayed pinned over `/<channel>/clips`, `/videos` and `/about`;
  YouTube keeps `#movie_player` on channel pages. Guest Chrome, before/after on
  `rodil`: wrap `display:block` at 730x142, 533x300 over the clips grid, then
  removed with the native video resumed (`paused:false`); back on the channel
  root it re-mounts over the player (714x325, `ko-placed`).
  `overlayTargetRoute()` in `content.js`, enforced in `probe()` and `rectTick()`.
- [x] `NOT_CHANNEL` also rejects single-segment pages that are not channels
  (`clip`, `following`, `inventory`, `drops`, `squad`, `store`, `activate`).
- [x] `twitchVideo()` ranks the player card inside `main` above portalled clip
  viewers and sidebar hover previews.
- [x] `#ko-wrap` stays `visibility:hidden` until the rect loop places it, so a
  mounted wrap without a measured rect cannot paint at the top of its container.
- [x] `kick-overlay/route-gate-test.cjs` runs inside `node _tools/ko-verify.mjs`
  (check `route-gate`). Gate: `RESULT PASS checks=11 failed=0`.
- [x] Vendor copy synced and the owner's extension reloaded to 0.8.39
  (`loaded=0.8.38 expected=0.8.39` → `after=0.8.39`).
- [ ] Owner click test: mapped channel → **Clips** → **Videos** → back to the
  channel. The overlay must be absent on both sub-pages and cover the player on
  the channel root.

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

## Follow-up 0.8.31 (2026-10-23)

- [x] The page asks for a prewarm from the channel in the pathname at 200ms,
  1s, 2.5s and 5s. The live-master hook remains the fallback for SPA switches
  and for loads where the early request did not reach the worker.
- [x] `prewarmCleanSource()` posts a standby as soon as the `autoplay/android`
  master URL is minted and the master responds OK, before fetching its first
  variant. The full variant probe still runs and replaces the cached URL when
  it finds a different clean source.
- [x] A standby can start before Twitch creates its `<video>`; the hidden frame
  uses a full-viewport 1% surface and `positionOverlay()` attaches it to the
  player container once the native video exists.
- [x] Twitch HLS starts on the lowest rendition (`startLevel: 0`), so a cold
  standby does not race a 1080p segment before the preroll.
- [x] `ad-hold` adopts a buffering standby (`adActive`), and `ad-start` gives
  a young standby 300ms or an older one 900ms to reach healthy `Playing`
  before rebuilding. Timers are cleared on reveal, stop and new overlays.
- [x] Forced standby retries have a 4s cooldown; a minted fast URL is checked
  against the master before it reaches the player, so an offline channel does
  not create a mint/error loop.
- [x] Edge checks: synthetic `ad-hold` + `ad-start` with a warm standby
  revealed in **136-547ms**; real `rodil` prerolls at 3.3s and 4.3s still
  rebuilt because the ad beat the 2.6-3.3s fast prewarm; `alanzoka` had no
  preroll but its standby became healthy; offline `duda` produced no standby
  or retry loop.
- [ ] Owner needs to F5 a real cold open on 0.8.31. The cold window is now
  shorter, but an ad that lands before the standby is healthy can still show
  muted native video. That tradeoff is deliberate: a frozen/black cover was
  rejected.

## Player 1:1 decision (2026-10-23)

- [x] Searched for an existing production clone of the Kick or YouTube player.
  None was found; multi-stream projects use the official embeds, and the
  Video.js YouTube skin is explicitly pre-release.
- [x] Verified the official Kick embed (`https://player.kick.com/{channel}`)
  and its documented `autoplay`, `muted` and `allowfullscreen` parameters.
  Inspected its bundle: it has no parent-window `message` API for play/pause/
  mute, so a wrapper cannot control it.
- [x] Verified the YouTube IFrame API exists, but the project already measured
  the live embed failing on bot-gated/cookieless sessions; it can also show
  YouTube ads.
- [x] **Decision:** keep the current overlay (Amazon IVS for Kick, hls.js for
  YouTube). Do not build a full clone. The popup now has **Abrir no site
  oficial** for a true 1:1 experience.
- [x] Research and sources are recorded in
  `kick-overlay/PLAYER-1TO1-RESEARCH.md`.

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
- **Cold preroll:** the native ad can still be visible and muted for a short
  window while the clean player reaches a healthy `Playing`. 0.8.31 starts the
  prewarm earlier and posts the standby before the full probe, but an ad that
  arrives before the standby is healthy cannot be covered without showing a
  frozen frame, which is deliberately avoided.
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
