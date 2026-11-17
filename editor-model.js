import { OperationRefusal } from "./timeline.js";

const time = (value) => ({ OTIO_SCHEMA: "RationalTime.1", value, rate: 1000 });
const range = (start, duration) => ({
  OTIO_SCHEMA: "TimeRange.1",
  start_time: time(start),
  duration: time(duration)
});

export function newEditorTimeline() {
  return {
    OTIO_SCHEMA: "Timeline.1",
    name: "Untitled project",
    global_start_time: time(0),
    tracks: {
      OTIO_SCHEMA: "Stack.1",
      name: "Tracks",
      children: [{ OTIO_SCHEMA: "Track.1", name: "Video 1", kind: "Video", children: [], metadata: {} }],
      metadata: {}
    },
    metadata: { webcli: { encoder: null, captions: [] } }
  };
}

export function clipsOf(timeline) {
  return timeline.tracks.children[0].children;
}

export function timelineDuration(timeline) {
  return clipsOf(timeline).reduce((total, clip) => total + clip.source_range.duration.value, 0);
}

export function setCaptions(timeline, captions) {
  if (!Array.isArray(captions) || captions.some((cue) =>
    !Number.isSafeInteger(cue.start) || !Number.isSafeInteger(cue.end) ||
    cue.start < 0 || cue.end <= cue.start || typeof cue.text !== "string" || !cue.text.trim())) {
    throw new Error("Invalid captions.");
  }
  const next = structuredClone(timeline);
  next.metadata.webcli.captions = structuredClone(captions);
  return next;
}

export function addClip(timeline, source, clipId) {
  if (!source?.id || !Number.isFinite(source.durationMs) || source.durationMs <= 0) {
    throw new OperationRefusal("no-source");
  }
  const next = structuredClone(timeline);
  clipsOf(next).push({
    OTIO_SCHEMA: "Clip.1",
    name: source.name,
    media_reference: {
      OTIO_SCHEMA: "ExternalReference.1",
      target_url: source.reference,
      available_range: range(0, source.durationMs)
    },
    source_range: range(0, source.durationMs),
    effects: [],
    markers: [],
    metadata: { webcli: { source_id: source.id, clip_id: clipId } }
  });
  return next;
}

function findClip(timeline, clipId) {
  const index = clipsOf(timeline).findIndex((clip) => clip.metadata.webcli.clip_id === clipId);
  if (index < 0) throw new OperationRefusal("no-source");
  return index;
}

export function trimClip(timeline, clipId, start, end) {
  const next = structuredClone(timeline);
  const clip = clipsOf(next)[findClip(next, clipId)];
  const sourceDuration = clip.media_reference.available_range.duration.value;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > sourceDuration) {
    throw new OperationRefusal("trim-past-end");
  }
  clip.source_range = range(start, end - start);
  return next;
}

export function splitClip(timeline, clipId, offset, newClipId) {
  const next = structuredClone(timeline);
  const clips = clipsOf(next);
  const index = findClip(next, clipId);
  const clip = clips[index];
  const duration = clip.source_range.duration.value;
  if (!Number.isFinite(offset) || offset <= 0 || offset >= duration) {
    throw new OperationRefusal("trim-past-end");
  }
  const second = structuredClone(clip);
  const start = clip.source_range.start_time.value;
  clip.source_range = range(start, offset);
  second.source_range = range(start + offset, duration - offset);
  second.metadata.webcli.clip_id = newClipId;
  clips.splice(index + 1, 0, second);
  return next;
}

export function removeClip(timeline, clipId) {
  const next = structuredClone(timeline);
  clipsOf(next).splice(findClip(next, clipId), 1);
  return next;
}

export function moveClip(timeline, clipId, direction) {
  const next = structuredClone(timeline);
  const clips = clipsOf(next);
  const index = findClip(next, clipId);
  const target = index + direction;
  if (![-1, 1].includes(direction) || target < 0 || target >= clips.length) {
    throw new OperationRefusal("no-source");
  }
  [clips[index], clips[target]] = [clips[target], clips[index]];
  return next;
}

export function reorderClip(timeline, clipId, targetIndex) {
  const next = structuredClone(timeline);
  const clips = clipsOf(next);
  const index = findClip(next, clipId);
  if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= clips.length) {
    throw new OperationRefusal("no-source");
  }
  const [clip] = clips.splice(index, 1);
  clips.splice(targetIndex, 0, clip);
  return next;
}

export function locateTime(timeline, position) {
  const clips = clipsOf(timeline);
  let start = 0;
  for (let index = 0; index < clips.length; index++) {
    const clip = clips[index];
    const duration = clip.source_range.duration.value;
    if (position < start + duration || (index === clips.length - 1 && position <= start + duration)) {
      return { clip, index, offset: Math.max(0, position - start), start };
    }
    start += duration;
  }
  return null;
}
