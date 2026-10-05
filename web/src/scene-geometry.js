/*
 * Scene-item geometry.
 *
 * Everything the preview needs to place things: where an item sits on the
 * canvas, where the canvas is drawn inside a pane, and what a resize handle
 * does to the item's transform. Pure functions, so the arithmetic can be
 * tested without a browser or an OBS.
 *
 * The units matter. A scene item transform as OBS reports it (and as
 * obs-websocket reports it, and as the native service reports it) already has
 * the scale folded into `width`/`height`:
 *
 *     width = scaleX * sourceWidth        height = scaleY * sourceHeight
 *
 * `sourceWidth`/`sourceHeight` are the source's intrinsic size. Scene
 * coordinates are canvas pixels; client coordinates are CSS pixels.
 */

/** Decode OBS's alignment bitmask (LEFT=1, RIGHT=2, TOP=4, BOTTOM=8). */
export function alignmentAnchor(alignment = 0) {
  const anchorX = alignment & 1 ? 0 : alignment & 2 ? 1 : 0.5;
  const anchorY = alignment & 4 ? 0 : alignment & 8 ? 1 : 0.5;
  return { anchorX, anchorY };
}

/**
 * The item's box in scene coordinates, plus the anchor the transform is
 * positioned by (rotation and crop are ignored, as OBS's overlay does).
 * @param {object} transform as OBS reports it
 */
export function itemBox(transform) {
  const width = Math.abs(transform.width);
  const height = Math.abs(transform.height);
  const { anchorX, anchorY } = alignmentAnchor(transform.alignment);
  return {
    left: transform.positionX - anchorX * width,
    top: transform.positionY - anchorY * height,
    width,
    height,
    anchorX,
    anchorY,
    transform,
  };
}

/**
 * Where the canvas picture is actually drawn inside an element whose content is
 * `object-fit: contain`: the element's box may be wider or taller than the
 * picture, and the picture is centred in it.
 * @param {{left:number, top:number, width:number, height:number}} frameRect
 * @param {{baseWidth?:number, baseHeight?:number}} video
 */
export function pictureBox(frameRect, video) {
  const baseWidth = video?.baseWidth || 1920;
  const baseHeight = video?.baseHeight || 1080;
  const scale = Math.min(frameRect.width / baseWidth, frameRect.height / baseHeight);
  const width = baseWidth * scale;
  const height = baseHeight * scale;
  return {
    scale,
    baseWidth,
    baseHeight,
    width,
    height,
    left: frameRect.left + (frameRect.width - width) / 2,
    top: frameRect.top + (frameRect.height - height) / 2,
  };
}

/**
 * Where to put the selection overlay for an item: the item's box mapped onto
 * the picture, expressed relative to the pane's box - which is what an
 * absolutely positioned child of the pane needs.
 * @param {object} transform as OBS reports it
 * @param {object} frameRect the element drawing the canvas (client rect)
 * @param {object} paneRect the pane the overlay is positioned in (client rect)
 * @param {object} video the OBS video settings
 */
export function overlayRect(transform, frameRect, paneRect, video) {
  const box = itemBox(transform);
  const picture = pictureBox(frameRect, video);
  const origin = sceneToPane(box.left, box.top, frameRect, paneRect, video);
  return {
    left: origin.x,
    top: origin.y,
    width: box.width * picture.scale,
    height: box.height * picture.scale,
    picture,
    box,
  };
}

/**
 * Scene coordinates -> coordinates relative to the pane's box, which is what an
 * absolutely positioned overlay uses.
 */
export function sceneToPane(x, y, frameRect, paneRect, video) {
  const picture = pictureBox(frameRect, video);
  return {
    x: frameRect.left - paneRect.left + (picture.left - frameRect.left) + x * picture.scale,
    y: frameRect.top - paneRect.top + (picture.top - frameRect.top) + y * picture.scale,
  };
}

/** The smallest box a handle drag is allowed to produce, in scene units. */
export const MIN_BOX_SIZE = 4;

