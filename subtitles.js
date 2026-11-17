function parseTimestamp(value) {
  const match = /^(\d{2,}):(\d{2}):(\d{2})[,.](\d{3})$/.exec(value);
  if (!match) throw new Error(`Invalid SRT timestamp: ${value}`);
  const [, hours, minutes, seconds, milliseconds] = match;
  if (Number(minutes) > 59 || Number(seconds) > 59) {
    throw new Error(`Invalid SRT timestamp: ${value}`);
  }
  const time = ((Number(hours) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000 + Number(milliseconds);
  if (!Number.isSafeInteger(time)) throw new Error(`Invalid SRT timestamp: ${value}`);
  return time;
}

export function parseSrt(contents) {
  const input = contents.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
  if (!input) throw new Error("The SRT file is empty.");
  return input.split(/\n[ \t]*\n/).map((block, index) => {
    const lines = block.split("\n");
    if (/^\d+$/.test(lines[0].trim())) lines.shift();
    const timing = lines.shift()?.trim().match(/^(\S+)\s+-->\s+(\S+)$/);
    if (!timing) throw new Error(`Invalid timing in SRT cue ${index + 1}.`);
    const start = parseTimestamp(timing[1]);
    const end = parseTimestamp(timing[2]);
    const text = lines.join("\n").trim();
    if (end <= start || !text) throw new Error(`Invalid duration or text in SRT cue ${index + 1}.`);
    return { start, end, text };
  });
}

export function captionsAt(cues, positionMs) {
  return cues.filter((cue) => positionMs >= cue.start && positionMs < cue.end)
    .map((cue) => cue.text).join("\n");
}

export function captionsToWebVtt(cues) {
  const timestamp = (ms) => {
    const hours = Math.floor(ms / 3_600_000);
    const minutes = Math.floor(ms / 60_000) % 60;
    const seconds = Math.floor(ms / 1000) % 60;
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
  };
  return `WEBVTT\n\n${[...cues].sort((a, b) => a.start - b.start || a.end - b.end)
    .map((cue) => `${timestamp(cue.start)} --> ${timestamp(cue.end)}\n${cue.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}\n\n`).join("")}`;
}
