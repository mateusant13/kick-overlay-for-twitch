# KO diagnostic harness

`ko-harness.mjs` is the single entry point for debugging the Kick Overlay
extension without touching the user's visible Chrome. It starts an isolated
headless guest profile, loads the unpacked extension, and exposes the CDP
operations that actually find bugs.

## Fast path

```powershell
# fresh profile + full end-to-end suite (Kick, YouTube, adblock)
node _tools/ko-harness.mjs check --fresh --yt='https://www.youtube.com/watch?v=3cOk_W3ewcE'
```

Exit code is 0 only when every check is PASS/SKIP/WARN. A JSON report and a
1600×900 screenshot are written to `G:\Temp\opencode\`.

## Commands

| Command | Purpose |
| --- | --- |
| `start [url] [--fresh]` | Start guest Chrome (new profile with `--fresh`). |
| `stop` | Kill only `ko-guest*` / `ko-harness*` Chrome processes. |
| `status` | CDP port + page/iframe/service-worker targets. |
| `state` | Compact KO, adblock, and HLS-iframe video snapshot. |
| `set --player=kick\|youtube\|twitch [--yt=URL] [--enabled=0\|1]` | Write `ko.v2` storage; hot-applies. |
| `eval "<expr>" [--world=isolated\|main] [--target=page\|hls\|ivs\|sw]` | Evaluate in the content-script world by default. |
| `click "<selector>" [--synthetic]` | Hit-test + real `Input.dispatchMouseEvent`. |
| `key ArrowLeft\|ArrowRight\|f` | Real CDP key event through the overlay handler. |
| `scrolltest [--width=1600 --height=900 --y=600]` | Force document scroll and compare `#ko-wrap` top with the player anchor. |
| `shot [path]` | 1600×900 PNG. |
| `net --pattern=RE --seconds=N [--target=hls\|page\|sw]` | Capture request/response statuses. |
| `console --seconds=N` | Captured exceptions / console errors. |

## How `check` works

1. Injects KO and sets a 1600×900 viewport so the overlay/chat layout matches a
   normal player; LIVE pill tests use a DOM click because Twitch's consent
   dialog can cover the player.
2. Kick: activate, pause/play, mute/unmute, quality switch, DVR seek, LIVE pill
   (DOM click - Twitch's consent dialog can cover the player and intercept a
   real click), a `seekToLive` sentinel check (`pos < 200s`, never `2^30`), and
   a `kick.step-5` check: ArrowLeft must raise latency immediately, ArrowRight
   must step back toward live, and LIVE must reach the edge.
3. YouTube: mapping hot-apply, resolve live id, HLS iframe `readyState`/buffered,
   10-second `googlevideo` segment probe (fails on 4xx/5xx), quality switch,
   pause/play/mute via the real overlay button, rewind + LIVE click.
4. Adblock: MAIN-world `__koTwitchAdblockStats` (rewrites/hooks/failures) and
   `data-ko-adblock`; a synthetic PlaybackAccessToken probe **captures the
   actual wire body** and asserts `playerType:"popout"` (catches the 0.8.7
   bug where stats incremented but the original `site` body was forwarded);
   then disables the overlay and verifies the native Twitch `<video>` actually
   advances with the worker hook active.
5. Captures page/HLS/IVS/SW exceptions and screenshots the final frame.

Current suite: **21 checks** (21/21 PASS on 2026-10-20 at `jb_sniper` + a live
YouTube HLS video).

## Fast evidence gate (no browser)

```powershell
node _tools/ko-verify.mjs
```

This is the cheap gate for every code change. It does not start Chrome and
does not touch the live profile. It checks:

- `node --check` on the product JS files;
- manifest v3, semver, and packaged files;
- no `location.reload`, `location.href = location.href`, or meta refresh;
- the cold-open markers (`prewarm.fast`, early retry times, grace timer,
  `startLevel: 0`);
- the 1:1 research and official-site shortcut are documented;
- the bug ledger schema and the independent-verifier rule.

It also executes two **negative arms**: the auto-refresh detector must reject
a synthetic `location.reload()`, and the cold-contract detector must reject a
copy with `prewarm.fast` removed. If either detector accepts its mutation, the
gate fails. That is the point: a detector that has never failed is not evidence.

The receipt is written to `_evidence/ko-verify-latest.json` and
`_evidence/ko-verify-latest.md` with the timestamp, git head, version, each
check, the source hashes, and a **NOT MEASURED** list. If a ledger bug is
`fixed` but not independently `verified`, the gate prints
`FIXED, NOT VERIFIED` in large letters. It does not silently turn a commit
into a verification.

This gate does **not** replace `ko-harness.mjs check`; it proves static
properties and detector behavior only. The live/harness suite remains the
runtime gate.

## What is NOT measured

- A real cold preroll in the owner Chrome on the current build.
- Long-run stability on a real live stream.
- Edge synthetic timings as a substitute for the owner measurement.
- The heavy `ko-harness.mjs check` suite (not run by `ko-verify.mjs`).
- JS-side profiling; there is no equivalent of a `py-spy` run yet.
- A `verified` bug state; that needs an independent verifier and a real app
  run, neither of which a lane can supply alone.

## Updating the user's live install

`ko-reload-persistent.mjs` reloads the unpacked KO in the debug profile
(`127.0.0.1:9222`) **without a visible tab, window, or Chrome restart**:

```powershell
node _tools/ko-reload-persistent.mjs --dry-run   # read current version
node _tools/ko-reload-persistent.mjs             # hidden page -> runtime.reload()
```

It creates a hidden extension page (`Target.createTarget` with
`hidden:true, background:true`), calls `chrome.runtime.reload()`, then verifies
the new version via `Extensions.getExtensions`. Existing tabs may keep the old
content script until they are refreshed; the extension itself is current.

## Gotchas

- Fresh profile per code change: `Extensions.loadUnpacked` on an existing
  profile can serve stale files. `check --fresh` creates `G:/Temp/ko-harness-<ts>`.
- `ko-guest.mjs stop` must match **both** `ko-guest*` and `ko-harness*`; an old
  harness Chrome otherwise holds port 9333 and tests silently run old code.
- The page's content script lives in the **isolated** world; adblock stats live
  in the **main** world. `state` reads both.
- YouTube mapping edits for the current channel are mirrored into `KO.ytRaw` by
  the storage listener; before that fix they required a page reload.
- `resumeNativePagePlayer()` is what makes `player=twitch` / overlay-off hand
  back a playing native player; `resumeTwitchIfOurs()` only restores videos KO
  paused while they were already playing.