/** Drag the whole item by `dx`/`dy` scene units. */
export function moveBox(box, dx, dy) {
  return { ...box, left: box.left + dx, top: box.top + dy };
}

/**
 * The box a resize handle drag proposes, keeping the opposite side fixed.
 * `dx`/`dy` are in scene units.
 * @param {object} box from itemBox()
 * @param {string} handle one of nw, n, ne, e, se, s, sw, w
 */
export function resizeBox(box, handle, dx, dy) {
  let left = box.left;
  let top = box.top;
  let width = box.width;
  let height = box.height;

  if (handle.includes('w')) {
    width = Math.max(MIN_BOX_SIZE, box.width - dx);
    left = box.left + (box.width - width);
  } else if (handle.includes('e')) {
    width = Math.max(MIN_BOX_SIZE, box.width + dx);
  }
  if (handle.includes('n')) {
    height = Math.max(MIN_BOX_SIZE, box.height - dy);
    top = box.top + (box.height - height);
  } else if (handle.includes('s')) {
    height = Math.max(MIN_BOX_SIZE, box.height + dy);
  }

  return { ...box, left, top, width, height };
}

/** The transform patch that puts a box where it is. */
export function boxToTransform(box) {
  const t = box.transform;
  return {
    // Scale is drawn size over *intrinsic* size; a negative original scale is
    // a flip and has to be preserved.
    scaleX: (box.width / t.sourceWidth) * Math.sign(t.scaleX || 1),
    scaleY: (box.height / t.sourceHeight) * Math.sign(t.scaleY || 1),
    positionX: box.left + box.anchorX * box.width,
    positionY: box.top + box.anchorY * box.height,
  };
}

/** Only the position, for a move that leaves the size alone. */
export function boxToPosition(box) {
  return {
    positionX: box.left + box.anchorX * box.width,
    positionY: box.top + box.anchorY * box.height,
  };
}

/** Convenience: the transform patch for a plain handle drag. */
export function resizePatch(box, handle, dx, dy) {
  return boxToTransform(resizeBox(box, handle, dx, dy));
}

/* ---- snapping ----------------------------------------------------------- */

/**
 * The lines an item can stick to: the canvas edges and its centre, on both
 * axes. Returned for one axis because callers snap each axis independently.
 */
export function snapTargets(size) {
  return [0, size / 2, size];
}

/** The nearest snap target to `value`, or null when none is within reach. */
export function nearestTarget(value, size, threshold) {
  let best = null;
  for (const target of snapTargets(size)) {
    const distance = Math.abs(target - value);
    if (distance <= threshold && (!best || distance < best.distance)) {
      best = { target, distance };
    }
  }
  return best ? best.target : null;
}

/**
 * Stick a dragged item to the canvas edges and centre.
 *
 * Each axis picks the single closest match among the item's own edges (and its
 * centre), so an item can end up flush against one line per axis but never
 * stretched between two.
 *
 * @param {object} box proposed box, in scene units
 * @param {{baseWidth:number, baseHeight:number}} canvas
 * @param {number} threshold how close counts as close enough, in scene units
 * @returns {{box: object, guides: {x: number|null, y: number|null}}}
 *   the snapped box and the scene-space guide lines to draw
 */
export function snapMoveBox(box, canvas, threshold) {
  const x = nearestEdgeTarget(
    { left: box.left, center: box.left + box.width / 2, right: box.left + box.width },
    canvas.baseWidth,
    threshold
  );
  const y = nearestEdgeTarget(
    { top: box.top, center: box.top + box.height / 2, bottom: box.top + box.height },
    canvas.baseHeight,
    threshold
  );

  return {
    box: { ...box, left: box.left + (x?.delta ?? 0), top: box.top + (y?.delta ?? 0) },
    guides: { x: x?.guide ?? null, y: y?.guide ?? null },
  };
}

function nearestEdgeTarget(edges, size, threshold) {
  let best = null;
  for (const value of Object.values(edges)) {
    const target = nearestTarget(value, size, threshold);
    if (target === null) continue;
    const delta = target - value;
    if (!best || Math.abs(delta) < Math.abs(best.delta)) {
      best = { delta, guide: target };
    }
  }
  return best;
}

