const insetScale = { small: 0.18, medium: 0.26, large: 0.34 };

function dimensions(source) {
  return {
    width: source.videoWidth || source.displayWidth || source.codedWidth || source.width,
    height: source.videoHeight || source.displayHeight || source.codedHeight || source.height
  };
}

function drawFit(context, source, x, y, width, height, fit) {
  const { width: sourceWidth, height: sourceHeight } = dimensions(source);
  if (!sourceWidth || !sourceHeight) return;
  const scale = fit === "cover"
    ? Math.max(width / sourceWidth, height / sourceHeight)
    : Math.min(width / sourceWidth, height / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  const dx = x + (width - drawWidth) / 2;
  const dy = y + (height - drawHeight) / 2;
  if (typeof source.draw === "function") {
    source.draw(context, 0, 0, sourceWidth, sourceHeight, dx, dy, drawWidth, drawHeight);
  } else {
    context.drawImage(source, dx, dy, drawWidth, drawHeight);
  }
}

export function drawComposite(context, screen, camera, layout = {}) {
  const width = context.canvas.width;
  const height = context.canvas.height;
  context.fillStyle = "#000";
  context.fillRect(0, 0, width, height);
  drawFit(context, screen, 0, 0, width, height, "contain");
  if (!camera || !dimensions(camera).width || !dimensions(camera).height) return;

  const scale = insetScale[layout.size] ?? insetScale.medium;
  const insetWidth = Math.round(width * scale);
  const cameraSize = dimensions(camera);
  const insetHeight = layout.shape === "circle"
    ? insetWidth
    : Math.round(insetWidth * cameraSize.height / cameraSize.width);
  const margin = Math.round(width * 0.035);
  const position = layout.position ?? "bottom-right";
  const x = position.endsWith("left") ? margin : width - insetWidth - margin;
  const y = position.startsWith("top") ? margin : height - insetHeight - margin;
  const shape = layout.shape ?? "rounded";
  const radius = shape === "circle"
    ? Math.min(insetWidth, insetHeight) / 2
    : shape === "rectangle" ? 0 : Math.min(insetWidth, insetHeight) * 0.1;

  context.save();
  context.beginPath();
  if (shape === "circle") {
    context.ellipse(x + insetWidth / 2, y + insetHeight / 2, insetWidth / 2, insetHeight / 2, 0, 0, Math.PI * 2);
  } else if (typeof context.roundRect === "function") {
    context.roundRect(x, y, insetWidth, insetHeight, radius);
  } else {
    context.rect(x, y, insetWidth, insetHeight);
  }
  context.clip();
  drawFit(context, camera, x, y, insetWidth, insetHeight, "cover");
  context.restore();
  context.strokeStyle = "#fff";
  context.lineWidth = Math.max(2, Math.round(width * 0.004));
  context.beginPath();
  if (shape === "circle") context.ellipse(x + insetWidth / 2, y + insetHeight / 2, insetWidth / 2, insetHeight / 2, 0, 0, Math.PI * 2);
  else if (typeof context.roundRect === "function") context.roundRect(x, y, insetWidth, insetHeight, radius);
  else context.rect(x, y, insetWidth, insetHeight);
  context.stroke();
}

export function cameraTimeForClip(clip, timelinePositionMs, timelineClipStartMs, screenSourceId) {
  if (clip.metadata.webcli.source_id === screenSourceId) {
    return clip.source_range.start_time.value + timelinePositionMs - timelineClipStartMs;
  }
  return timelinePositionMs;
}
