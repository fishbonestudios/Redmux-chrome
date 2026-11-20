# RedMux — Reddit Video + Audio Downloader for Chrome & Chromium

A privacy-first, open-source Manifest V3 extension for **Google Chrome, Brave, Microsoft Edge, Opera, Vivaldi, and Arc** that downloads Reddit (`v.redd.it`) videos with combined audio **100% locally in your browser**—no third-party websites, no FFmpeg installation, and zero tracking.

## Features
- **Pure-JavaScript MP4 Muxer (`mp4-muxer.js`):** Combines separate video and audio tracks from both modern fragmented **CMAF** (`CMAF_720.mp4` + `CMAF_AUDIO_128.mp4`) and legacy **DASH** (`DASH_720.mp4` + `DASH_AUDIO_128.mp4`) streams into a standard, faststart (`moov`-before-`mdat`), interleaved `.mp4` file.
- **Native Chrome MV3 Offscreen Architecture (`offscreen.html` / `offscreen.js`):** Uses Chrome's official `offscreen` API (`BLOBS` + `DOM_PARSER`) so XML manifest parsing, MP4 muxing, and zero-copy `URL.createObjectURL()` work seamlessly for large videos without hitting service worker limits.
- **2026-Proof Stream Resolver (`reddit-resolver.js`):** Extracts media directly from Reddit's DOM (`<shreddit-player>`, `packaged-media-json`, `old.reddit.com`), with fallback to authenticated `.json`, HTML page extraction, `DASHPlaylist.mpd` XML parsing, and parallel stream probing.
- **Three Ways to Download:**
  1. **In-page button** injected automatically onto video posts on `www.reddit.com`, `sh.reddit.com`, and `old.reddit.com`.
  2. **Toolbar popup** with resolution selector (1080p / 720p / 480p / 360p), audio toggle, multi-video page picker, manual URL input, and live progress bar.
  3. **Right-click context menu** on any Reddit video post or link.

## How to Install (Chrome, Brave, Edge, Vivaldi, Opera, Arc)

Unlike Firefox, Chromium browsers let you install unpacked extensions permanently right out of the box—no store signing required:

1. Unzip `redmux-chrome-extension.zip` into a permanent folder on your computer (don't delete the folder afterward).
2. Open your browser's Extensions page:
   - **Chrome:** `chrome://extensions`
   - **Brave:** `brave://extensions`
   - **Edge:** `edge://extensions`
   - **Vivaldi / Opera / Arc:** `chrome://extensions`
3. Toggle **Developer mode** ON (top-right corner in Chrome/Brave, bottom-left in Edge).
4. Click **Load unpacked** and select the extracted folder containing `manifest.json`.
5. Pin **RedMux** to your toolbar and open any Reddit video post.

## Chrome Web Store Publishing
This package is ready to zip and upload directly to the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole):
- Manifest V3 with `service_worker` and `offscreen` document justifications
- Standard 16/32/48/128 PNG icons
- Zero remote code execution, zero `eval()`, zero `innerHTML`
- Includes `PRIVACY.md` and `LICENSE`
