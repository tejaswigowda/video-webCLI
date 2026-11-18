# video.webcli.app

This is a local-first, iMovie-style web editor: your screen, camera, microphone, and existing clips in; an edited video with captions out. It is the only Web-CLI family tool that captures. It is not [ffmpeg.webcli.app](https://ffmpeg.webcli.app), which transforms files you already have, or [hls.webcli.app](https://hls.webcli.app), which packages and manages a published library.

Loom uploads your screen recording to Loom. This editor records and processes media in your browser and does not upload it to a third-party service.

## Run locally

Screen capture and the origin-private file system require a secure context: **localhost or HTTPS**.

```sh
python3 -m http.server 8000
```

Open `http://localhost:8000/`. The page's Content Security Policy uses `connect-src 'self'`: same-origin resources can load, but connections to third-party origins are blocked. The editor does not need a third-party service to capture, edit, or export.

## Capture and recovery

Capture begins only after selecting **Start capture** and granting the browser's screen-sharing permission. Screen, optional camera, and optional microphone are recorded as separate tracks; camera and microphone are independent opt-ins. The recording indicator and live-source status remain visible while capture is active.

Chunks are written as they arrive to the origin-private file system (OPFS), with IndexedDB as the fallback. The app keeps a small IndexedDB session manifest and offers to recover an unfinished session when reopened. Captured tracks stay in this browser origin; browser storage quotas, eviction, and user-cleared site data can still remove them, so download important source tracks.

## Editing and project recovery

Import browser-supported video files and add them to the timeline. Select clips to trim, split at the playhead, reorder, remove, or undo. Drag clips to reorder them and drag the red playhead to seek. Changes to the timeline, captions, and undo history are saved locally. Files imported with **Import with reload access** store a file handle so access can be requested again after reopening. If a source is unavailable, its clip remains on the timeline as missing until relinked.

**Export project JSON** downloads an OTIO-shaped project, and **Import project JSON** can restore it. Media itself is not embedded in that project: keep the original files available to relink. Captured sources can be restored from this origin's browser storage.

Choose **Import SRT captions** to add cues to the global timeline. They appear in preview and retain their timeline times when clips are reordered or trimmed. Importing another SRT replaces the existing captions; **Remove captions** clears them, and **Undo** restores the previous caption state. Captions extending beyond the sequence must be corrected before export.

## Preview and export

The camera inset is composited over the screen in preview and export. Its corner, size, and shape can be changed after capture. Clip audio and the optional microphone track are mixed with separate gain controls. These operations are performed locally; the microphone remains a separate source track.

Choose **Burn into video** for permanently visible captions or **Selectable subtitle track** for WebVTT subtitles. Then choose **Export MP4** and download the resulting video, manifest, licenses, and `files.sha256`. The MP4 uses H.264 video and AAC audio when the browser supports the required WebCodecs. Audio decoding uses WebCodecs first, with a browser-native fallback limited to source files up to 64 MiB and decoded buffers up to 256 MiB. Unsupported decode or encode paths fail with an explicit error rather than silently dropping audio. Selectable WebVTT-in-MP4 captions may not work in every player.

The editor renders at 30 fps using the first clip's dimensions and letterboxes other clips. The manifest records a SHA-256 hash of the pre-encode frame sequence and declares `frames: true`; it declares `bytes: false` because WebCodecs output varies by browser build and hardware acceleration. Export files are stored in browser-origin storage and count against its quota. Download anything you want to keep before clearing this site's data.

## Handoff and privacy

The page's CSP blocks connections to third-party origins, and capture starts only after explicit user action. The Web-CLI tools run on separate origins and cannot share browser storage. Moving media to whisper or hls therefore requires downloading it and importing it in the other tool; there is no shared cross-origin working directory.

## Development

Install dependencies with `npm ci`, rebuild the export bundle with `npm run build`, and run the tests with `npm test`. The app uses modern browser APIs including `getDisplayMedia`, MediaRecorder, WebCodecs, OPFS where available, and IndexedDB fallback.
