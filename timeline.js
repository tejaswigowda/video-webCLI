export class OperationRefusal extends Error {
  constructor(reason) {
    super(reason);
    this.name = "OperationRefusal";
    this.reason = reason;
  }
}

const reject = (reason) => {
  throw new OperationRefusal(reason);
};

const rational = (value) => ({ OTIO_SCHEMA: "RationalTime.1", value, rate: 1000 });
const clone = (value) => structuredClone(value);

export function createTimeline(session) {
  const tracks = Object.entries(session.tracks)
    .filter(([, track]) => track.chunkCount > 0)
    .map(([id, track]) => {
      const durationMs = Math.max(1, track.durationMs ?? session.durationMs ?? 1);
      return {
        OTIO_SCHEMA: "Track.1",
        name: track.label,
        kind: track.kind,
        children: [{
          OTIO_SCHEMA: "Clip.1",
          name: track.label,
          media_reference: {
            OTIO_SCHEMA: "ExternalReference.1",
            target_url: `webcli://session/${session.id}/track/${id}`,
            available_range: { start_time: rational(0), duration: rational(durationMs) }
          },
          source_range: { start_time: rational(0), duration: rational(durationMs) },
          effects: [],
          metadata: { webcli: { source_track_id: id, codec: track.mimeType } }
        }],
        metadata: { webcli: { source_track_id: id } }
      };
    });

  if (!tracks.length) reject("no-source");

  return {
    OTIO_SCHEMA: "Timeline.1",
    name: "Untitled screen recording",
    global_start_time: rational(0),
    tracks: {
      OTIO_SCHEMA: "Stack.1",
      name: "Tracks",
      children: tracks,
      metadata: {}
    },
    metadata: {
      webcli: {
        session_id: session.id,
        operations: [],
        composite: {
          filter: "overlay",
          arguments: { position: "bottom-right", size: "medium", shape: "rounded" }
        },
        audio_mix: { volume_percent: 100, microphone_volume_percent: 100 },
        title: null,
        encoder: null
      }
    }
  };
}

export function applyTitle(timeline, text) {
  if (!timeline?.tracks?.children?.length) reject("no-source");
  const next = clone(timeline);
  next.metadata.webcli.title = text.trim() || null;
  next.metadata.webcli.operations.push({ name: "title", text: next.metadata.webcli.title });
  return next;
}

export function applyAudioMix(timeline, volumePercent, microphoneVolumePercent = 100) {
  if (!timeline?.tracks?.children?.length) reject("no-source");
  if (!Number.isFinite(volumePercent) || volumePercent < 0 || volumePercent > 200 ||
      !Number.isFinite(microphoneVolumePercent) || microphoneVolumePercent < 0 || microphoneVolumePercent > 200) {
    reject("unknown-codec");
  }
  const next = clone(timeline);
  next.metadata.webcli.audio_mix = { volume_percent: volumePercent, microphone_volume_percent: microphoneVolumePercent };
  next.metadata.webcli.operations.push({ name: "audio mix", volume_percent: volumePercent, microphone_volume_percent: microphoneVolumePercent });
  return next;
}

export function applyInsetLayout(timeline, position, size, shape = "rounded") {
  if (!timeline?.tracks?.children?.length) reject("no-source");
  const hasCamera = timeline.tracks.children.some((track) => track.kind === "video" && /camera/i.test(track.name));
  if (!hasCamera) reject("no-source");
  const validPositions = ["top-left", "top-right", "bottom-left", "bottom-right"];
  const validSizes = ["small", "medium", "large"];
  const validShapes = ["rounded", "rectangle", "circle"];
  if (!validPositions.includes(position) || !validSizes.includes(size) || !validShapes.includes(shape)) reject("unknown-codec");
  const next = clone(timeline);
  next.metadata.webcli.composite = {
    filter: "overlay",
    arguments: { position, size, shape }
  };
  next.metadata.webcli.operations.push({ name: "inset layout", position, size, shape });
  return next;
}

export function refuseUnimplementedOperation(name) {
  if (name === "export") reject("unknown-codec");
  if (["assemble", "trim", "cut", "crossfade"].includes(name)) reject("overlapping-clips");
  reject("unknown-codec");
}

export function assertSupportedCodec(mimeType) {
  if (!mimeType || !/^video\/webm(?:;|$)/i.test(mimeType)) reject("unknown-codec");
}
