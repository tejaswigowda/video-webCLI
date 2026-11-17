import { loadTrackBlob } from "./storage.js";
import { renderVideo } from "./export-bundle.js";
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
  "export-video", "caption-mode", "export-status", "export-downloads"
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
  if (sources.has(id)) return;
  sources.set(id, {
    id,
    name: options.name || file.name,
    durationMs,
    reference: options.reference || encodeURIComponent(file.name),
    file,
    url: URL.createObjectURL(file)
  });
  renderMedia();
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
    const button = document.createElement("button");
    button.className = "media-add";
    button.textContent = "+";
    button.title = `Add ${source.name} to timeline`;
    button.setAttribute("aria-label", button.title);
    button.addEventListener("click", () => {
      const clipId = crypto.randomUUID();
      mutate(() => addClip(timeline, source, clipId), clipId, timelineDuration(timeline));
    });
    row.append(thumb, info, button);
    elements["media-list"].append(row);
  }
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
    const button = document.createElement("button");
    button.className = `timeline-clip${clip.metadata.webcli.clip_id === selectedId ? " selected" : ""}`;
    button.draggable = true;
    button.dataset.clipId = clip.metadata.webcli.clip_id;
    button.style.width = `${Math.max(92, Math.min(260, clip.source_range.duration.value / 1000 * 20))}px`;
    button.setAttribute("aria-pressed", String(clip.metadata.webcli.clip_id === selectedId));
    const name = document.createElement("strong");
    name.textContent = clip.name;
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
  if (!location) return;
  const source = sources.get(location.clip.metadata.webcli.source_id);
  if (!source) {
    message(`Source missing: ${location.clip.name}. Import it again.`, true);
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
    if (play && positionMs < total) await video.play();
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
elements.preview.addEventListener("pause", () => {
  elements["play-button"].textContent = "▶";
  elements["play-button"].setAttribute("aria-label", "Play");
  if (animationFrame !== null) cancelAnimationFrame(animationFrame);
  animationFrame = null;
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
});
elements["editor-export"].addEventListener("click", () => {
  if (!clipsOf(timeline).length) {
    message("Add a clip to the timeline before exporting a project.", true);
    return;
  }
  const url = URL.createObjectURL(new Blob([JSON.stringify(timeline, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "timeline.otio";
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  message("Exported timeline JSON. Project reopening is not yet available; keep your original media.");
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
    const artifacts = await renderVideo(snapshot, new Map(sources), elements["caption-mode"].value, (percent) => {
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

window.addEventListener("video-capture-ready", async (event) => {
  const session = event.detail;
  let added = 0;
  const failures = [];
  for (const [id, track] of Object.entries(session.tracks)) {
    if (track.kind !== "video" || !track.chunkCount) continue;
    try {
      const blob = await loadTrackBlob(session.id, id);
      const file = new File([blob], `${track.label}.webm`, { type: track.mimeType });
      await addSource(file, {
        id: `${session.id}/${id}`,
        name: `${track.label} recording`,
        durationMs: track.durationMs || session.durationMs,
        reference: `webcli://session/${session.id}/track/${id}`
      });
      added++;
    } catch (error) {
      failures.push(`${track.label}: ${error.message}`);
    }
  }
  if (failures.length) message(`Could not load recording: ${failures.join("; ")}`, true);
  else if (added) message("Recording added to the library. Screen, camera, and microphone remain separate; download source tracks below.");
});

render();
