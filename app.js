import {
  applyAudioMix,
  applyInsetLayout,
  applyTitle,
  assertSupportedCodec,
  createTimeline
} from "./timeline.js";
import {
  createSession,
  getSession,
  listRecoverableSessions,
  loadTrackBlob,
  saveChunk,
  setSessionStatus,
  updateSession
} from "./storage.js";

const elements = Object.fromEntries([
  "recovery", "message", "recording-status", "status-label", "screen-state", "camera-state",
  "microphone-state", "camera-opt-in", "microphone-opt-in", "start-button", "stop-button",
  "elapsed", "export-project", "export-sources", "empty-project", "project-content", "track-list",
  "title-text", "audio-level", "audio-value", "microphone-level", "microphone-value",
  "inset-position", "inset-size", "inset-shape"
].map((id) => [id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), document.getElementById(id)]));

const trackDefinitions = {
  screen: { label: "Screen", kind: "video", symbol: "▣" },
  camera: { label: "Camera", kind: "video", symbol: "◉" },
  microphone: { label: "Microphone", kind: "audio", symbol: "♫" }
};

let activeSession;
let projectSession;
let timeline;
let recorderJobs = [];
let elapsedTimer;
let startedAt;
let finalizing = false;

function setMessage(text, isError = false) {
  elements.message.textContent = text;
  elements.message.classList.toggle("error", isError);
  elements.message.classList.remove("hidden");
}

function clearMessage() {
  elements.message.textContent = "";
  elements.message.classList.add("hidden");
}

function supportedMimeType(kind) {
  const candidates = kind === "audio"
    ? ["audio/webm;codecs=opus", "audio/webm"]
    : ["video/webm;codecs=vp8", "video/webm;codecs=vp9"];
  const preview = document.createElement("video");
  return candidates.find((mimeType) => MediaRecorder.isTypeSupported(mimeType) &&
    (kind === "audio" || preview.canPlayType(mimeType)));
}

function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function refreshElapsed() {
  if (!startedAt) return;
  const elapsed = Date.now() - startedAt;
  elements.elapsed.textContent = formatDuration(elapsed);
  if (activeSession) activeSession.durationMs = elapsed;
}

function updateSourceStatus(id, text, isLive = false) {
  const key = `${id}-state`.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  const element = elements[key];
  if (element) {
    element.textContent = text;
    element.dataset.live = String(isLive);
  }
}

function updateRecordingUI(recording) {
  const active = recording || finalizing;
  elements.recordingStatus.classList.toggle("active", active);
  elements.statusLabel.textContent = finalizing ? "Saving recording…" : recording ? "Recording" : "Not recording";
  elements.startButton.disabled = recording || finalizing;
  elements.stopButton.disabled = !recording || finalizing;
  elements.cameraOptIn.disabled = recording || finalizing;
  elements.microphoneOptIn.disabled = recording || finalizing;
}

function makeTrackManifest(id, mimeType, codec) {
  return {
    label: trackDefinitions[id].label,
    kind: trackDefinitions[id].kind,
    mimeType,
    codec,
    chunkCount: 0,
    bytes: 0,
    durationMs: 0
  };
}

function makeRecorder(id, stream, session) {
  const definition = trackDefinitions[id];
  const mimeType = supportedMimeType(definition.kind);
  if (!mimeType) {
    const error = new Error("unknown-codec");
    error.name = "OperationRefusal";
    throw error;
  }
  if (definition.kind === "video") assertSupportedCodec(mimeType);

  const recorder = new MediaRecorder(stream, { mimeType });
  const trackManifest = makeTrackManifest(id, mimeType, recorder.mimeType || mimeType);
  session.tracks[id] = trackManifest;
  let index = 0;
  let writes = Promise.resolve();
  const completed = new Promise((resolve, reject) => {
    let pendingChunks = 0;
    recorder.addEventListener("dataavailable", (event) => {
      if (!event.data?.size) return;
      const chunkIndex = index++;
      pendingChunks++;
      writes = writes.then(async () => {
        await saveChunk(session.id, id, chunkIndex, event.data);
        pendingChunks--;
        trackManifest.chunkCount = chunkIndex + 1;
        trackManifest.bytes += event.data.size;
        trackManifest.durationMs = Date.now() - session.startedAt;
        if (activeSession?.id === session.id) renderTracks();
      });
      writes.catch(reject);
      if (pendingChunks > 2) {
        setMessage("Local storage is falling behind capture. Stopping safely to limit unsaved data.", true);
        if (activeSession) void stopCapture();
      }
    });
    recorder.addEventListener("error", (event) => reject(event.error ?? new Error(`Recording ${id} failed.`)), { once: true });
    recorder.addEventListener("stop", () => {
      writes.then(resolve, reject);
    }, { once: true });
  });
  completed.catch((error) => {
    setMessage(`Recording could not be saved: ${error.message}`, true);
    if (activeSession) void stopCapture();
  });
  return { recorder, completed, id, stream };
}

