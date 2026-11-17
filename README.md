# video.webcli.app

The goal is an iMovie-like video editor for the web: your screen, camera, microphone, and existing clips in; an edited video with captions out. This is the only Web-CLI family tool that captures; it is not [ffmpeg.webcli.app](https://ffmpeg.webcli.app), which transforms files you already have, or [hls.webcli.app](https://hls.webcli.app), which packages and manages a published library.

The Loom distinction matters: Loom uploads your screen recording to Loom. This tool is designed to keep capture in your browser.

## Run locally

Serve this directory over `localhost` (required for screen capture and the origin-private file system):

```sh
python3 -m http.server 8000
```

Open `http://localhost:8000/`. The included export bundle runs locally; rebuilding it requires installing development dependencies. The page has a restrictive Content Security Policy with `connect-src 'none'`; its scripts, styles, and capture data are local.

## Capture and recovery

Start capture only from the **Start capture** action. Screen, optional camera, and optional microphone are recorded as separate MediaRecorder tracks. Camera and microphone each require a separate opt-in. Chunk data is written to the origin-private file system (OPFS), with IndexedDB used when OPFS is unavailable. The small IndexedDB manifest is updated as chunks arrive. If a tab is reopened with an unfinished session, the app offers to recover it; recorded chunks can be downloaded per track.

Browser storage is subject to the browser's quota and eviction policy. Keep a second copy of important work; no browser application can guarantee recovery after the browser or device removes its origin storage.

## Editing

Import browser-supported video files into the media library and add them to the timeline. Select clips to trim them by source time, split at the playhead, reorder, remove, or undo. Drag clips to reorder them, and drag the red timeline playhead to seek; the move buttons and preview seek slider remain available for keyboard use. Preview plays the assembled sequence locally. Captured screen and camera tracks appear in the library after recording or recovery; the microphone remains a separate downloadable source and is not mixed into preview.

Imported files and the edit timeline currently live only in the open tab: they are not restored on reload. Keep your original files. **Export project** downloads OTIO-shaped timeline JSON only; importing or relinking that project is not implemented. Captured source chunks continue to use persistent browser storage.

Choose **Import SRT captions** to place cues on the global timeline. They appear in preview and stay at their original timeline times when clips are reordered or trimmed. Importing another SRT replaces the existing captions; **Remove captions** clears them, and **Undo** restores the previous caption state. Captions extending beyond the sequence must be corrected before export.

## Video export

Below the timeline, choose **Burn into video** for permanently visible captions or **Selectable subtitle track** for WebVTT captions that a player can turn on or off. Then choose **Export MP4** and use the download links when rendering completes. Selectable WebVTT-in-MP4 captions may not be supported by all players.

The browser renders clips at 30 fps at the first clip's dimensions (other clips are letterboxed), and encodes H.264 video and, when present, AAC audio. Audio from video clips is included; files with multiple audio tracks and unsupported decoding or encoding are reported instead of silently omitting audio. A browser with the necessary WebCodecs and OPFS support is required.

Download the video, encoder/timeline manifest, dependency licenses, and `files.sha256` using the separate links. Export files are stored in browser origin storage and count against its quota. Clearing this site's data removes them **and any stored captures**, so download anything you want to keep first. Encoding is browser-dependent, so identical exports are not guaranteed to have identical bytes. Export does not upload media.

## Current implementation boundary

The capture project model supports title, audio level, and inset layout metadata; these are not applied to the editor preview or video export. Captured microphone and camera tracks are not mixed or composited into the video automatically. The export uses WebCodecs and the locally bundled Mediabunny muxer, not ffmpeg.wasm.

The tools run on separate origins and cannot share browser storage. Until the family adopts a user-granted shared directory, moving media to whisper or hls requires downloading it and importing it in the other tool.

## Development

Install dependencies with `npm ci`, rebuild the export bundle with `npm run build`, and run the tests with `npm test`. The app uses modern Chromium APIs (`getDisplayMedia`, MediaRecorder, OPFS where available, and IndexedDB fallback).
