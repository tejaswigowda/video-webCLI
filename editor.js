import { loadEditorProject, loadTrackBlob, saveEditorProject } from "./storage.js";
import { renderVideo } from "./export-bundle.js";
import { cameraTimeForClip, drawComposite } from "./compositor.js";
import { captionsAt, parseSrt } from "./subtitles.js";
import {
  addClip, clipsOf, locateTime, moveClip, newEditorTimeline, removeClip, reorderClip, splitClip,
  setCaptions, timelineDuration, trimClip
} from "./editor-model.js";

const $ = (id) => document.getElementById(id);
const elements = Object.fromEntries([
  "editor-message", "media-input", "media-list", "media-count", "preview", "viewer-empty",
  "preview-time", "preview-duration", "play-button", "playhead", "seek-start", "seek-end",
  "timeline-clips", "clip-count", "timeline-duration", "inspector-empty", "inspector-content",
  "selected-name", "source-duration", "clip-duration", "trim-start", "trim-end", "apply-trim",
  "remove-clip", "split", "move-left", "move-right", "undo", "editor-export",
  "srt-input", "remove-captions", "caption-count", "preview-captions",
  "export-video", "caption-mode", "export-status", "export-downloads",
  "import-handles", "project-input", "preview-composite", "preview-camera", "preview-microphone"
].map((id) => [id, $(id)]));

const sources = new Map();
let timeline = newEditorTimeline();
let selectedId = null;
let positionMs = 0;
let history = [];
let currentClipId = null;
let previewRequest = 0;
let draggedClipId = null;
let animationFrame = null;
let projectReady = false;
let persistTimer = null;
let audioContext;
let previewClipGain;
let previewMicrophoneGain;
let previewMicrophoneSource;

function sourceRecord(source) {
  return {
    id: source.id,
    name: source.name,
    durationMs: source.durationMs,
    reference: source.reference,
    kind: source.kind,
    mimeType: source.file?.type ?? source.mimeType,
    handle: source.handle ?? null,
    sessionId: source.sessionId ?? null,
    trackId: source.trackId ?? null
  };
}

function persistProjectSoon() {
  if (!projectReady) return;
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    saveEditorProject({
      timeline,
      history,
      selectedId,
      positionMs,
      sources: [...sources.values()].map(sourceRecord)
    }).catch((error) => message(`Could not save this edit: ${error.message}`, true));
  }, 150);
}

function message(text, isError = false) {
  const box = elements["editor-message"];
  box.textContent = text;
  box.classList.toggle("error", isError);
  box.classList.remove("hidden");
}