async function startCapture() {
  if (!navigator.mediaDevices?.getDisplayMedia || !window.MediaRecorder) {
    throw new Error("This browser does not support screen capture recording.");
  }
  clearMessage();
  elements.startButton.disabled = true;
  const streams = [];
  try {
    const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    streams.push(screenStream);
    elements.recordingStatus.classList.add("active");
    elements.statusLabel.textContent = "Screen live · preparing";
    updateSourceStatus("screen", "Live · preparing");
    const sources = { screen: screenStream };
    if (elements.cameraOptIn.checked) {
      const cameraStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      streams.push(cameraStream);
      sources.camera = cameraStream;
      updateSourceStatus("camera", "Live · preparing");
    }
    if (elements.microphoneOptIn.checked) {
      const microphoneStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
      streams.push(microphoneStream);
      sources.microphone = microphoneStream;
      updateSourceStatus("microphone", "Live · preparing");
    }
    if (streams.some((stream) => stream.getTracks().some((track) => track.readyState !== "live"))) {
      throw new Error("A selected source stopped before recording could begin.");
    }

    const id = crypto.randomUUID();
    const manifest = {
      id,
      status: "recording",
      startedAt: Date.now(),
      updatedAt: Date.now(),
      durationMs: 0,
      storage: "opfs-with-indexeddb-fallback",
      tracks: {}
    };
    await createSession(manifest);
    activeSession = manifest;
    projectSession = manifest;
    timeline = null;
    renderProject(false);
    recorderJobs = Object.entries(sources).map(([trackId, stream]) => makeRecorder(trackId, stream, manifest));
    await updateSession(id, (stored) => ({ ...stored, tracks: manifest.tracks, updatedAt: Date.now() }));
    recorderJobs.forEach(({ recorder, id: trackId }) => {
      recorder.start(1000);
      updateSourceStatus(trackId, "Live · saved locally", true);
    });
    for (const job of recorderJobs) {
      for (const track of job.stream.getTracks()) {
        track.addEventListener("ended", () => {
          updateSourceStatus(job.id, "Stopped");
          setMessage(`${trackDefinitions[job.id].label} stopped. Ending the take to preserve the saved tracks.`, true);
          void stopCapture();
        }, { once: true });
      }
    }
    startedAt = Date.now();
    updateSourceStatus("screen", "Live · saved locally", true);
    updateSourceStatus("camera", sources.camera ? "Live · saved locally" : "Off", !!sources.camera);
    updateSourceStatus("microphone", sources.microphone ? "Live · saved locally" : "Off", !!sources.microphone);
    updateRecordingUI(true);
    refreshElapsed();
    elapsedTimer = window.setInterval(refreshElapsed, 500);
    renderTracks();
  } catch (error) {
    const startedJobs = recorderJobs.filter(({ recorder }) => recorder.state !== "inactive");
    recorderJobs.forEach(({ recorder }) => {
      if (recorder.state !== "inactive") recorder.stop();
    });
    streams.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
    await Promise.allSettled(startedJobs.map(({ completed }) => completed));
    elements.startButton.disabled = false;
    if (activeSession?.status === "recording") await setSessionStatus(activeSession.id, "interrupted");
    activeSession = null;
    recorderJobs = [];
    updateSourceStatus("screen", "Not active");
    updateSourceStatus("camera", "Off");
    updateSourceStatus("microphone", "Off");
    throw error;
  }
}

