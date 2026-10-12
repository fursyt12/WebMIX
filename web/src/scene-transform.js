/*
 * Scene-item editing, by OBS's rules.
 *
 * What the desktop preview does when a source is dragged, stretched, cropped
 * or rotated (OBSBasicPreview.cpp), as pure functions over the transform OBS
 * reports, so the arithmetic is tested without a browser or an OBS.
 *
 * An item is a box: its size is the cropped source times the scale, or the
 * bounding box when it has one. `alignment` says which point of the box sits
 * on `position`, and the box turns around that point by `rotation`. A point of
 * the box is addressed by (u, v) in 0..1 - (0,0) its first corner, (1,1) the
 * opposite one - so a handle, the corner it pulls against and the centre are
 * all the same kind of thing.
 */

const radians = (degrees) => (degrees * Math.PI) / 180;

/** Where `alignment` (LEFT=1, RIGHT=2, TOP=4, BOTTOM=8) puts the position. */
export function anchorOf(alignment = 5) {
  return {
    ax: alignment & 1 ? 0 : alignment & 2 ? 1 : 0.5,
    ay: alignment & 4 ? 0 : alignment & 8 ? 1 : 0.5,
  };
}

/** The (u, v) of each handle. */
export const HANDLES = {
  nw: { hu: 0, hv: 0 },
  n: { hu: 0.5, hv: 0 },
  ne: { hu: 1, hv: 0 },
  e: { hu: 1, hv: 0.5 },
  se: { hu: 1, hv: 1 },
  s: { hu: 0.5, hv: 1 },
  sw: { hu: 0, hv: 1 },
  w: { hu: 0, hv: 0.5 },
};

/** The item's box. Width and height keep their sign: a flipped item has a
 *  negative one. */
export function boxOf(transform) {
  const cropWidth = Math.max(1, (transform.sourceWidth || 0) - (transform.cropLeft || 0) - (transform.cropRight || 0));
  const cropHeight = Math.max(1, (transform.sourceHeight || 0) - (transform.cropTop || 0) - (transform.cropBottom || 0));
  const bounded = Boolean(transform.boundsType) && transform.boundsType !== 'OBS_BOUNDS_NONE';
  const { ax, ay } = anchorOf(transform.alignment);
  return {
    width: bounded ? transform.boundsWidth || 1 : cropWidth * (transform.scaleX ?? 1),
    height: bounded ? transform.boundsHeight || 1 : cropHeight * (transform.scaleY ?? 1),
    ax,
    ay,
    rotation: transform.rotation || 0,
    x: transform.positionX || 0,
    y: transform.positionY || 0,
    bounded,
    cropWidth,
    cropHeight,
  };
}

/** Box point (u, v) -> canvas. */
export function toScene(box, u, v) {
  const lx = (u - box.ax) * box.width;
  const ly = (v - box.ay) * box.height;
  const cos = Math.cos(radians(box.rotation));
  const sin = Math.sin(radians(box.rotation));
  return { x: box.x + lx * cos - ly * sin, y: box.y + lx * sin + ly * cos };
}

/** A canvas vector turned back into the box's own (unrotated) axes. */
function unrotate(box, dx, dy) {
  const cos = Math.cos(radians(box.rotation));
  const sin = Math.sin(radians(box.rotation));
  return { x: dx * cos + dy * sin, y: -dx * sin + dy * cos };
}

/** Canvas point -> (u, v) of the box. */
export function toBox(box, point) {
  const local = unrotate(box, point.x - box.x, point.y - box.y);
  return { u: local.x / box.width + box.ax, v: local.y / box.height + box.ay };
}

export function contains(box, point) {
  const { u, v } = toBox(box, point);
  return u >= 0 && u <= 1 && v >= 0 && v <= 1;
}

/** The axis-aligned rectangle around the (possibly rotated) box. */
export function bounds(box) {
  const xs = [];
  const ys = [];
  for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
    const point = toScene(box, u, v);
    xs.push(point.x);
    ys.push(point.y);
  }
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}

/* ---------------------------------------------------------------- snapping */

/**
 * The lines things stick to, per axis: the canvas edges (ScreenSnapping), the
 * edges of the other sources (SourceSnapping), and separately the canvas
 * centre, which only an item's own centre snaps to (CenterSnapping).
 * @param {{baseWidth:number, baseHeight:number}} canvas
 * @param {Array<{left:number, top:number, right:number, bottom:number}>} others
 * @param {{screen?:boolean, sources?:boolean, center?:boolean}} options
 */