function formatTime(ms, decimal = false) {
  const safe = Math.max(0, Math.floor(ms));
  const minutes = Math.floor(safe / 60000);
  const seconds = Math.floor(safe / 1000) % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}${decimal ? `.${Math.floor((safe % 1000) / 100)}` : ""}`;
}

function sourceDuration(file) {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    const url = URL.createObjectURL(file);
    const finish = (error, duration) => {
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
      if (error) reject(error);
      else resolve(duration);
    };
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      if (!Number.isFinite(video.duration) || video.duration <= 0) {
        finish(new Error("The browser could not determine the clip duration."));
      } else {
        finish(null, Math.round(video.duration * 1000));
      }
    };
    video.onerror = () => finish(new Error("The browser cannot open this video."));
    video.src = url;
  });
}

async function addSource(file, options = {}) {
  const durationMs = options.durationMs || await sourceDuration(file);
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error("The video has no usable duration.");
  const id = options.id || crypto.randomUUID();
  const previous = sources.get(id);
  if (previous?.url) URL.revokeObjectURL(previous.url);
  sources.set(id, {
    id,
    name: options.name || file.name,
    durationMs,
    reference: options.reference || encodeURIComponent(file.name),
    kind: options.kind || "video",
    mimeType: options.mimeType || file.type,
    handle: options.handle || previous?.handle || null,
    sessionId: options.sessionId || previous?.sessionId || null,
    trackId: options.trackId || previous?.trackId || null,
    file,
    url: URL.createObjectURL(file)
  });
  renderMedia();
  persistProjectSoon();
}

function renderMedia() {
  elements["media-count"].textContent = String(sources.size);
  elements["media-list"].replaceChildren();
  for (const source of sources.values()) {
    const row = document.createElement("div");
    row.className = "media-item";
    const thumb = document.createElement("span");
    thumb.className = "media-thumb";
    thumb.textContent = "▶";
    const info = document.createElement("span");
    info.className = "media-info";
    const name = document.createElement("strong");
    name.textContent = source.name;
    name.title = source.name;
    const duration = document.createElement("small");
    duration.textContent = formatTime(source.durationMs, true);
    info.append(name, duration);
    if (!source.file) row.classList.add("source-missing");
    if (!source.file) {
      duration.textContent = "Missing — relink to restore";
      row.title = source.restoreError ?? "Choose Relink to grant access or locate this file.";
    }
    const actions = document.createElement("span");
    actions.className = "media-actions";
    if (source.kind === "video") {
      const button = document.createElement("button");
      button.className = "media-add";
      button.textContent = "+";
      button.title = `Add ${source.name} to timeline`;
      button.setAttribute("aria-label", button.title);
      button.disabled = !source.file;
      button.addEventListener("click", () => {
        const clipId = crypto.randomUUID();
        mutate(() => addClip(timeline, source, clipId), clipId, timelineDuration(timeline));
      });
      actions.append(button);
    } else {
      const audioKind = document.createElement("small");
      audioKind.textContent = "Audio track";
      actions.append(audioKind);
    }
    if (!source.file) {
      const relink = document.createElement("button");
      relink.className = "text-button";
      relink.textContent = "Relink";
      relink.addEventListener("click", () => relinkSource(source.id).catch((error) => message(`Could not relink ${source.name}: ${error.message}`, true)));
      actions.append(relink);
    }
    row.append(thumb, info, actions);
    elements["media-list"].append(row);
  }
}

async function restoreSource(record) {
  const source = { ...record, file: null, url: null, handle: record.handle ?? null };
  try {
    if (source.handle && await source.handle.queryPermission({ mode: "read" }) === "granted") {
      source.file = await source.handle.getFile();
    } else if (source.sessionId && source.trackId) {
      const session = await loadTrackBlob(source.sessionId, source.trackId);
      source.file = new File([session], source.name, { type: source.mimeType || (source.kind === "audio" ? "audio/webm" : "video/webm") });
    }
  } catch {
    source.file = null;
    source.restoreError = "Stored media is unavailable or permission is required.";
  }
  if (source.file) source.url = URL.createObjectURL(source.file);
  sources.set(source.id, source);
}

async function restoreProject() {
  try {
    const saved = await loadEditorProject();
    if (saved?.timeline?.OTIO_SCHEMA === "Timeline.1") {
      timeline = saved.timeline;
      history = Array.isArray(saved.history) ? saved.history : [];
      selectedId = saved.selectedId ?? null;
      positionMs = Math.min(saved.positionMs ?? 0, timelineDuration(timeline));
      for (const record of saved.sources ?? []) await restoreSource(record);
      const metadataSources = timeline.metadata?.webcli?.sources ?? [];
      for (const record of metadataSources) {
        if (!sources.has(record.id)) await restoreSource(record);
      }
    }
    projectReady = true;
    renderMedia();
    render();
    if (timeline.metadata?.webcli?.capture_settings) {
      window.dispatchEvent(new CustomEvent("video-editor-settings-restored", {
        detail: timeline.metadata.webcli.capture_settings
      }));
    }
    await showPosition(positionMs);
    if (sources.size || clipsOf(timeline).length) message("Restored this editor project from local browser storage.");
  } catch (error) {
    projectReady = true;
    render();
    message(`Could not restore the editor project: ${error.message}`, true);
  }
}

async function importWithHandles() {
  if (!window.showOpenFilePicker) {
    throw new Error("File System Access is unavailable. Use the regular import control; those files can be relinked manually after reopening.");
  }
  const handles = await window.showOpenFilePicker({
    multiple: true,
    types: [{ description: "Video files", accept: { "video/*": [".mp4", ".mov", ".webm", ".mkv", ".m4v"] } }]
  });
  for (const handle of handles) {
    await addSource(await handle.getFile(), { handle });
  }
}

async function relinkSource(id) {
  const source = sources.get(id);
  if (!source) throw new Error("Source record not found.");
  let handle = source.handle;
  if (handle) {
    const permission = await handle.requestPermission({ mode: "read" });
    if (permission !== "granted") throw new Error("Read permission was not granted.");
  } else {
    if (!window.showOpenFilePicker) throw new Error("This browser cannot open the file picker needed to relink media.");
    [handle] = await window.showOpenFilePicker({
      multiple: false,
      types: [{ description: source.kind === "audio" ? "Audio files" : "Video files", accept: { [source.kind === "audio" ? "audio/*" : "video/*"]: [] } }]
    });
  }
  const file = await handle.getFile();
  if (source.kind === "video") {
    const durationMs = await sourceDuration(file);
    const requiredMs = clipsOf(timeline)
      .filter((clip) => clip.metadata.webcli.source_id === id)
      .reduce((end, clip) => Math.max(end, clip.source_range.start_time.value + clip.source_range.duration.value), 0);
    if (durationMs < requiredMs) throw new Error("The selected file is shorter than the timeline's saved source range.");
    source.durationMs = durationMs;
  }
  source.handle = handle;
  await addSource(file, { ...source, id, handle, durationMs: source.durationMs });
  message(`Relinked ${source.name}.`);
}

async function importProjectFile(file) {
  let imported = JSON.parse(await file.text());
  if (imported?.OTIO_SCHEMA !== "Timeline.1" ||
      imported.tracks?.OTIO_SCHEMA !== "Stack.1" ||
      !Array.isArray(imported.tracks.children)) {
    throw new Error("The file is not a supported video.webcli OTIO project.");
  }
  const captureMetadata = imported.metadata?.webcli ?? {};
  const existingVideoClips = imported.tracks.children[0]?.children;
  if ((!Array.isArray(existingVideoClips) || !existingVideoClips[0]?.metadata?.webcli?.source_id) &&
      captureMetadata.session_id) {
    const records = captureMetadata.sources ?? imported.tracks.children
      .filter((track) => track.metadata?.webcli?.source_track_id)
      .map((track) => {
        const trackId = track.metadata.webcli.source_track_id;
        const durationMs = track.children?.[0]?.media_reference?.available_range?.duration?.value ?? 1;
        return {
          id: `${captureMetadata.session_id}/${trackId}`,
          name: `${track.name} recording`,
          durationMs,
          reference: `webcli://session/${captureMetadata.session_id}/track/${trackId}`,
          kind: track.kind,
          sessionId: captureMetadata.session_id,
          trackId
        };
      });
    const screen = records.find((record) => record.trackId === "screen" || /screen/i.test(record.name));
    if (!screen) throw new Error("The capture project has no screen track to place on the timeline.");
    const normalized = newEditorTimeline();
    normalized.name = imported.name;
    normalized.metadata.webcli = {
      ...normalized.metadata.webcli,
      ...captureMetadata,
      sources: records,
      captions: Array.isArray(captureMetadata.captions) ? captureMetadata.captions : [],
      capture_sources: {
        screen: screen.id,
        camera: records.find((record) => record.trackId === "camera")?.id ?? null,
        microphone: records.find((record) => record.trackId === "microphone")?.id ?? null
      }
    };
    timeline = addClip(normalized, screen, crypto.randomUUID());
    const captureClip = imported.tracks.children.find((track) => track.metadata?.webcli?.source_track_id === screen.trackId)?.children?.[0];
    if (captureClip?.source_range) {
      timeline = trimClip(timeline, clipsOf(timeline)[0].metadata.webcli.clip_id,
        captureClip.source_range.start_time.value,
        captureClip.source_range.start_time.value + captureClip.source_range.duration.value);
    }
    imported = timeline;
  }
  if (!Array.isArray(imported.metadata?.webcli?.captions)) imported.metadata.webcli.captions = [];
  const clips = imported.tracks.children[0]?.children;
  if (!Array.isArray(clips) || clips.some((clip) =>
    clip.OTIO_SCHEMA !== "Clip.1" ||
    typeof clip.metadata?.webcli?.source_id !== "string" ||
    !Number.isFinite(clip.source_range?.start_time?.value) ||
    !Number.isFinite(clip.source_range?.duration?.value) ||
    clip.source_range.duration.value <= 0)) {
    throw new Error("The project contains an invalid video clip or source reference.");
  }
  history = [];
  selectedId = null;
  positionMs = 0;
  timeline = imported;
  for (const record of imported.metadata.webcli.sources ?? []) {
    if (!sources.has(record.id)) await restoreSource({ ...record, handle: null });
  }
  renderMedia();
  render();
  persistProjectSoon();
  await showPosition(0);
  message("Imported the OTIO project. Any unavailable media remains on the timeline as missing until relinked.");
}

