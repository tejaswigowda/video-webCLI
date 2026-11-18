import {
  ALL_FORMATS, AudioBufferSink, AudioBufferSource, BlobSource, CanvasSource,
  Input, Mp4OutputFormat, Output, Quality, StreamTarget, TextSubtitleSource,
  VideoSampleSink, canEncodeAudio, canEncodeVideo
} from "mediabunny";
import { sha256 } from "@noble/hashes/sha256";
import mediaLicense from "./licenses/mediabunny.txt";
import hashLicense from "./licenses/noble-hashes.txt";
import { captionsAt, captionsToWebVtt } from "./subtitles.js";
import { cameraTimeForClip, drawComposite } from "./compositor.js";

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

async function decodeAudioFallback(file) {
  if (!file || file.size > 64 * 1024 * 1024) {
    throw new Error("The audio decoder is unavailable and this source is too large for browser-native fallback decoding.");
  }
  const context = new AudioContext();
  try {
    const buffer = await context.decodeAudioData(await file.arrayBuffer());
    if (buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT > 256 * 1024 * 1024) {
      throw new Error("Decoded audio exceeds the 256 MiB browser fallback limit.");
    }
    return buffer;
  } finally {
    await context.close();
  }
}

async function createAudioReader(track, start, end, file) {
  let iterator;
  try {
    iterator = new AudioBufferSink(track).buffers(Math.max(0, start - 1), end);
    const reader = { iterator, current: null, finished: false };
    await advanceAudioReader(reader);
    return reader;
  } catch (webCodecsError) {
    await iterator?.return();
    try {
      return {
        iterator: null,
        current: { timestamp: 0, buffer: await decodeAudioFallback(file) },
        finished: false,
        fallback: true
      };
    } catch (nativeError) {
      throw new Error(`unknown-codec: Could not decode audio with WebCodecs (${webCodecsError.message}) or the browser audio decoder (${nativeError.message}).`);
    }
  }
}

async function advanceAudioReader(reader) {
  if (reader.fallback) {
    reader.current = null;
    reader.finished = true;
    return;
  }
  const next = await reader.iterator.next();
  reader.current = next.value ?? null;
  reader.finished = next.done;
}

async function mixAudioReader(reader, output, sourceStart, sourceEnd, gain) {
  if (!reader || gain === 0) return;
  while (reader.current && reader.current.timestamp + reader.current.buffer.duration <= sourceStart) {
    await advanceAudioReader(reader);
  }
  while (reader.current && reader.current.timestamp < sourceEnd) {
    const wrapped = reader.current;
    const buffer = wrapped.buffer;
    const from = Math.max(sourceStart, wrapped.timestamp);
    const to = Math.min(sourceEnd, wrapped.timestamp + buffer.duration);
    const first = Math.max(0, Math.floor((from - sourceStart) * output.sampleRate));
    const last = Math.min(output.length, Math.ceil((to - sourceStart) * output.sampleRate));
    const channels = [buffer.getChannelData(0), buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : buffer.getChannelData(0)];
    for (let index = first; index < last; index++) {
      const sourceTime = sourceStart + index / output.sampleRate;
      const sourceIndex = (sourceTime - wrapped.timestamp) * buffer.sampleRate;
      const low = Math.max(0, Math.min(buffer.length - 1, Math.floor(sourceIndex)));
      const high = Math.min(buffer.length - 1, low + 1);
      const ratio = Math.max(0, Math.min(1, sourceIndex - low));
      for (let channel = 0; channel < 2; channel++) {
        const samples = channels[channel];
        output.getChannelData(channel)[index] += (samples[low] * (1 - ratio) + samples[high] * ratio) * gain;
      }
    }
    if (wrapped.timestamp + buffer.duration <= sourceEnd) await advanceAudioReader(reader);
    else break;
  }
}

async function writeAudioMix(source, items, microphoneTrack, screenSourceId, mix) {
  const sampleRate = 48000;
  const blockFrames = 12000;
  for (const item of items) {
    const duration = item.clip.source_range.duration.value / 1000;
    const sourceStart = item.clip.source_range.start_time.value / 1000;
    const clipReader = item.audio ? await createAudioReader(item.audio, sourceStart, sourceStart + duration, item.source.file) : null;
    const micReader = microphoneTrack && item.clip.metadata.webcli.source_id === screenSourceId
      ? await createAudioReader(microphoneTrack, sourceStart, sourceStart + duration, item.microphoneFile)
      : null;
    const totalFrames = Math.round(duration * sampleRate);
    for (let offset = 0; offset < totalFrames; offset += blockFrames) {
      const length = Math.min(blockFrames, totalFrames - offset);
      const output = new AudioBuffer({ numberOfChannels: 2, length, sampleRate });
      const sourceTime = sourceStart + offset / sampleRate;
      const sourceEnd = sourceTime + length / sampleRate;
      await mixAudioReader(clipReader, output, sourceTime, sourceEnd, (mix.volume_percent ?? 100) / 100);
      await mixAudioReader(micReader, output, sourceTime, sourceEnd, (mix.microphone_volume_percent ?? 100) / 100);
      for (let channel = 0; channel < 2; channel++) {
        const samples = output.getChannelData(channel);
        for (let index = 0; index < samples.length; index++) samples[index] = Math.max(-1, Math.min(1, samples[index]));
      }
      await source.add(output);
    }
  }
  source.close();
}