export function snapLines(canvas, others = [], options = {}) {
  const lines = { x: [], y: [], centerX: [], centerY: [] };
  if (options.screen !== false) {
    lines.x.push(0, canvas.baseWidth);
    lines.y.push(0, canvas.baseHeight);
  }
  if (options.sources !== false) {
    for (const other of others) {
      lines.x.push(other.left, other.right);
      lines.y.push(other.top, other.bottom);
    }
  }
  if (options.center) {
    lines.centerX.push(canvas.baseWidth / 2);
    lines.centerY.push(canvas.baseHeight / 2);
  }
  return lines;
}

/** The nearest line within `threshold` of any of `values`: how far to move
 *  to reach it, and which line it is. */
function nearest(values, lines, threshold) {
  let best = null;
  for (const value of values) {
    for (const line of lines) {
      const distance = line - value;
      if (Math.abs(distance) <= threshold && (!best || Math.abs(distance) < Math.abs(best.offset))) {
        best = { offset: distance, line };
      }
    }
  }
  return best;
}

/**
 * Move an item by (dx, dy), sticking its edges (and centre) to the lines.
 * @returns {{patch: {positionX:number, positionY:number}, guides: {x:number|null, y:number|null}}}
 */
export function move(transform, dx, dy, lines = null, threshold = 0) {
  const box = boxOf(transform);
  const rect = bounds(box);
  let offsetX = dx;
  let offsetY = dy;
  const guides = { x: null, y: null };

  if (lines && threshold > 0) {
    const left = rect.left + dx;
    const right = rect.right + dx;
    const top = rect.top + dy;
    const bottom = rect.bottom + dy;
    const snapX =
      nearest([left, right], lines.x, threshold) ?? nearest([(left + right) / 2], lines.centerX, threshold);
    const snapY =
      nearest([top, bottom], lines.y, threshold) ?? nearest([(top + bottom) / 2], lines.centerY, threshold);
    if (snapX) {
      offsetX += snapX.offset;
      guides.x = snapX.line;
    }
    if (snapY) {
      offsetY += snapY.offset;
      guides.y = snapY.line;
    }
  }

  return { patch: { positionX: box.x + offsetX, positionY: box.y + offsetY }, guides };
}

/* ------------------------------------------------------ stretch, crop, turn */

/** The position that keeps box point (fu, fv) where it was, for a new size. */
function positionKeeping(box, fixed, fu, fv, width, height) {
  const lx = (fu - box.ax) * width;
  const ly = (fv - box.ay) * height;
  const cos = Math.cos(radians(box.rotation));
  const sin = Math.sin(radians(box.rotation));
  return { positionX: fixed.x - (lx * cos - ly * sin), positionY: fixed.y - (lx * sin + ly * cos) };
}

/** A handle's pull along one axis: the new signed size, never through zero. */
function pulled(original, distance, direction) {
  if (direction === 0) return original;
  const size = distance * direction;
  const sign = original < 0 ? -1 : 1;
  return size * sign < 1 ? sign : size;
}

/** Stick the pulled edges to the lines - only for an upright item, where an
 *  edge is a line of the canvas (as OBS does). */
function snapPoint(box, handle, point, lines, threshold) {
  const guides = { x: null, y: null };
  if (!lines || !(threshold > 0) || Math.abs(box.rotation % 360) > 0.01) return { point, guides };
  const snapped = { ...point };
  if (handle.hu !== 0.5) {
    const hit = nearest([point.x], lines.x, threshold);
    if (hit) {
      snapped.x += hit.offset;
      guides.x = hit.line;
    }
  }
  if (handle.hv !== 0.5) {
    const hit = nearest([point.y], lines.y, threshold);
    if (hit) {
      snapped.y += hit.offset;
      guides.y = hit.line;
    }
  }
  return { point: snapped, guides };
}

/**
 * Drag a handle to `point` (canvas): the opposite corner or edge stays put.
 * A corner keeps the proportions unless `free` (Shift); an edge stretches one
 * dimension. An item with a bounding box gets a new bounding box, any other a
 * new scale.
 */