function selectedClip() {
  return clipsOf(timeline).find((clip) => clip.metadata.webcli.clip_id === selectedId);
}

function clipStart(id) {
  let start = 0;
  for (const clip of clipsOf(timeline)) {
    if (clip.metadata.webcli.clip_id === id) return start;
    start += clip.source_range.duration.value;
  }
  return 0;
}

function updateCaptionPreview(position) {
  const text = position < timelineDuration(timeline)
    ? captionsAt(timeline.metadata.webcli.captions, position)
    : "";
  elements["preview-captions"].textContent = text;
}

function captureSources() {
  return timeline.metadata?.webcli?.capture_sources ?? {};
}

function compositeLayout() {
  const settings = timeline.metadata?.webcli?.composite?.arguments ?? {};
  return { position: settings.position, size: settings.size, shape: settings.shape };
}

function audioMix() {
  return timeline.metadata?.webcli?.audio_mix ?? {};
}

function updateCompositePreview() {
  const context = elements["preview-composite"].getContext("2d");
  if (!context || !elements.preview.videoWidth || !elements.preview.videoHeight) return;
  const canvas = elements["preview-composite"];
  if (canvas.width !== elements.preview.videoWidth || canvas.height !== elements.preview.videoHeight) {
    canvas.width = elements.preview.videoWidth;
    canvas.height = elements.preview.videoHeight;
  }
  const location = locateTime(timeline, positionMs);
  const config = captureSources();
  const sourceId = location?.clip.metadata.webcli.source_id;
  const camera = sourceId === config.screen && config.camera && sources.get(config.camera)?.file
    ? elements["preview-camera"]
    : null;
  drawComposite(context, elements.preview, camera, compositeLayout());
  canvas.classList.add("has-source");
}

function sourceTimeAt(position, location) {
  const config = captureSources();
  return cameraTimeForClip(location.clip, position, location.start, config.screen);
}

