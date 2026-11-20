# Privacy Policy for RedMux — Reddit Video + Audio Downloader

**Effective Date:** November 19, 2026

RedMux operates entirely on your local device. We do **not** operate external servers, analytics services, telemetry endpoints, or user databases. RedMux does not collect, transmit, store remotely, or sell any personal data or browsing history.

## Information Processed Locally
- **Reddit Page & Media Metadata:** Inspects Reddit pages or fetches post metadata and `DASHPlaylist.mpd` manifests solely within your browser to locate video and audio stream URLs.
- **Media Streams (`v.redd.it`):** Downloads video and audio tracks directly from Reddit's CDN into temporary browser memory (`Blob`), combines them locally into a single `.mp4`, and saves the file via the browser's `downloads` API. Temporary Blob URLs are revoked automatically when downloads complete.
- **User Preferences:** Stored locally via `chrome.storage.local` and never transmitted off your device.

## Direct Connections to Reddit
Your browser connects directly to `reddit.com`, `redd.it`, and `v.redd.it`. Post metadata requests may use your existing browser session (`credentials: "include"`) so logged-in or age-restricted posts you can already view resolve properly; media stream downloads from `v.redd.it` are sent without credentials (`credentials: "omit"`).

## Permissions Used
- `downloads`: Save combined `.mp4` files to your Downloads folder.
- `storage`: Persist local user preferences.
- `activeTab` & host permissions (`*.reddit.com`, `v.redd.it`, `redd.it`): Detect video posts on Reddit tabs and fetch video/audio streams directly.
- `contextMenus`: Add the right-click download menu item on Reddit pages.
- `offscreen`: Run `DOMParser` (for `DASHPlaylist.mpd`) and `URL.createObjectURL` (for saving combined MP4 Blobs) locally inside a hidden Manifest V3 offscreen document.

## Third-Party Sharing
None. RedMux contains no third-party SDKs, ads, or trackers.