export function stretch(transform, handle, point, { free = false, lines = null, threshold = 0 } = {}) {
  const box = boxOf(transform);
  const fu = handle.hu === 0.5 ? 0.5 : 1 - handle.hu;
  const fv = handle.hv === 0.5 ? 0.5 : 1 - handle.hv;
  const fixed = toScene(box, fu, fv);
  const snapped = snapPoint(box, handle, point, lines, threshold);
  const local = unrotate(box, snapped.point.x - fixed.x, snapped.point.y - fixed.y);

  let width = pulled(box.width, local.x, handle.hu - fu);
  let height = pulled(box.height, local.y, handle.hv - fv);

  const corner = handle.hu !== 0.5 && handle.hv !== 0.5;
  if (corner && !free) {
    const ratio = Math.max(Math.abs(width / box.width), Math.abs(height / box.height));
    width = box.width * ratio;
    height = box.height * ratio;
  }

  const patch = positionKeeping(box, fixed, fu, fv, width, height);
  if (box.bounded) {
    patch.boundsWidth = Math.max(1, Math.abs(width));
    patch.boundsHeight = Math.max(1, Math.abs(height));
  } else {
    patch.scaleX = width / box.cropWidth;
    patch.scaleY = height / box.cropHeight;
  }
  return { patch, guides: corner && !free ? { x: null, y: null } : snapped.guides };
}

/**
 * Alt-drag a handle: crop the side(s) it belongs to, in source pixels. What is
 * left of the picture does not move.
 */
export function crop(transform, handle, point) {
  const box = boxOf(transform);
  const fu = handle.hu === 0.5 ? 0.5 : 1 - handle.hu;
  const fv = handle.hv === 0.5 ? 0.5 : 1 - handle.hv;
  const fixed = toScene(box, fu, fv);
  const local = unrotate(box, point.x - fixed.x, point.y - fixed.y);
  const patch = {};

  /* Without a bounding box the picture is shown at scale, so pixels of the
   * drag are pixels of the box; with one, the box does not change at all and
   * the drag is measured against the box. */
  const scaleX = box.bounded ? box.width / box.cropWidth : transform.scaleX ?? 1;
  const scaleY = box.bounded ? box.height / box.cropHeight : transform.scaleY ?? 1;
  let width = box.width;
  let height = box.height;

  if (handle.hu !== 0.5) {
    const side = handle.hu === 1 ? 'cropRight' : 'cropLeft';
    const before = transform[side] || 0;
    const visible = Math.min(box.cropWidth + before, Math.max(1, (local.x * (handle.hu - fu)) / scaleX));
    patch[side] = Math.max(0, Math.round(before + box.cropWidth - visible));
    width = (box.cropWidth + before - patch[side]) * scaleX;
  }
  if (handle.hv !== 0.5) {
    const side = handle.hv === 1 ? 'cropBottom' : 'cropTop';
    const before = transform[side] || 0;
    const visible = Math.min(box.cropHeight + before, Math.max(1, (local.y * (handle.hv - fv)) / scaleY));
    patch[side] = Math.max(0, Math.round(before + box.cropHeight - visible));
    height = (box.cropHeight + before - patch[side]) * scaleY;
  }

  if (!box.bounded) Object.assign(patch, positionKeeping(box, fixed, fu, fv, width, height));
  return { patch, guides: { x: null, y: null } };
}

/**
 * Turn the item about its centre so that its top faces `point`. `step` rounds
 * the angle (Shift: 15 degrees).
 */
export function rotate(transform, point, { step = 0 } = {}) {
  const box = boxOf(transform);
  const centre = toScene(box, 0.5, 0.5);
  let angle = (Math.atan2(point.y - centre.y, point.x - centre.x) * 180) / Math.PI + 90;
  /* A flipped item's top is on the other side. */
  if (box.height < 0) angle += 180;
  if (step > 0) angle = Math.round(angle / step) * step;
  angle = ((((angle + 180) % 360) + 360) % 360) - 180;

  const lx = (0.5 - box.ax) * box.width;
  const ly = (0.5 - box.ay) * box.height;
  const cos = Math.cos(radians(angle));
  const sin = Math.sin(radians(angle));
  return {
    patch: {
      rotation: angle,
      positionX: centre.x - (lx * cos - ly * sin),
      positionY: centre.y - (lx * sin + ly * cos),
    },
    guides: { x: null, y: null },
  };
}