function setupPreviewAudio() {
  if (audioContext) return;
  audioContext = new AudioContext();
  const clipSource = audioContext.createMediaElementSource(elements.preview);
  previewClipGain = audioContext.createGain();
  clipSource.connect(previewClipGain).connect(audioContext.destination);
  previewMicrophoneSource = audioContext.createMediaElementSource(elements["preview-microphone"]);
  previewMicrophoneGain = audioContext.createGain();
  previewMicrophoneSource.connect(previewMicrophoneGain).connect(audioContext.destination);
}

function applyPreviewGains() {
  if (!audioContext) return;
  const mix = audioMix();
  previewClipGain.gain.value = Math.max(0, mix.volume_percent ?? 100) / 100;
  previewMicrophoneGain.gain.value = Math.max(0, mix.microphone_volume_percent ?? 100) / 100;
}

async function seekVideoElement(video, time, play) {
  if (video.readyState < 2) {
    await new Promise((resolve, reject) => {
      video.addEventListener("loadeddata", resolve, { once: true });
      video.addEventListener("error", () => reject(new Error("Unable to decode a capture video track.")), { once: true });
    });
  }
  const target = Math.min(time, Math.max(0, video.duration - 0.01));
  if (Math.abs(video.currentTime - target) > 0.04) {
    const seeked = new Promise((resolve) => video.addEventListener("seeked", resolve, { once: true }));
    video.currentTime = target;
    await seeked;
  }
  if (video.paused) await video.play();
  if (!play) {
    if (video.requestVideoFrameCallback) {
      await new Promise((resolve) => video.requestVideoFrameCallback(resolve));
    } else {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    video.pause();
  }
}

async function syncCapturePreview(location, play) {
  const config = captureSources();
  const sourceId = location?.clip.metadata.webcli.source_id;
  const captureTime = location ? sourceTimeAt(positionMs, location) / 1000 : 0;
  const camera = sourceId === config.screen ? sources.get(config.camera) : null;
  if (camera?.file) {
    const cameraVideo = elements["preview-camera"];
    if (cameraVideo.dataset.sourceId !== camera.id) {
      cameraVideo.dataset.sourceId = camera.id;
      cameraVideo.src = camera.url;
      cameraVideo.load();
    }
    await seekVideoElement(cameraVideo, captureTime, play);
  } else {
    elements["preview-camera"].pause();
  }

  const microphone = sourceId === config.screen ? sources.get(config.microphone) : null;
  const audio = elements["preview-microphone"];
  if (microphone?.file) {
    if (audio.dataset.sourceId !== microphone.id) {
      audio.dataset.sourceId = microphone.id;
      audio.src = microphone.url;
      audio.load();
    }
    if (audio.readyState >= 1 && Math.abs(audio.currentTime - captureTime) > 0.12) {
      audio.currentTime = Math.min(captureTime, Math.max(0, audio.duration - 0.01));
    }
    if (play) {
      setupPreviewAudio();
      applyPreviewGains();
      await audioContext.resume();
      await audio.play();
    } else {
      audio.pause();
    }
  } else {
    audio.pause();
  }
  updateCompositePreview();
}

function timelineXAtTime(position) {
  const location = locateTime(timeline, position);
  if (!location) return null;
  const clip = elements["timeline-clips"].querySelectorAll(".timeline-clip")[location.index];
  if (!clip) return null;
  return clip.offsetLeft + clip.offsetWidth * Math.min(1, location.offset / location.clip.source_range.duration.value);
}

function renderCaptions() {
  const cues = timeline.metadata.webcli.captions;
  const duration = timelineDuration(timeline);
  const outside = cues.filter((cue) => cue.end > duration).length;
  elements["caption-count"].textContent = cues.length
    ? `${cues.length} caption${cues.length === 1 ? "" : "s"}${outside ? ` · ${outside} beyond the sequence` : ""}`
    : "No captions";
  elements["remove-captions"].disabled = cues.length === 0;
  const lane = document.createElement("div");
  lane.className = "caption-lane";
  const ends = [];
  for (const cue of [...cues].sort((a, b) => a.start - b.start || a.end - b.end)) {
    if (cue.start >= duration || !duration) continue;
    const start = timelineXAtTime(cue.start);
    const end = timelineXAtTime(Math.min(cue.end, duration));
    if (start === null || end === null) continue;
    let row = ends.findIndex((previousEnd) => previousEnd <= cue.start);
    if (row === -1) row = ends.length;
    ends[row] = cue.end;
    const button = document.createElement("button");
    button.className = "caption-cue";
    button.textContent = cue.text.replace(/\n/g, " ");
    button.title = `${formatTime(cue.start, true)}–${formatTime(cue.end, true)} ${cue.text}`;
    button.style.left = `${start}px`;
    button.style.width = `${Math.max(2, end - start)}px`;
    button.style.top = `${7 + row * 28}px`;
    button.addEventListener("click", () => {
      elements.preview.pause();
      void showPosition(cue.start);
    });
    lane.append(button);
  }
  elements["timeline-clips"].style.minHeight = `${Math.max(130, 99 + ends.length * 28)}px`;
  elements["timeline-clips"].append(lane);
  updateCaptionPreview(positionMs);
}

function updateTimelinePlayhead(position, follow = false) {
  const marker = elements["timeline-clips"].querySelector(".timeline-playhead");
  const location = locateTime(timeline, position);
  if (!marker || !location) return;
  const clip = elements["timeline-clips"].querySelectorAll(".timeline-clip")[location.index];
  if (!clip) return;
  const duration = location.clip.source_range.duration.value;
  const left = clip.offsetLeft + clip.offsetWidth * Math.min(1, location.offset / duration);
  marker.style.left = `${left}px`;
  if (follow) {
    const scroll = elements["timeline-clips"].parentElement;
    if (left > scroll.scrollLeft + scroll.clientWidth - 12) scroll.scrollLeft = left - scroll.clientWidth + 12;
    else if (left < scroll.scrollLeft + 12) scroll.scrollLeft = Math.max(0, left - 12);
  }
}

function timelineTimeAtX(x) {
  let start = 0;
  const clips = clipsOf(timeline);
  const buttons = elements["timeline-clips"].querySelectorAll(".timeline-clip");
  for (let index = 0; index < clips.length; index++) {
    const rect = buttons[index].getBoundingClientRect();
    const duration = clips[index].source_range.duration.value;
    if (x < rect.left) return start;
    if (x <= rect.right) return start + duration * (x - rect.left) / rect.width;
    start += duration;
  }
  return start;
}

function animatePlayhead() {
  if (elements.preview.paused) {
    animationFrame = null;
    return;
  }
  const clip = clipsOf(timeline).find((item) => item.metadata.webcli.clip_id === currentClipId);
  if (clip) {
    const offset = elements.preview.currentTime * 1000 - clip.source_range.start_time.value;
    const duration = clip.source_range.duration.value;
    const position = clipStart(currentClipId) + Math.max(0, Math.min(offset, duration));
    updateTimelinePlayhead(position, true);
    updateCaptionPreview(position);
  }
  updateCompositePreview();
  animationFrame = requestAnimationFrame(animatePlayhead);
}

function clearDropIndicator() {
  elements["timeline-clips"].querySelectorAll(".drop-before, .drop-after").forEach((clip) => {
    clip.classList.remove("drop-before", "drop-after");
  });
}

function dropSlot(x) {
  const buttons = [...elements["timeline-clips"].querySelectorAll(".timeline-clip")];
  const index = buttons.findIndex((button) => {
    const rect = button.getBoundingClientRect();
    return x < rect.left + rect.width / 2;
  });
  return index < 0 ? buttons.length : index;
}

function mutate(change, nextSelection = selectedId, nextPosition = positionMs) {
  try {
    const next = change();
    history.push({ timeline, selectedId, positionMs });
    if (history.length > 100) history.shift();
    timeline = next;
    selectedId = nextSelection;
    positionMs = Math.min(nextPosition, timelineDuration(timeline));
    elements.preview.pause();
    render();
    void showPosition(positionMs);
    persistProjectSoon();
  } catch (error) {
    message(`Edit refused: ${error.reason || error.message}`, true);
  }
}

function render() {
  const clips = clipsOf(timeline);
  const duration = timelineDuration(timeline);
  elements["clip-count"].textContent = `${clips.length} clip${clips.length === 1 ? "" : "s"}`;
  elements["timeline-duration"].textContent = formatTime(duration);
  elements["preview-duration"].textContent = formatTime(duration, true);
  elements.playhead.max = String(duration / 1000);
  elements.playhead.value = String(positionMs / 1000);
  elements["preview-time"].textContent = formatTime(positionMs, true);
  elements.undo.disabled = history.length === 0;
  elements["play-button"].disabled = clips.length === 0;
  elements["seek-start"].disabled = clips.length === 0;
  elements["seek-end"].disabled = clips.length === 0;
  elements["timeline-clips"].replaceChildren();

  if (!clips.length) {
    const empty = document.createElement("div");
    empty.className = "timeline-empty";
    empty.textContent = "+  Add a clip from your media library to get started";
    elements["timeline-clips"].append(empty);
  }
  clips.forEach((clip) => {
    const source = sources.get(clip.metadata.webcli.source_id);
    const button = document.createElement("button");
    button.className = `timeline-clip${clip.metadata.webcli.clip_id === selectedId ? " selected" : ""}${source?.file ? "" : " missing"}`;
    button.draggable = true;
    button.dataset.clipId = clip.metadata.webcli.clip_id;
    button.style.width = `${Math.max(92, Math.min(260, clip.source_range.duration.value / 1000 * 20))}px`;
    button.setAttribute("aria-pressed", String(clip.metadata.webcli.clip_id === selectedId));
    const name = document.createElement("strong");
    name.textContent = source?.file ? clip.name : `${clip.name} · missing`;
    const length = document.createElement("small");
    length.textContent = formatTime(clip.source_range.duration.value, true);
    button.append(name, length);
    button.addEventListener("click", () => {
      selectedId = clip.metadata.webcli.clip_id;
      positionMs = clipStart(selectedId);
      elements.preview.pause();
      render();
      void showPosition(positionMs);
    });
    elements["timeline-clips"].append(button);
  });
  renderCaptions();
  if (clips.length) {
    const marker = document.createElement("div");
    marker.className = "timeline-playhead";
    marker.setAttribute("aria-hidden", "true");
    const handle = document.createElement("div");
    handle.className = "timeline-playhead-handle";
    handle.title = "Drag to seek";
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      elements.preview.pause();
      handle.setPointerCapture(event.pointerId);
      void showPosition(timelineTimeAtX(event.clientX));
    });
    handle.addEventListener("pointermove", (event) => {
      if (handle.hasPointerCapture(event.pointerId)) void showPosition(timelineTimeAtX(event.clientX));
    });
    marker.append(handle);
    elements["timeline-clips"].append(marker);
    updateTimelinePlayhead(positionMs, true);
  }

  const clip = selectedClip();
  elements["inspector-empty"].classList.toggle("hidden", !!clip);
  elements["inspector-content"].classList.toggle("hidden", !clip);
  elements.split.disabled = !clip;
  const index = clips.indexOf(clip);
  elements["move-left"].disabled = !clip || index === 0;
  elements["move-right"].disabled = !clip || index === clips.length - 1;
  if (clip) {
    const start = clip.source_range.start_time.value;
    const end = start + clip.source_range.duration.value;
    elements["selected-name"].textContent = clip.name;
    elements["source-duration"].textContent = formatTime(clip.media_reference.available_range.duration.value, true);
    elements["clip-duration"].textContent = formatTime(clip.source_range.duration.value, true);
    elements["trim-start"].value = String(start / 1000);
    elements["trim-end"].value = String(end / 1000);
  }
  if (!clips.length) {
    previewRequest++;
    elements.preview.pause();
    elements.preview.removeAttribute("src");
    elements.preview.load();
    elements.preview.classList.remove("has-source");
    elements["viewer-empty"].classList.remove("hidden");
    currentClipId = null;
  }
}

