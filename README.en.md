# Kick & YouTube Overlay for Twitch (with new AdBlock Approach)

**Language:** [Português](README.md) | English

The extension places Kick or YouTube video over the Twitch player. It also blocks Twitch ads.

## Features

- Plays Kick and YouTube streams over the Twitch player.
- Blocks ads on Twitch live streams and VODs.
- Restores mute and volume settings after ads.
- Configures a different player for each Twitch channel.
- Falls back to Kick when YouTube is unavailable, and to Twitch when neither is available.
- Keeps Twitch chat and the rest of the page working.
- No login.

Ad blocking is experimental and may not work in every situation.

## How ad blocking works

Twitch inserts ads into the live stream. The extension tries to block the ad before it loads. If the ad is already in the stream, it switches to an ad-free version prepared in the background.

That version stays hidden and muted until it is needed. When the break ends, the extension returns to the normal Twitch player and restores mute and volume.

If the ad-free version is not ready, the extension keeps the normal player in place instead of showing a black screen. It does not reload the page automatically.

## Installation

1. Download the repository via **Code** → **Download ZIP**.
2. Extract the ZIP.
3. Open `chrome://extensions` in Chrome or another Chromium browser.
4. Enable **Developer mode**.
5. Click **Load unpacked** and select the `kick-overlay` folder.
6. Open Twitch and reload the page.

The extension is not published in the Chrome Web Store. The `kick-overlay` folder must stay on your computer.

## Usage

1. Open a Twitch channel and click the extension icon.
2. Choose the player:
   - **Twitch:** uses the native player.
   - **Kick:** enter the Kick channel, or leave it blank to use the same name as the Twitch channel.
   - **YouTube:** enter the live stream URL, the `@handle`, or the channel ID.
3. Click **Save**. The setting is stored per Twitch channel.
4. Use the popup to turn the overlay and ad blocking on or off.

The player bar shows the source: green for Kick, red for YouTube. With no project bar, the player is Twitch's native player.

## Troubleshooting

- **I updated the extension and the old behavior remains:** reload the Twitch tab.
- **No audio after the ad:** reload the page and check that the overlay is on.
- **Black screen or stuck player:** turn the overlay off and reload the page.
- **Kick or YouTube does not appear:** check that the channel is live and that the name or URL is correct.
- **An ad appeared:** ad blocking is experimental; check that **Twitch adblock** is on.

## Privacy

Settings and logs stay in your browser. The extension does not collect analytics or send data to a project-owned server.

## Development

Quick verification:

```powershell
node _tools/ko-verify.mjs
```

Technical notes:

- `kick-overlay/ADBLOCK-FINDINGS.md`
- `kick-overlay/PLAYER-1TO1-RESEARCH.md`
- `TODO.md`

## Limitations

- Ad blocking may fail when Twitch changes how it delivers ads.
- In some cases, the pre-roll ad can appear muted for a few moments.
- The overlay is not an exact 1:1 clone of Kick or YouTube. Use **Abrir no site oficial** (Open official site) in the popup for the full interface.
- The extension is not affiliated with Twitch, Kick, or YouTube.

Made by [@mateusant13](https://github.com/mateusant13).