async function stopCapture() {
  if (!activeSession || finalizing) return;
  finalizing = true;
  updateRecordingUI(false);
  clearInterval(elapsedTimer);
  const durationMs = Date.now() - activeSession.startedAt;
  recorderJobs.forEach(({ recorder }) => {
    if (recorder.state !== "inactive") recorder.stop();
  });
  recorderJobs.forEach(({ stream }) => stream.getTracks().forEach((track) => track.stop()));
  try {
    await Promise.all(recorderJobs.map(({ completed }) => completed));
    for (const track of Object.values(activeSession.tracks)) track.durationMs = durationMs;
    activeSession.durationMs = durationMs;
    await updateSession(activeSession.id, (manifest) => ({
      ...manifest,
      tracks: activeSession.tracks,
      durationMs,
      status: "complete",
      updatedAt: Date.now()
    }));
    projectSession = activeSession;
    timeline = createTimeline(projectSession);
    elements.titleText.value = "";
    elements.audioLevel.value = "100";
    elements.audioValue.textContent = "100%";
    elements.microphoneLevel.value = "100";
    elements.microphoneValue.textContent = "100%";
    elements.insetPosition.value = "bottom-right";
    elements.insetSize.value = "medium";
    elements.insetShape.value = "rounded";
    renderTracks();
    renderProject(true);
    syncTimelineControls();
    setMessage("Capture saved. Each source is stored independently and can be downloaded from this browser.");
    window.dispatchEvent(new CustomEvent("video-capture-ready", { detail: projectSession }));
  } catch (error) {
    await setSessionStatus(activeSession.id, "interrupted");
    renderTracks();
    renderProject(false);
    setMessage(`Capture stopped, but a chunk could not be saved: ${error.message}`, true);
  } finally {
    activeSession = null;
    recorderJobs = [];
    startedAt = null;
    finalizing = false;
    updateRecordingUI(false);
    elements.elapsed.textContent = "00:00";
    updateSourceStatus("screen", "Not active");
    updateSourceStatus("camera", "Off");
    updateSourceStatus("microphone", "Off");
  }
}

function renderTracks() {
  const session = activeSession ?? projectSession;
  if (!session) return;
  elements.trackList.replaceChildren();
  for (const [id, track] of Object.entries(session.tracks)) {
    const card = document.createElement("div");
    card.className = "track-card";
    const badge = document.createElement("span");
    badge.className = "track-badge";
    badge.textContent = trackDefinitions[id]?.symbol ?? "•";
    const info = document.createElement("span");
    info.className = "track-info";
    const name = document.createElement("strong");
    name.textContent = track.label;
    const detail = document.createElement("small");
    detail.textContent = `${track.mimeType} · ${track.chunkCount} chunks · ${formatBytes(track.bytes)}`;
    info.append(name, detail);
    const state = document.createElement("span");
    state.className = "track-state";
    state.textContent = track.chunkCount ? "SAVED" : "WAITING";
    card.append(badge, info, state);
    elements.trackList.append(card);
  }
  renderProject(false);
}

function renderProject(canExport) {
  const session = activeSession ?? projectSession;
  const hasTracks = Object.keys(session?.tracks ?? {}).length > 0 || !!timeline;
  const hasCamera = Object.values(session?.tracks ?? {}).some((track) => track.label === "Camera");
  elements.emptyProject.classList.toggle("hidden", hasTracks);
  elements.projectContent.classList.toggle("hidden", !hasTracks);
  elements.exportProject.disabled = !canExport || !timeline;
  elements.exportSources.disabled = !canExport || !projectSession?.id;
  elements.insetPosition.disabled = !hasCamera;
  elements.insetSize.disabled = !hasCamera;
  elements.insetShape.disabled = !hasCamera;
}

function formatBytes(bytes = 0) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportProject() {
  if (!timeline || !projectSession) return;
  const exportTimeline = {
    ...timeline,
    metadata: {
      ...timeline.metadata,
      webcli: {
        ...timeline.metadata.webcli,
        title: elements.titleText.value.trim() || null,
        audio_mix: {
          volume_percent: Number(elements.audioLevel.value),
          microphone_volume_percent: Number(elements.microphoneLevel.value)
        },
        sources: Object.entries(projectSession.tracks).map(([trackId, track]) => ({
          id: `${projectSession.id}/${trackId}`,
          name: `${track.label} recording`,
          durationMs: track.durationMs || projectSession.durationMs,
          reference: `webcli://session/${projectSession.id}/track/${trackId}`,
          kind: track.kind,
          mimeType: track.mimeType,
          sessionId: projectSession.id,
          trackId
        })),
        composite: {
          filter: "overlay",
          arguments: { position: elements.insetPosition.value, size: elements.insetSize.value, shape: elements.insetShape.value }
        },
        encoder: null
      }
    }
  };
  exportTimeline.metadata.webcli.operations = [
    { name: "assemble", session_id: projectSession.id },
    { name: "title", text: exportTimeline.metadata.webcli.title },
    { name: "audio mix", volume_percent: Number(elements.audioLevel.value), microphone_volume_percent: Number(elements.microphoneLevel.value) },
    { name: "inset layout", ...exportTimeline.metadata.webcli.composite.arguments },
    { name: "export", format: "otio-json" }
  ];
  download(new Blob([JSON.stringify(exportTimeline, null, 2)], { type: "application/json" }), "timeline.otio");
}