async function showPosition(position, play = false) {
  const request = ++previewRequest;
  const total = timelineDuration(timeline);
  positionMs = Math.max(0, Math.min(position, total));
  elements.playhead.value = String(positionMs / 1000);
  elements["preview-time"].textContent = formatTime(positionMs, true);
  updateTimelinePlayhead(positionMs, true);
  updateCaptionPreview(positionMs);
  const location = locateTime(timeline, positionMs);
  if (!location) {
    elements["preview-camera"].pause();
    elements["preview-microphone"].pause();
    return;
  }
  const source = sources.get(location.clip.metadata.webcli.source_id);
  if (!source?.file) {
    elements["preview-camera"].pause();
    elements["preview-microphone"].pause();
    elements["preview-composite"].classList.remove("has-source");
    elements["viewer-empty"].classList.remove("hidden");
    message(`Source missing: ${location.clip.name}. Relink it from the media library; the clip remains on your timeline.`, true);
    return;
  }
  const video = elements.preview;
  const sourceTime = (location.clip.source_range.start_time.value + location.offset) / 1000;
  try {
    if (currentClipId !== location.clip.metadata.webcli.clip_id) {
      video.pause();
      currentClipId = location.clip.metadata.webcli.clip_id;
      video.src = source.url;
      video.load();
      await new Promise((resolve, reject) => {
        video.addEventListener("loadedmetadata", resolve, { once: true });
        video.addEventListener("error", () => reject(new Error("Unable to load the video for preview.")), { once: true });
      });
      if (request !== previewRequest) return;
    }
    video.currentTime = sourceTime;
    video.classList.add("has-source");
    elements["viewer-empty"].classList.add("hidden");
    await syncCapturePreview(location, play && positionMs < total);
    if (play && positionMs < total) {
      setupPreviewAudio();
      applyPreviewGains();
      await audioContext.resume();
      await video.play();
    }
  } catch (error) {
    if (request === previewRequest) {
      currentClipId = null;
      message(`Preview failed: ${error.message}`, true);
    }
  }
}