async function writeVideo(source, items, canvas, captions, burn, composite, frameHash, progress) {
  const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
  if (!context) throw new Error("Cannot create the export canvas.");
  const total = items.reduce((sum, item) => sum + item.clip.source_range.duration.value, 0) / 1000;
  let start = 0;
  let frameCount = 0;
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
    const cameraSink = item.camera ? new VideoSampleSink(item.camera) : null;
    const cameraSamples = cameraSink?.samplesAtTimestamps(timestamps());
    for await (const sample of sink.samplesAtTimestamps(timestamps())) {
      if (!sample) throw new Error(`Could not decode a frame from ${item.clip.name} at ${frame / FPS}s.`);
      const cameraResult = cameraSamples ? await cameraSamples.next() : null;
      const cameraSample = cameraResult?.value ?? null;
      const time = frame / FPS;
      try {
        drawComposite(context, sample, cameraSample, composite);
        if (burn) drawCaption(context, captionsAt(captions, time * 1000), canvas.width, canvas.height);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        const digest = await crypto.subtle.digest("SHA-256", pixels);
        frameHash.update(new Uint8Array(digest));
        await source.add(time, Math.min(1 / FPS, total - time));
        frameCount++;
      } finally {
        sample.close();
        cameraSample?.close();
      }
      frame++;
      progress(Math.min(99, Math.floor(time / total * 100)));
    }
    start += duration;
  }
  source.close();
  return { frameCount, hash: [...frameHash.digest()].map((byte) => byte.toString(16).padStart(2, "0")).join("") };
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
  const webcli = timeline.metadata.webcli;
  const captions = webcli.captions;
  const captureSources = webcli.capture_sources ?? {};
  const mix = webcli.audio_mix ?? {};
  const composite = webcli.composite?.arguments ?? {};
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
      items.push({ clip, video, audio, source });
    }
    let cameraTrack;
    const cameraSource = sources.get(captureSources.camera);
    if (cameraSource?.file && items.some((item) => item.clip.metadata.webcli.source_id === captureSources.screen)) {
      const cameraInput = new Input({ formats: ALL_FORMATS, source: new BlobSource(cameraSource.file) });
      inputs.push(cameraInput);
      cameraTrack = await cameraInput.getPrimaryVideoTrack();
      if (!cameraTrack || !await cameraTrack.canDecode()) throw new Error("unknown-codec: Cannot decode the captured camera track.");
      for (const item of items) {
        if (item.clip.metadata.webcli.source_id === captureSources.screen) item.camera = cameraTrack;
      }
    }
    let microphoneTrack;
    const microphoneSource = sources.get(captureSources.microphone);
    if (microphoneSource?.file && items.some((item) => item.clip.metadata.webcli.source_id === captureSources.screen)) {
      const microphoneInput = new Input({ formats: ALL_FORMATS, source: new BlobSource(microphoneSource.file) });
      inputs.push(microphoneInput);
      microphoneTrack = await microphoneInput.getPrimaryAudioTrack();
      if (!microphoneTrack) throw new Error("unknown-codec: The captured microphone track contains no audio.");
      for (const item of items) {
        if (item.clip.metadata.webcli.source_id === captureSources.screen) item.microphoneFile = microphoneSource.file;
      }
    }
    const width = Math.floor((await items[0].video.getDisplayWidth()) / 2) * 2;
    const height = Math.floor((await items[0].video.getDisplayHeight()) / 2) * 2;
    const videoQuality = new Quality({ bitrate: VIDEO_BITRATE });
    const audioQuality = new Quality({ bitrate: AUDIO_BITRATE });
    if (width < 2 || height < 2 || !await canEncodeVideo("avc", { width, height, quality: videoQuality, frameRate: FPS })) {
      throw new Error("unknown-codec: This browser cannot encode H.264 at the source dimensions.");
    }
    const hasAudio = items.some((item) => item.audio) || !!microphoneTrack;
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
    const frameHash = sha256.create();
    const work = [
      writeVideo(videoSource, items, canvas, captions, captionMode === "burn", composite, frameHash, progress)
    ];
    if (audioSource) {
      work.push(writeAudioMix(audioSource, items, microphoneTrack, captureSources.screen, mix));
    }
    if (subtitleSource) {
      work.push((async () => {
        await subtitleSource.add(captionsToWebVtt(captions));
        subtitleSource.close();
      })());
    }
    const [frameSequence] = await Promise.all(work);
    await output.finalize();
    if (!config.video || (hasAudio && !config.audio)) throw new Error("The browser did not report encoder settings.");
    const file = await handle.getFile();
    const manifest = new Blob([JSON.stringify({
      format: "video/mp4",
      muxer: "mediabunny 1.66.0",
      frameRate: FPS,
      captionMode,
      encoder: config,
      determinism: {
        frames: true,
        frame_count: frameSequence.frameCount,
        frame_sha256: frameSequence.hash,
        frame_hash_algorithm: "SHA-256(concatenated SHA-256 digests of composited RGBA frames, in timeline order)",
        bytes: false,
        reason: "WebCodecs output varies by browser build and hardware acceleration.",
        encoder: {
          browser: navigator.userAgent,
          browser_version: navigator.userAgentData?.brands ?? null,
          codec: config.video.codec,
          hardware_acceleration: config.video.hardwareAcceleration ?? "browser-selected; active hardware path is not exposed",
          bitrate: config.video.bitrate,
          audio_codec: config.audio?.codec ?? null,
          audio_bitrate: config.audio?.bitrate ?? null
        }
      },
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
