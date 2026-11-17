import {
  ALL_FORMATS, AudioBufferSink, AudioBufferSource, BlobSource, CanvasSource,
  Input, Mp4OutputFormat, Output, Quality, StreamTarget, TextSubtitleSource,
  VideoSampleSink, canEncodeAudio, canEncodeVideo
} from "mediabunny";
import { sha256 } from "@noble/hashes/sha256";
import mediaLicense from "./licenses/mediabunny.txt";
import hashLicense from "./licenses/noble-hashes.txt";
import { captionsAt, captionsToWebVtt } from "./subtitles.js";

const FPS = 30;
const VIDEO_BITRATE = 4_000_000;
const AUDIO_BITRATE = 128_000;

function drawCaption(context, text, width, height) {
  if (!text) return;
  const size = Math.max(14, Math.round(height * 0.045));
  context.font = `600 ${size}px sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  const maxWidth = width * 0.85;
  const lines = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && context.measureText(candidate).width > maxWidth) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    lines.push(line);
  }
  const lineHeight = size * 1.3;
  const bottom = height * 0.9;
  lines.forEach((line, index) => {
    const y = bottom - (lines.length - 1 - index) * lineHeight;
    const textWidth = Math.min(maxWidth, context.measureText(line).width);
    context.fillStyle = "rgba(0,0,0,0.75)";
    context.fillRect((width - textWidth) / 2 - size * 0.3, y - lineHeight / 2, textWidth + size * 0.6, lineHeight);
    context.fillStyle = "#fff";
    context.fillText(line, width / 2, y, maxWidth);
  });
}

async function writeSilence(source, seconds) {
  let remaining = Math.max(0, Math.round(seconds * 48000));
  while (remaining > 0) {
    const length = Math.min(remaining, 48000);
    await source.add(new AudioBuffer({ numberOfChannels: 2, length, sampleRate: 48000 }));
    remaining -= length;
  }
}

async function writeAudioClip(source, item) {
  const start = item.clip.source_range.start_time.value / 1000;
  const end = start + item.clip.source_range.duration.value / 1000;
  if (!item.audio) {
    await writeSilence(source, end - start);
    return;
  }
  const sink = new AudioBufferSink(item.audio);
  let cursor = start;
  async function addBuffer(wrapped) {
    if (!wrapped) return;
    const buffer = wrapped.buffer;
    const rangeStart = Math.max(start, cursor, wrapped.timestamp);
    const rangeEnd = Math.min(end, wrapped.timestamp + buffer.duration);
    if (rangeEnd <= rangeStart) return;
    if (rangeStart > cursor) {
      await writeSilence(source, rangeStart - cursor);
      cursor = rangeStart;
    }
    const first = Math.max(0, Math.ceil((rangeStart - wrapped.timestamp) * buffer.sampleRate - 1e-6));
    const last = Math.min(buffer.length, Math.floor((rangeEnd - wrapped.timestamp) * buffer.sampleRate + 1e-6));
    if (last > first) {
      const part = new AudioBuffer({
        numberOfChannels: buffer.numberOfChannels,
        length: last - first,
        sampleRate: buffer.sampleRate
      });
      for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        part.copyToChannel(buffer.getChannelData(channel).subarray(first, last), channel);
      }
      await source.add(part);
      cursor = wrapped.timestamp + last / buffer.sampleRate;
    }
  }
  await addBuffer(await sink.getBuffer(start));
  for await (const buffer of sink.buffers(start, end)) await addBuffer(buffer);
  if (cursor < end) await writeSilence(source, end - cursor);
}

async function writeVideo(source, items, canvas, captions, burn, progress) {
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("Cannot create the export canvas.");
  const total = items.reduce((sum, item) => sum + item.clip.source_range.duration.value, 0) / 1000;
  let start = 0;
  for (const item of items) {
    const duration = item.clip.source_range.duration.value / 1000;
    const sourceStart = item.clip.source_range.start_time.value / 1000;
    const firstFrame = Math.ceil(start * FPS - 1e-8);
    const lastFrame = Math.ceil((start + duration) * FPS - 1e-8);
    function* timestamps() {
      for (let frame = firstFrame; frame < lastFrame; frame++) {
        yield sourceStart + frame / FPS - start;
      }
    }
    const sink = new VideoSampleSink(item.video);
    let frame = firstFrame;
    for await (const sample of sink.samplesAtTimestamps(timestamps())) {
      if (!sample) throw new Error(`Could not decode a frame from ${item.clip.name} at ${frame / FPS}s.`);
      const time = frame / FPS;
      try {
        context.fillStyle = "#000";
        context.fillRect(0, 0, canvas.width, canvas.height);
        sample.drawWithFit(context, { fit: "contain" });
        if (burn) drawCaption(context, captionsAt(captions, time * 1000), canvas.width, canvas.height);
        await source.add(time, Math.min(1 / FPS, total - time));
      } finally {
        sample.close();
      }
      frame++;
      progress(Math.min(99, Math.floor(time / total * 100)));
    }
    start += duration;
  }
  source.close();
}

async function hashBlob(blob) {
  const hash = sha256.create();
  for (let offset = 0; offset < blob.size; offset += 1024 * 1024) {
    hash.update(new Uint8Array(await blob.slice(offset, offset + 1024 * 1024).arrayBuffer()));
  }
  return [...hash.digest()].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function renderVideo(timeline, sources, captionMode, progress) {
  const clips = timeline.tracks.children[0].children;
  const captions = timeline.metadata.webcli.captions;
  const totalMs = clips.reduce((sum, clip) => sum + clip.source_range.duration.value, 0);
  if (!clips.length) throw new Error("no-source: Add a video clip before exporting.");
  if (!["burn", "soft"].includes(captionMode)) throw new Error("Unknown caption export mode.");
  if (captions.some((cue) => cue.end > totalMs)) {
    throw new Error("Captions extend beyond the video. Extend the timeline or import an SRT that fits.");
  }
  if (!navigator.storage?.getDirectory) throw new Error("Video export requires browser-local OPFS storage.");
  const inputs = [];
  let output;
  let directory;
  let outputName;
  try {
    const items = [];
    for (const clip of clips) {
      const source = sources.get(clip.metadata.webcli.source_id);
      if (!source?.file) throw new Error(`no-source: Missing ${clip.name}.`);
      const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(source.file) });
      inputs.push(input);
      const video = await input.getPrimaryVideoTrack();
      const audioTracks = await input.getAudioTracks();
      if (audioTracks.length > 1) throw new Error(`audio-mix-unsupported: ${clip.name} has multiple audio tracks.`);
      const audio = await input.getPrimaryAudioTrack();
      if (!video || !await video.canDecode()) throw new Error(`unknown-codec: Cannot decode video in ${clip.name}.`);
      if (audio && !await audio.canDecode()) throw new Error(`unknown-codec: Cannot decode audio in ${clip.name}.`);
      items.push({ clip, video, audio });
    }
    const width = Math.floor((await items[0].video.getDisplayWidth()) / 2) * 2;
    const height = Math.floor((await items[0].video.getDisplayHeight()) / 2) * 2;
    const videoQuality = new Quality({ bitrate: VIDEO_BITRATE });
    const audioQuality = new Quality({ bitrate: AUDIO_BITRATE });
    if (width < 2 || height < 2 || !await canEncodeVideo("avc", { width, height, quality: videoQuality, frameRate: FPS })) {
      throw new Error("unknown-codec: This browser cannot encode H.264 at the source dimensions.");
    }
    const hasAudio = items.some((item) => item.audio);
    if (hasAudio && !await canEncodeAudio("aac", { numberOfChannels: 2, sampleRate: 48000, quality: audioQuality })) {
      throw new Error("unknown-codec: This browser cannot encode AAC audio.");
    }
    directory = await (await navigator.storage.getDirectory()).getDirectoryHandle("video-webcli-exports", { create: true });
    outputName = `${crypto.randomUUID()}.mp4`;
    const handle = await directory.getFileHandle(outputName, { create: true });
    const fileWriter = await handle.createWritable();
    const writable = new WritableStream({
      write: ({ data, position }) => fileWriter.write({ type: "write", position, data }),
      close: () => fileWriter.close(),
      abort: () => fileWriter.abort()
    });
    output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: new StreamTarget(writable, { chunked: true }) });
    const config = { video: null, audio: null };
    const canvas = new OffscreenCanvas(width, height);
    const videoSource = new CanvasSource(canvas, {
      codec: "avc",
      quality: videoQuality,
      keyFrameInterval: 2,
      onEncoderConfig: (actual) => { config.video = actual; }
    });
    output.addVideoTrack(videoSource, { frameRate: FPS });
    let audioSource;
    if (hasAudio) {
      audioSource = new AudioBufferSource({
        codec: "aac",
        quality: audioQuality,
        transform: { numberOfChannels: 2, sampleRate: 48000 },
        onEncoderConfig: (actual) => { config.audio = actual; }
      });
      output.addAudioTrack(audioSource);
    }
    let subtitleSource;
    if (captionMode === "soft" && captions.length) {
      subtitleSource = new TextSubtitleSource("webvtt");
      output.addSubtitleTrack(subtitleSource, { languageCode: "und", name: "Captions" });
    }
    await output.start();
    const work = [
      writeVideo(videoSource, items, canvas, captions, captionMode === "burn", progress)
    ];
    if (audioSource) {
      work.push((async () => {
        for (const item of items) await writeAudioClip(audioSource, item);
        audioSource.close();
      })());
    }
    if (subtitleSource) {
      work.push((async () => {
        await subtitleSource.add(captionsToWebVtt(captions));
        subtitleSource.close();
      })());
    }
    await Promise.all(work);
    await output.finalize();
    if (!config.video || (hasAudio && !config.audio)) throw new Error("The browser did not report encoder settings.");
    const file = await handle.getFile();
    const manifest = new Blob([JSON.stringify({
      format: "video/mp4",
      muxer: "mediabunny 1.66.0",
      frameRate: FPS,
      captionMode,
      encoder: config,
      timeline
    }, null, 2)], { type: "application/json" });
    const licenses = new Blob([
      "Mediabunny 1.66.0 (MPL-2.0), source: https://github.com/Vanilagy/mediabunny\n\n",
      mediaLicense, "\n\n@noble/hashes 1.8.0 (MIT)\n\n", hashLicense
    ], { type: "text/plain" });
    const artifacts = [
      { name: "video.mp4", blob: file },
      { name: "export-manifest.json", blob: manifest },
      { name: "licenses.txt", blob: licenses }
    ];
    const hashes = [];
    for (const artifact of artifacts) hashes.push(`${await hashBlob(artifact.blob)}  ${artifact.name}`);
    artifacts.push({ name: "files.sha256", blob: new Blob([`${hashes.join("\n")}\n`], { type: "text/plain" }) });
    progress(100);
    return artifacts;
  } catch (error) {
    if (output && output.state !== "finalized" && output.state !== "canceled") await output.cancel();
    if (directory && outputName) await directory.removeEntry(outputName);
    throw error;
  } finally {
    inputs.forEach((input) => input.dispose());
  }
}
