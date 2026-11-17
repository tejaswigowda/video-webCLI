import test from "node:test";
import assert from "node:assert/strict";
import { addClip, clipsOf, locateTime, moveClip, newEditorTimeline, removeClip, reorderClip, splitClip, timelineDuration, trimClip } from "../editor-model.js";

const source = { id: "s1", name: "clip.webm", durationMs: 10000, reference: "clip.webm" };

test("assemble, trim, split, move and remove preserve source ranges", () => {
  const original = addClip(newEditorTimeline(), source, "c1");
  const trimmed = trimClip(original, "c1", 1000, 9000);
  const split = splitClip(trimmed, "c1", 3000, "c2");
  assert.equal(timelineDuration(split), 8000);
  assert.deepEqual(clipsOf(split).map((clip) => [
    clip.source_range.start_time.value, clip.source_range.duration.value
  ]), [[1000, 3000], [4000, 5000]]);
  const moved = moveClip(split, "c2", -1);
  assert.equal(clipsOf(moved)[0].metadata.webcli.clip_id, "c2");
  assert.equal(timelineDuration(removeClip(moved, "c2")), 3000);
  assert.equal(timelineDuration(original), 10000);
});

test("invalid trims and splits are refused without changing the timeline", () => {
  const timeline = addClip(newEditorTimeline(), source, "c1");
  assert.throws(() => trimClip(timeline, "c1", 0, 10001), { reason: "trim-past-end" });
  assert.throws(() => trimClip(timeline, "c1", 10, 10), { reason: "trim-past-end" });
  assert.throws(() => splitClip(timeline, "c1", 0, "c2"), { reason: "trim-past-end" });
  assert.equal(timelineDuration(timeline), 10000);
});

test("playhead maps across clip boundaries", () => {
  const timeline = splitClip(addClip(newEditorTimeline(), source, "c1"), "c1", 3000, "c2");
  assert.equal(locateTime(timeline, 2999).clip.metadata.webcli.clip_id, "c1");
  assert.equal(locateTime(timeline, 3000).clip.metadata.webcli.clip_id, "c2");
  assert.equal(locateTime(timeline, 10000).offset, 7000);
});

test("reorders a clip across multiple positions without changing source ranges", () => {
  let timeline = newEditorTimeline();
  for (const id of ["a", "b", "c", "d"]) timeline = addClip(timeline, source, id);
  const moved = reorderClip(timeline, "a", 3);
  assert.deepEqual(clipsOf(moved).map((clip) => clip.metadata.webcli.clip_id), ["b", "c", "d", "a"]);
  const movedBack = reorderClip(moved, "a", 0);
  assert.deepEqual(clipsOf(movedBack).map((clip) => clip.metadata.webcli.clip_id), ["a", "b", "c", "d"]);
  assert.equal(timelineDuration(moved), timelineDuration(timeline));
  assert.equal(clipsOf(timeline)[0].metadata.webcli.clip_id, "a");
  assert.throws(() => reorderClip(timeline, "a", 4), { reason: "no-source" });
});
