# Twitch ad-time HD source research (2026-10-20)

Goal: find a **clean, web-playable, >=720p** Twitch HLS source that can be used
during an SSAI ad window, instead of the 360p `autoplay/android` fallback used
by the 0.8.15 overlay.

## What is confirmed

### Outside an ad window, every tested token type is clean HD

`node G:\Temp\opencode\ko-token-matrix.mjs vegas` (run just after an ad ended):

```
site    web     -> 1920x1080, adExtinf=0
site    android -> 284x160,   adExtinf=0
site    ios     -> 1920x1080, adExtinf=0
popout  web     -> 1920x1080, adExtinf=0
popout  android -> 640x360,   adExtinf=0
popout  ios     -> 1920x1080, adExtinf=0
mobile  web     -> 1920x1080, adExtinf=0
mobile  android -> 1920x1080, adExtinf=0
mobile  ios     -> 1920x1080, adExtinf=0
android web     -> 1920x1080, adExtinf=0
android android -> 1280x720,  adExtinf=0
android ios     -> (truncated in the run)
```

So HD clean masters exist in general; the problem is the **ad window**.

### During an ad window, every tested web/mobile type was ad-only

Real ad on `twitch.tv/vegas`, 2026-10-20 23:38 local, captured by
`ko-live-ad-test.mjs`:

```
bypass.probe site/web          adExtinf=3  (ad-only)
bypass.probe mobile/android    adExtinf=3  (ad-only)
bypass.probe autoplay/android  adExtinf=0  (clean, 160p/360p)
overlay state=Playing, q=360p
```

Earlier preroll measurements (see `ADBLOCK-FINDINGS.md`) also found all
web-container types ad-only and `autoplay/android` clean. The 0.8.15 overlay
therefore deliberately tries `site/web` first (HD when clean) and falls back to
`autoplay/android` (360p) only when needed.

## Options, ranked

### 1. Kick/YouTube HD overlay first (already shipped)

If the streamer is live on Kick or YouTube, the extension's original overlay
plays the real HD source and the Twitch ad is invisible regardless of the
360p fallback. This is the best outcome and requires no proxy.

### 2. Run the full token matrix **during** a captured ad

Not yet done exhaustively. The 0.8.15 ad-time probe only checks:

- `site/web`
- `popout/web`
- `mobile/android`
- `autoplay/android`

Untested during an ad: `site/ios`, `popout/ios`, `mobile/web`, `mobile/ios`,
`android/web`, `android/ios`, `embed/*`, `picture-by-picture/*`, and different
`X-Device-Id`/session combinations. A dedicated ad-time matrix run is the
cheapest next experiment. If any of them is clean HD, add it before
`autoplay/android` in `findCleanHlsUrl`.

Command to adapt (runs outside ads today):

```
node G:\Temp\opencode\ko-token-matrix.mjs vegas
```

Capture it while the overlay reports `adfix=true`/`adExtinf>0` on the page.

### 3. HLS proxy (TTV LOL PRO-style)

Mint/request the playlist through a server that is not in the ad cohort, then
serve clean segments to the extension. This can give HD but has real costs:

- a server and bandwidth for every viewer;
- Twitch ToS / DMCA risk;
- latency and a new privacy boundary (the proxy sees the channel/token);
- more moving parts than a browser extension.

No proxy was implemented. Treat this as a product decision, not a quick patch.

### 4. Accept 360p during ads

The current overlay is reliable and ad-free; 360p only lasts for the ad pod and
the player returns to 1080p afterwards. For a Twitch adblock this is a
reasonable trade-off until option 2 finds a clean HD type.

## Recommendation

1. Run option 2 during the next real ad before investing in a proxy.
2. Keep `site/web` first so HD is used automatically whenever Twitch leaves it
   clean.
3. Do not re-enable `ALL_AD_FALLBACK`; feeding `autoplay/android` into Twitch's
   MSE left the player permanently paused (measured).