elements["media-input"].addEventListener("change", async (event) => {
  for (const file of event.target.files) {
    try {
      await addSource(file);
    } catch (error) {
      message(`Could not import ${file.name}: ${error.message}`, true);
    }
  }
  event.target.value = "";
});
elements["import-handles"].addEventListener("click", () => {
  importWithHandles().catch((error) => {
    if (error.name !== "AbortError") message(`Could not import media: ${error.message}`, true);
  });
});
elements["project-input"].addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    await importProjectFile(file);
  } catch (error) {
    message(`Could not import project: ${error.message}`, true);
  } finally {
    event.target.value = "";
  }
});

elements["srt-input"].addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const captions = parseSrt(await file.text());
    mutate(() => setCaptions(timeline, captions));
    message(`Imported ${captions.length} caption${captions.length === 1 ? "" : "s"} on the global timeline.`);
  } catch (error) {
    message(`Could not import captions: ${error.message}`, true);
  } finally {
    event.target.value = "";
  }
});
elements["remove-captions"].addEventListener("click", () => mutate(() => setCaptions(timeline, [])));

elements["play-button"].addEventListener("click", async () => {
  if (!elements.preview.paused) {
    elements.preview.pause();
    return;
  }
  if (positionMs >= timelineDuration(timeline)) positionMs = 0;
  await showPosition(positionMs, true);
});
elements.preview.addEventListener("play", () => {
  elements["play-button"].textContent = "❚❚";
  elements["play-button"].setAttribute("aria-label", "Pause");
  if (animationFrame === null) animationFrame = requestAnimationFrame(animatePlayhead);
});
elements.preview.addEventListener("loadeddata", updateCompositePreview);
elements.preview.addEventListener("seeked", updateCompositePreview);
elements["preview-camera"].addEventListener("loadeddata", updateCompositePreview);
elements["preview-camera"].addEventListener("seeked", updateCompositePreview);
elements.preview.addEventListener("pause", () => {
  elements["play-button"].textContent = "▶";
  elements["play-button"].setAttribute("aria-label", "Play");
  if (animationFrame !== null) cancelAnimationFrame(animationFrame);
  animationFrame = null;
  elements["preview-camera"].pause();
  elements["preview-microphone"].pause();
});
elements.preview.addEventListener("timeupdate", () => {
  if (elements.preview.paused) return;
  const clip = clipsOf(timeline).find((item) => item.metadata.webcli.clip_id === currentClipId);
  if (!clip) return;
  const offset = elements.preview.currentTime * 1000 - clip.source_range.start_time.value;
  const end = clipStart(currentClipId) + clip.source_range.duration.value;
  if (offset >= clip.source_range.duration.value) {
    elements.preview.pause();
    void showPosition(end, end < timelineDuration(timeline));
  } else {
    positionMs = Math.max(0, clipStart(currentClipId) + offset);
    elements.playhead.value = String(positionMs / 1000);
    elements["preview-time"].textContent = formatTime(positionMs, true);
    updateTimelinePlayhead(positionMs);
    updateCaptionPreview(positionMs);
  }
});
elements.preview.addEventListener("ended", () => {
  const clip = clipsOf(timeline).find((item) => item.metadata.webcli.clip_id === currentClipId);
  if (!clip) return;
  const end = clipStart(currentClipId) + clip.source_range.duration.value;
  void showPosition(end, end < timelineDuration(timeline));
});
elements.playhead.addEventListener("input", () => {
  elements.preview.pause();
  void showPosition(Number(elements.playhead.value) * 1000);
});
elements["seek-start"].addEventListener("click", () => { elements.preview.pause(); void showPosition(0); });
elements["seek-end"].addEventListener("click", () => { elements.preview.pause(); void showPosition(timelineDuration(timeline)); });