/**
 * Stick the edge a resize handle is dragging to the canvas edges and centre.
 * Only the moving edge is considered: the opposite one is anchored, and pulling
 * it would move the whole item instead of resizing it.
 */
export function snapResizeBox(box, handle, canvas, threshold) {
  const result = { ...box };
  const guides = { x: null, y: null };

  const right = box.left + box.width;
  if (handle.includes('w')) {
    const target = nearestTarget(box.left, canvas.baseWidth, threshold);
    // The right edge is anchored, so the width follows from the snapped edge.
    if (target !== null && right - target >= MIN_BOX_SIZE) {
      result.left = target;
      result.width = right - target;
      guides.x = target;
    }
  } else if (handle.includes('e')) {
    const target = nearestTarget(right, canvas.baseWidth, threshold);
    if (target !== null && target - box.left >= MIN_BOX_SIZE) {
      result.width = target - box.left;
      guides.x = target;
    }
  }

  const bottom = box.top + box.height;
  if (handle.includes('n')) {
    const target = nearestTarget(box.top, canvas.baseHeight, threshold);
    if (target !== null && bottom - target >= MIN_BOX_SIZE) {
      result.top = target;
      result.height = bottom - target;
      guides.y = target;
    }
  } else if (handle.includes('s')) {
    const target = nearestTarget(bottom, canvas.baseHeight, threshold);
    if (target !== null && target - box.top >= MIN_BOX_SIZE) {
      result.height = target - box.top;
      guides.y = target;
    }
  }

  return { box: result, guides };
}

/**
 * Client coordinates -> scene pixels.
 *
 * Deliberately *not* clamped to the canvas: to put an item flush against an
 * edge the pointer has to travel a little past it, and refusing those points
 * would freeze the drag just before the snap could engage. Callers that need
 * "did the gesture start on the canvas" use pointInCanvas().
 */
export function clientToScene(frameRect, video, event) {
  if (!frameRect.width || !frameRect.height) return null;
  const picture = pictureBox(frameRect, video);
  /* A pane that has not been laid out yet would turn a pixel of movement into
   * hundreds of scene units; ignore the interaction instead. */
  if (!(picture.scale > 0.05)) return null;

  return {
    x: (event.clientX - picture.left) / picture.scale,
    y: (event.clientY - picture.top) / picture.scale,
    scale: picture.scale,
    left: picture.left,
    top: picture.top,
  };
}

/**
 * The frame size to ask OBS for, given the element the picture is drawn in.
 *
 * A preview pane is a fraction of the canvas; encoding, transferring, decoding
 * and uploading a full-canvas frame for it is what keeps a browser preview
 * well below the frame rate the application itself renders at. The size is
 * quantised so that dragging a splitter does not reopen the stream on every
 * pixel, and never exceeds the canvas.
 *
 * @param {{width:number, height:number}} frameRect the element's client rect
 * @param {{baseWidth?:number, baseHeight?:number}} video the OBS video settings
 * @param {number} dpr devicePixelRatio (clamped by the caller)
 * @param {number} step quantisation step in pixels
 */
export function streamFrameSize(frameRect, video, dpr = 1, step = 160) {
  const baseWidth = video?.baseWidth || 1920;
  const baseHeight = video?.baseHeight || 1080;
  const laidOut = frameRect.width > 40 && frameRect.height > 40;
  const drawn = laidOut
    ? baseWidth * Math.min(frameRect.width / baseWidth, frameRect.height / baseHeight)
    : baseWidth;
  const width = Math.min(baseWidth, Math.max(step, Math.ceil((drawn * dpr) / step) * step));
  return { width, height: Math.max(2, Math.round((width * baseHeight) / baseWidth)) };
}

/** Whether a scene point is on the canvas at all. */
export function pointInCanvas(point, video) {
  const baseWidth = video?.baseWidth || 1920;
  const baseHeight = video?.baseHeight || 1080;
  return point.x >= 0 && point.y >= 0 && point.x <= baseWidth && point.y <= baseHeight;
}