async function exportSources() {
  if (!projectSession) return;
  for (const id of Object.keys(projectSession.tracks)) {
    const blob = await loadTrackBlob(projectSession.id, id);
    download(blob, `${id}.webm`);
  }
  const digestLines = [];
  for (const id of Object.keys(projectSession.tracks)) {
    const blob = await loadTrackBlob(projectSession.id, id);
    const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    digestLines.push(`${hex}  ${id}.webm`);
  }
  download(new Blob([`${digestLines.join("\n")}\n`], { type: "text/plain" }), "files.sha256");
}

function syncTimelineControls() {
  const settings = {
    title: elements.titleText.value.trim() || null,
    clipVolumePercent: Number(elements.audioLevel.value),
    microphoneVolumePercent: Number(elements.microphoneLevel.value),
    position: elements.insetPosition.value,
    size: elements.insetSize.value,
    shape: elements.insetShape.value
  };
  if (timeline) {
    try {
      let updated = applyTitle(timeline, elements.titleText.value);
      updated = applyAudioMix(updated, settings.clipVolumePercent, settings.microphoneVolumePercent);
      const hasCamera = updated.tracks.children.some((track) => /camera/i.test(track.name));
      if (hasCamera) updated = applyInsetLayout(updated, settings.position, settings.size, settings.shape);
      timeline = updated;
    } catch (error) {
      if (error.reason !== "no-source") setMessage(error.message, true);
    }
  }
  window.dispatchEvent(new CustomEvent("video-capture-settings", { detail: settings }));
}

async function offerRecovery() {
  const sessions = await listRecoverableSessions();
  if (!sessions.length) return;
  elements.recovery.replaceChildren();
  const text = document.createElement("span");
  text.textContent = `${sessions.length} unfinished capture${sessions.length === 1 ? "" : "s"} found in this browser.`;
  const button = document.createElement("button");
  button.textContent = "Recover latest";
  button.addEventListener("click", () => recoverSession(sessions.sort((a, b) => b.startedAt - a.startedAt)[0]));
  elements.recovery.append(text, button);
  elements.recovery.classList.remove("hidden");
}

async function recoverSession(manifest) {
  try {
    if (activeSession || finalizing) throw new Error("Stop the current capture before recovering another session.");
    const stored = await getSession(manifest.id);
    if (!stored) throw new Error("The unfinished session manifest is missing.");
    stored.status = "interrupted";
    await setSessionStatus(stored.id, "interrupted");
    projectSession = stored;
    timeline = createTimeline(stored);
    elements.recovery.classList.add("hidden");
    elements.titleText.value = "";
    renderTracks();
    renderProject(true);
    window.dispatchEvent(new CustomEvent("video-capture-ready", { detail: projectSession }));
    setMessage("Recovered the saved chunks from this unfinished capture. Download source tracks or export the timeline.");
  } catch (error) {
    setMessage(`Could not recover the capture: ${error.message}`, true);
  }
}

elements.startButton.addEventListener("click", () => startCapture().catch((error) => {
  const message = error.message === "unknown-codec"
    ? "This browser does not provide a supported recording codec (unknown-codec)."
    : error.message;
  setMessage(message, true);
  updateRecordingUI(false);
}));
elements.stopButton.addEventListener("click", () => stopCapture());
elements.exportProject.addEventListener("click", () => exportProject());
elements.exportSources.addEventListener("click", () => exportSources().catch((error) => setMessage(error.message, true)));
elements.titleText.addEventListener("input", syncTimelineControls);
elements.audioLevel.addEventListener("input", () => {
  elements.audioValue.textContent = `${elements.audioLevel.value}%`;
  syncTimelineControls();
});
elements.microphoneLevel.addEventListener("input", () => {
  elements.microphoneValue.textContent = `${elements.microphoneLevel.value}%`;
  syncTimelineControls();
});
elements.insetPosition.addEventListener("change", syncTimelineControls);
elements.insetSize.addEventListener("change", syncTimelineControls);
elements.insetShape.addEventListener("change", syncTimelineControls);

window.addEventListener("video-editor-settings-restored", (event) => {
  const { title, clipVolumePercent, microphoneVolumePercent, position, size, shape } = event.detail;
  elements.titleText.value = title ?? "";
  elements.audioLevel.value = String(clipVolumePercent ?? 100);
  elements.audioValue.textContent = `${elements.audioLevel.value}%`;
  elements.microphoneLevel.value = String(microphoneVolumePercent ?? 100);
  elements.microphoneValue.textContent = `${elements.microphoneLevel.value}%`;
  elements.insetPosition.value = position ?? "bottom-right";
  elements.insetSize.value = size ?? "medium";
  elements.insetShape.value = shape ?? "rounded";
});

updateRecordingUI(false);
renderProject(false);
offerRecovery().catch((error) => setMessage(`Could not check for recovery sessions: ${error.message}`, true));