elements["timeline-clips"].addEventListener("dragstart", (event) => {
  const button = event.target.closest(".timeline-clip");
  if (!button) return;
  draggedClipId = button.dataset.clipId;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", draggedClipId);
  button.classList.add("dragging");
});
elements["timeline-clips"].addEventListener("dragover", (event) => {
  if (!draggedClipId) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  const buttons = elements["timeline-clips"].querySelectorAll(".timeline-clip");
  const slot = dropSlot(event.clientX);
  clearDropIndicator();
  if (slot < buttons.length) buttons[slot].classList.add("drop-before");
  else buttons[buttons.length - 1]?.classList.add("drop-after");
});
elements["timeline-clips"].addEventListener("drop", (event) => {
  if (!draggedClipId) return;
  event.preventDefault();
  const clips = clipsOf(timeline);
  const sourceIndex = clips.findIndex((clip) => clip.metadata.webcli.clip_id === draggedClipId);
  const slot = dropSlot(event.clientX);
  const targetIndex = slot > sourceIndex ? slot - 1 : slot;
  const id = draggedClipId;
  draggedClipId = null;
  clearDropIndicator();
  if (sourceIndex >= 0 && targetIndex !== sourceIndex) {
    mutate(() => reorderClip(timeline, id, targetIndex), id);
  }
});
elements["timeline-clips"].addEventListener("dragend", () => {
  draggedClipId = null;
  clearDropIndicator();
  elements["timeline-clips"].querySelector(".dragging")?.classList.remove("dragging");
});
window.addEventListener("resize", () => updateTimelinePlayhead(positionMs));

