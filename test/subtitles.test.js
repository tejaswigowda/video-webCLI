import test from "node:test";
import assert from "node:assert/strict";
import { captionsAt, captionsToWebVtt, parseSrt } from "../subtitles.js";
import { newEditorTimeline, setCaptions } from "../editor-model.js";

test("parses SRT timestamps and multiline captions with CRLF and BOM", () => {
  const cues = parseSrt("\uFEFF1\r\n00:00:01,250 --> 00:00:03,500\r\nFirst line\r\nSecond line\r\n\r\n2\r\n00:00:03,500 --> 00:00:04,000\r\nNext\r\n");
  assert.deepEqual(cues, [
    { start: 1250, end: 3500, text: "First line\nSecond line" },
    { start: 3500, end: 4000, text: "Next" }
  ]);
  assert.equal(captionsAt(cues, 3499), "First line\nSecond line");
  assert.equal(captionsAt(cues, 3500), "Next");
  assert.equal(captionsAt(cues, 4000), "");
});

test("rejects malformed, empty, and backwards cues", () => {
  assert.throws(() => parseSrt(""), /empty/);
  assert.throws(() => parseSrt("1\n00:61:01,000 --> 00:61:02,000\nText"), /timestamp/);
  assert.throws(() => parseSrt("1\n00:00:02,000 --> 00:00:01,000\nText"), /duration/);
  assert.throws(() => parseSrt("1\nnot a timestamp\nText"), /timing/);
});

test("stores independent global captions on the timeline", () => {
  const original = newEditorTimeline();
  const captions = parseSrt("1\n00:00:01,000 --> 00:00:02,000\nHello");
  const updated = setCaptions(original, captions);
  captions[0].text = "Changed";
  assert.equal(updated.metadata.webcli.captions[0].text, "Hello");
  assert.deepEqual(original.metadata.webcli.captions, []);
  assert.throws(() => setCaptions(updated, [{ start: 3, end: 2, text: "bad" }]), /Invalid/);
});

test("converts global captions to ordered and escaped WebVTT", () => {
  const captions = [
    { start: 2000, end: 3500, text: "A & B\n<literal>" },
    { start: 0, end: 1000, text: "First" }
  ];
  assert.equal(captionsToWebVtt(captions), "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nFirst\n\n00:00:02.000 --> 00:00:03.500\nA &amp; B\n&lt;literal&gt;\n\n");
  assert.equal(captions[0].start, 2000);
});
