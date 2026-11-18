import test from "node:test";
import assert from "node:assert/strict";
import {
  applyAudioMix,
  applyInsetLayout,
  applyTitle,
  assertSupportedCodec,
  createTimeline,
  OperationRefusal
} from "../timeline.js";

const session = {
  id: "session-1",
  durationMs: 2000,
  tracks: {
    screen: { label: "Screen", kind: "video", mimeType: "video/webm;codecs=vp9", chunkCount: 2 },
    camera: { label: "Camera", kind: "video", mimeType: "video/webm;codecs=vp9", chunkCount: 2 },
    microphone: { label: "Microphone", kind: "audio", mimeType: "audio/webm;codecs=opus", chunkCount: 2 }
  }
};

test("creates separate OTIO-shaped tracks with source references", () => {
  const timeline = createTimeline(session);
  assert.equal(timeline.OTIO_SCHEMA, "Timeline.1");
  assert.equal(timeline.tracks.OTIO_SCHEMA, "Stack.1");
  assert.deepEqual(timeline.tracks.children.map((track) => track.kind), ["video", "video", "audio"]);
  assert.match(timeline.tracks.children[0].children[0].media_reference.target_url, /webcli:\/\/session\/session-1/);
});

test("stores title, audio mix, and inset layout as editable metadata", () => {
  const timeline = createTimeline(session);
  const edited = applyInsetLayout(applyAudioMix(applyTitle(timeline, "Bug report"), 80), "top-left", "small");
  assert.equal(edited.metadata.webcli.title, "Bug report");
  assert.equal(edited.metadata.webcli.audio_mix.volume_percent, 80);
  assert.deepEqual(edited.metadata.webcli.composite.arguments, { position: "top-left", size: "small", shape: "rounded" });
  assert.equal(timeline.metadata.webcli.title, null);
});

test("stores microphone gain and inset shape", () => {
  const updated = applyInsetLayout(applyAudioMix(createTimeline(session), 70, 125), "bottom-left", "large", "circle");
  assert.deepEqual(updated.metadata.webcli.audio_mix, { volume_percent: 70, microphone_volume_percent: 125 });
  assert.deepEqual(updated.metadata.webcli.composite.arguments, { position: "bottom-left", size: "large", shape: "circle" });
});

test("refuses an inset when there is no camera source", () => {
  const timeline = createTimeline({
    ...session,
    tracks: { screen: session.tracks.screen }
  });
  assert.throws(() => applyInsetLayout(timeline, "top-right", "medium"), (error) => {
    assert.ok(error instanceof OperationRefusal);
    assert.equal(error.reason, "no-source");
    return true;
  });
});

test("refuses unsupported recording codecs by name", () => {
  assert.throws(() => assertSupportedCodec("video/mp4"), (error) => error.reason === "unknown-codec");
});