elements["apply-trim"].addEventListener("click", () => {
  const start = Math.round(Number(elements["trim-start"].value) * 1000);
  const end = Math.round(Number(elements["trim-end"].value) * 1000);
  if (!elements["trim-start"].value || !elements["trim-end"].value) {
    message("Edit refused: trim-past-end", true);
    return;
  }
  mutate(() => trimClip(timeline, selectedId, start, end), selectedId, clipStart(selectedId));
});
elements.split.addEventListener("click", () => {
  mutate(() => splitClip(timeline, selectedId, Math.round(positionMs - clipStart(selectedId)), crypto.randomUUID()));
});
elements["remove-clip"].addEventListener("click", () => mutate(() => removeClip(timeline, selectedId), null));
elements["move-left"].addEventListener("click", () => mutate(() => moveClip(timeline, selectedId, -1), selectedId, 0));
elements["move-right"].addEventListener("click", () => mutate(() => moveClip(timeline, selectedId, 1), selectedId, 0));
elements.undo.addEventListener("click", () => {
  const previous = history.pop();
  if (!previous) return;
  ({ timeline, selectedId, positionMs } = previous);
  elements.preview.pause();
  render();
  void showPosition(positionMs);
  persistProjectSoon();
});
elements["editor-export"].addEventListener("click", () => {
  if (!clipsOf(timeline).length) {
    message("Add a clip to the timeline before exporting a project.", true);
    return;
  }
  const exported = structuredClone(timeline);
  exported.metadata.webcli.sources = [...sources.values()].map(({ handle, file, url, ...record }) => record);
  const url = URL.createObjectURL(new Blob([JSON.stringify(exported, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "timeline.otio";
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  message("Exported the OTIO project. Import this JSON later and relink any unavailable media.");
});

window.addEventListener("video-capture-settings", (event) => {
  const settings = event.detail;
  const next = structuredClone(timeline);
  next.metadata.webcli.capture_settings = settings;
  next.metadata.webcli.title = settings.title;
  next.metadata.webcli.audio_mix = {
    volume_percent: settings.clipVolumePercent,
    microphone_volume_percent: settings.microphoneVolumePercent
  };
  next.metadata.webcli.composite = {
    filter: "overlay",
    arguments: { position: settings.position, size: settings.size, shape: settings.shape }
  };
  timeline = next;
  applyPreviewGains();
  updateCompositePreview();
  persistProjectSoon();
});

window.addEventListener("video-capture-ready", async (event) => {
  const session = event.detail;
  const roles = {};
  const failures = [];
  for (const [trackId, track] of Object.entries(session.tracks)) {
    if (!track.chunkCount || !["video", "audio"].includes(track.kind)) continue;
    try {
      const blob = await loadTrackBlob(session.id, trackId);
      const file = new File([blob], `${track.label}.webm`, { type: track.mimeType });
      const id = `${session.id}/${trackId}`;
      await addSource(file, {
        id,
        name: `${track.label} recording`,
        durationMs: track.durationMs || session.durationMs,
        reference: `webcli://session/${session.id}/track/${trackId}`,
        kind: track.kind,
        mimeType: track.mimeType,
        sessionId: session.id,
        trackId
      });
      roles[trackId] = id;
    } catch (error) {
      failures.push(`${track.label}: ${error.message}`);
    }
  }
  if (roles.screen) {
    const next = structuredClone(timeline);
    next.metadata.webcli.capture_sources = { screen: roles.screen, camera: roles.camera ?? null, microphone: roles.microphone ?? null };
    timeline = clipsOf(timeline).length
      ? next
      : addClip(next, sources.get(roles.screen), crypto.randomUUID());
    selectedId = clipsOf(timeline)[0]?.metadata.webcli.clip_id ?? null;
    render();
    void showPosition(0);
    persistProjectSoon();
  }
  if (failures.length) message(`Could not load capture tracks: ${failures.join("; ")}`, true);
  else if (roles.screen) message("Capture tracks added locally. Screen is on the timeline; camera and microphone settings can be changed after recording.");
});

window.addEventListener("video-editor-settings-restored", (event) => {
  const settings = event.detail;
  const next = structuredClone(timeline);
  next.metadata.webcli.capture_settings = settings;
  timeline = next;
});

let exportUrls = [];
elements["export-video"].addEventListener("click", async () => {
  elements["export-video"].disabled = true;
  elements["caption-mode"].disabled = true;
  exportUrls.forEach((url) => URL.revokeObjectURL(url));
  exportUrls = [];
  elements["export-downloads"].replaceChildren();
  elements["export-status"].textContent = "Preparing export…";
  try {
    const snapshot = structuredClone(timeline);
    const sourceSnapshot = new Map(sources);
    const artifacts = await renderVideo(snapshot, sourceSnapshot, elements["caption-mode"].value, (percent) => {
      elements["export-status"].textContent = percent === 100 ? "Export complete." : `Rendering video: ${percent}%`;
    });
    for (const artifact of artifacts) {
      const link = document.createElement("a");
      const url = URL.createObjectURL(artifact.blob);
      exportUrls.push(url);
      link.href = url;
      link.download = artifact.name;
      link.textContent = `Download ${artifact.name}`;
      elements["export-downloads"].append(link);
    }
  } catch (error) {
    elements["export-status"].textContent = `Export failed: ${error.message}`;
    message(`Export failed: ${error.message}`, true);
  } finally {
    elements["export-video"].disabled = false;
    elements["caption-mode"].disabled = false;
  }
});
restoreProject().catch((error) => message(`Could not initialize the editor: ${error.message}`, true));
