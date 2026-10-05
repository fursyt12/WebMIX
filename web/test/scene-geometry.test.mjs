/*
 * Geometry of a scene item in the preview: the selection frame, the hit test
 * and the resize handles all derive from these three functions, so they are
 * tested against numbers a real OBS produced.
 *
 * The fixture is a 2560x1600 screen capture scaled to fit a 1920x1080 canvas
 * (the exact transform the live check read back from OBS).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  alignmentAnchor,
  clientToScene,
  itemBox,
  nearestTarget,
  overlayRect,
  pictureBox,
  pointInCanvas,
  resizePatch,
  sceneToPane,
  snapMoveBox,
  snapResizeBox,
  snapTargets,
  streamFrameSize,
} from '../src/scene-geometry.js';

/** What OBS reports for that item. Note `width` already includes `scaleX`. */
const SCREEN_CAPTURE = {
  alignment: 5, // OBS_ALIGN_LEFT | OBS_ALIGN_TOP
  positionX: 4,
  positionY: -1,
  rotation: 0,
  scaleX: 0.4876337945461273,
  scaleY: 0.45782899856567383,
  sourceWidth: 2560,
  sourceHeight: 1600,
  width: 1248.342514038086,
  height: 732.5263977050781,
};

const VIDEO = { baseWidth: 1920, baseHeight: 1080 };
/* The pane and the contained picture as the live check measured them. */
const FRAME = { left: 562.4375, top: 65, width: 759.109375, height: 426.984375 };
const PANE = { left: 289, top: 65, width: 1306, height: 427 };

const closeTo = (actual, expected, tolerance, message) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message}: expected ${expected} ± ${tolerance}, got ${actual}`
  );

test('OBS reports width with the scale already applied', () => {
  closeTo(SCREEN_CAPTURE.scaleX * SCREEN_CAPTURE.sourceWidth, SCREEN_CAPTURE.width, 0.01, 'scaleX * sourceWidth');
  closeTo(SCREEN_CAPTURE.scaleY * SCREEN_CAPTURE.sourceHeight, SCREEN_CAPTURE.height, 0.01, 'scaleY * sourceHeight');
});

test('itemBox uses the reported size, not the scale twice', () => {
  const box = itemBox(SCREEN_CAPTURE);
  closeTo(box.width, 1248.34, 0.01, 'box width');
  closeTo(box.height, 732.53, 0.01, 'box height');
  // alignment LEFT|TOP anchors at the position itself.
  closeTo(box.left, 4, 0.01, 'box left');
  closeTo(box.top, -1, 0.01, 'box top');
});

test('itemBox anchors a centred item by half its size', () => {
  const centred = { ...SCREEN_CAPTURE, alignment: 0 };
  const box = itemBox(centred);
  closeTo(box.left, 4 - 1248.3425 / 2, 0.01, 'box left');
  closeTo(box.top, -1 - 732.5264 / 2, 0.01, 'box top');
});

test('alignmentAnchor decodes the OBS bitmask', () => {
  assert.deepEqual(alignmentAnchor(5), { anchorX: 0, anchorY: 0 });
  assert.deepEqual(alignmentAnchor(0), { anchorX: 0.5, anchorY: 0.5 });
  assert.deepEqual(alignmentAnchor(10), { anchorX: 1, anchorY: 1 });
});

test('pictureBox finds the letterboxed picture inside the frame', () => {
  const picture = pictureBox(FRAME, VIDEO);
  // The frame is slightly wider than 16:9, so the height is what constrains
  // the picture and it ends up marginally narrower than the element.
  closeTo(picture.scale, 426.984375 / 1080, 1e-9, 'scale');
  closeTo(picture.width, 759.0833333, 0.001, 'picture width');
  closeTo(picture.height, 426.984375, 0.001, 'picture height');
  closeTo(picture.left, 562.4505208, 0.001, 'picture left');
  closeTo(picture.top, FRAME.top, 0.001, 'picture top');
  assert.ok(picture.width <= FRAME.width + 1e-9, 'the picture never overflows its element');
});

test('the selection frame lands on the source, not inside it', () => {
  const rect = overlayRect(SCREEN_CAPTURE, FRAME, PANE, VIDEO);
  // 1248.34 scene px out of a 1920-wide canvas drawn 759.08 px wide, placed
  // relative to the pane (PANE.left = 289, so the client left is 564.03).
  closeTo(rect.width, 493.5396, 0.01, 'selection width');
  closeTo(rect.height, 289.6086, 0.01, 'selection height');
  closeTo(rect.left, 275.0319, 0.01, 'selection left');
  closeTo(rect.top, -0.3954, 0.01, 'selection top');
  assert.ok(rect.width <= rect.picture.width, 'the frame cannot be wider than the canvas');
  assert.ok(
    Math.abs(PANE.left + rect.left - 564.0319) < 0.01,
    'and it lands where the picture puts it on screen'
  );
});

test('a centred source is framed around its centre', () => {
  const centred = { ...SCREEN_CAPTURE, alignment: 0 };
  const rect = overlayRect(centred, FRAME, PANE, VIDEO);
  const picture = pictureBox(FRAME, VIDEO);
  // The centre of the canvas is the centre of the picture.
  const centreX = picture.left - PANE.left + (picture.width * centred.positionX) / picture.baseWidth;
  closeTo(rect.left + rect.width / 2, centreX, 0.01, 'centre x');
});

test('resizing from a handle keeps the opposite edge fixed', () => {
  const box = itemBox(SCREEN_CAPTURE);
  const before = { left: box.left, right: box.left + box.width };

  // Drag the east handle 100 scene units to the right.
  const east = resizePatch(box, 'e', 100, 0);
  closeTo(east.scaleX * SCREEN_CAPTURE.sourceWidth, box.width + 100, 0.01, 'new drawn width');
  closeTo(SCREEN_CAPTURE.positionX, before.left, 0.01, 'left edge stays');

  // Drag the west handle 100 units to the left: the right edge must not move.
  const west = resizePatch(box, 'w', -100, 0);
  closeTo(west.scaleX * SCREEN_CAPTURE.sourceWidth, box.width + 100, 0.01, 'new drawn width');
  closeTo(west.positionX, before.left - 100, 0.01, 'moved left edge');
});

test('a flipped source stays flipped when resized', () => {
  const flipped = { ...SCREEN_CAPTURE, scaleX: -SCREEN_CAPTURE.scaleX, width: SCREEN_CAPTURE.width };
  const box = itemBox(flipped);
  const patch = resizePatch(box, 'e', 50, 0);
  assert.ok(patch.scaleX < 0, 'the sign survives');
  closeTo(patch.scaleX * flipped.sourceWidth, -(box.width + 50), 0.01, 'signed drawn width');
});

test('clientToScene inverts the picture mapping', () => {
  const picture = pictureBox(FRAME, VIDEO);
  const point = clientToScene(FRAME, VIDEO, { clientX: FRAME.left + 100, clientY: FRAME.top + 50 });
  // The picture is inset from the element, so subtract that letterbox offset.
  closeTo(point.x, (100 - (picture.left - FRAME.left)) / picture.scale, 0.01, 'scene x');
  closeTo(point.y, (50 - (picture.top - FRAME.top)) / picture.scale, 0.01, 'scene y');
});

test('clientToScene maps points beyond the canvas instead of refusing them', () => {
  // Dragging an item flush to an edge needs the pointer to leave the canvas;
  // returning null there would freeze the drag before it could snap.
  const outside = clientToScene(FRAME, VIDEO, { clientX: FRAME.left - 5, clientY: FRAME.top + 10 });
  assert.ok(outside.x < 0, 'the point is still mapped');
  assert.equal(pointInCanvas(outside, VIDEO), false);

  const far = clientToScene(FRAME, VIDEO, { clientX: FRAME.left + 10, clientY: FRAME.top + 10000 });
  assert.equal(pointInCanvas(far, VIDEO), false);

  // Only a pane without a usable layout refuses.
  assert.equal(clientToScene({ left: 0, top: 0, width: 0, height: 0 }, VIDEO, { clientX: 0, clientY: 0 }), null);
});

test('pointInCanvas delimits the canvas', () => {
  assert.equal(pointInCanvas({ x: 0, y: 0 }, VIDEO), true);
  assert.equal(pointInCanvas({ x: 1920, y: 1080 }, VIDEO), true);
  assert.equal(pointInCanvas({ x: -0.5, y: 10 }, VIDEO), false);
  assert.equal(pointInCanvas({ x: 10, y: 1080.5 }, VIDEO), false);
});

/* ---- snapping ----------------------------------------------------------- */

const CANVAS = { baseWidth: 1920, baseHeight: 1080 };

test('snapTargets offers both edges and the centre', () => {
  assert.deepEqual(snapTargets(1920), [0, 960, 1920]);
});

test('nearestTarget only reaches as far as the threshold', () => {
  assert.equal(nearestTarget(962, 1920, 10), 960);
  assert.equal(nearestTarget(980, 1920, 10), null);
  assert.equal(nearestTarget(1915, 1920, 10), 1920);
  assert.equal(nearestTarget(8, 1920, 10), 0, 'the closest of two candidates wins');
});

test('a dragged item sticks to the nearest edge or the centre', () => {
  const box = { left: 4, top: -1, width: 400, height: 200 };

  const toLeft = snapMoveBox(box, CANVAS, 8);
  closeTo(toLeft.box.left, 0, 0.001, 'left edge');
  // top is -1, so it sticks to the top edge at the same time.
  assert.deepEqual(toLeft.guides, { x: 0, y: 0 });
  assert.equal(toLeft.box.width, 400, 'snapping never resizes');

  const centred = snapMoveBox({ ...box, left: 756 }, CANVAS, 8);
  closeTo(centred.box.left, 760, 0.001, 'centre: left = 960 - width/2');
  assert.equal(centred.guides.x, 960);

  const toRight = snapMoveBox({ ...box, left: 1524 }, CANVAS, 8);
  closeTo(toRight.box.left, 1520, 0.001, 'right edge = 1920 - width');
  assert.equal(toRight.guides.x, 1920);
});

test('an item out of reach is left exactly where it was', () => {
  const snapped = snapMoveBox({ left: 500, top: 300, width: 400, height: 200 }, CANVAS, 8);
  assert.deepEqual(snapped.guides, { x: null, y: null });
  assert.equal(snapped.box.left, 500);
  assert.equal(snapped.box.top, 300);
});

test('both axes snap independently', () => {
  const snapped = snapMoveBox({ left: 3, top: 443, width: 400, height: 200 }, CANVAS, 8);
  closeTo(snapped.box.left, 0, 0.001, 'x snapped to the left edge');
  closeTo(snapped.box.top, 440, 0.001, 'y snapped to the centre');
  assert.deepEqual(snapped.guides, { x: 0, y: 540 });
});

test('resizing snaps only the edge being dragged', () => {
  const box = { left: 100, top: 100, width: 300, height: 300, transform: {}, anchorX: 0, anchorY: 0 };

  // East handle: the right edge (400) is within reach of the centre (960)? No -
  // use a box whose right edge is near the canvas edge.
  const near = { ...box, left: 1600, width: 316 };
  const east = snapResizeBox(near, 'e', CANVAS, 8);
  closeTo(east.box.left, 1600, 0.001, 'left edge is anchored');
  closeTo(east.box.left + east.box.width, 1920, 0.001, 'right edge snapped');
  assert.equal(east.guides.x, 1920);

  const west = snapResizeBox({ ...box, left: 4 }, 'w', CANVAS, 8);
  closeTo(west.box.left, 0, 0.001, 'left edge snapped');
  closeTo(west.box.left + west.box.width, 304, 0.001, 'right edge is anchored');
  assert.equal(west.guides.x, 0);

  const south = snapResizeBox({ ...box, top: 700, height: 376 }, 's', CANVAS, 8);
  closeTo(south.box.top, 700, 0.001, 'top edge is anchored');
  closeTo(south.box.top + south.box.height, 1080, 0.001, 'bottom edge snapped');
});

test('a corner handle snaps both of its edges', () => {
  const box = { left: 1604, top: 836, width: 320, height: 240, transform: {}, anchorX: 0, anchorY: 0 };
  const snapped = snapResizeBox(box, 'se', CANVAS, 8);
  closeTo(snapped.box.left + snapped.box.width, 1920, 0.001, 'right edge');
  closeTo(snapped.box.top + snapped.box.height, 1080, 0.001, 'bottom edge');
  assert.deepEqual(snapped.guides, { x: 1920, y: 1080 });
});

test('snapping never collapses an item below the minimum size', () => {
  // The anchored right edge is 3 units from the left edge target: snapping
  // would leave a 3-unit box, so it must be refused.
  const box = { left: 3, top: 0, width: 0, height: 100, transform: {}, anchorX: 0, anchorY: 0 };
  const snapped = snapResizeBox(box, 'w', CANVAS, 8);
  assert.equal(snapped.box.left, 3, 'the box is left alone');
  assert.equal(snapped.guides.x, null);
});

test('snapToPane maps scene coordinates into the pane box', () => {
  const origin = sceneToPane(0, 0, FRAME, PANE, VIDEO);
  closeTo(origin.x, 562.4505208 - 289, 0.001, 'canvas left');
  closeTo(origin.y, 65 - 65, 0.001, 'canvas top');
  const centre = sceneToPane(960, 540, FRAME, PANE, VIDEO);
  closeTo(centre.x, 562.4505208 - 289 + 960 * (426.984375 / 1080), 0.001, 'canvas centre');
});

/* ---- preview stream sizing --------------------------------------------- */

test('the preview asks for the size the pane shows, not the whole canvas', () => {
  // The pane draws the 1920x1080 canvas 759 px wide, so at dpr 1 a 800 px
  // frame is plenty - and 5.7x fewer pixels than the canvas.
  const size = streamFrameSize({ left: 0, top: 0, width: 759, height: 427 }, VIDEO, 1, 160);
  assert.equal(size.width, 800);
  assert.equal(size.height, 450);
});

test('a high-density display gets a proportionally larger frame', () => {
  const size = streamFrameSize({ width: 759, height: 427 }, VIDEO, 2, 160);
  assert.equal(size.width, 1600);
  assert.equal(size.height, 900);
});

test('the frame is quantised so a splitter drag does not reopen the stream', () => {
  const a = streamFrameSize({ width: 700, height: 394 }, VIDEO, 1, 160);
  const b = streamFrameSize({ width: 720, height: 405 }, VIDEO, 1, 160);
  assert.deepEqual(a, b, 'small size changes land in the same bucket');
  const c = streamFrameSize({ width: 900, height: 506 }, VIDEO, 1, 160);
  assert.notDeepEqual(b, c, 'a real resize does move it');
});

test('the frame never exceeds the canvas, nor collapses', () => {
  assert.equal(streamFrameSize({ width: 4000, height: 3000 }, VIDEO, 2, 160).width, 1920);
  const tiny = streamFrameSize({ width: 0, height: 0 }, VIDEO, 1, 160);
  assert.equal(tiny.width, 1920, 'a pane that has not been laid out falls back to the canvas');
  // A small but laid-out pane still gets a usable frame, not a sliver.
  assert.equal(streamFrameSize({ width: 200, height: 112 }, VIDEO, 1, 160).width, 320);
});

test('the frame keeps the canvas aspect ratio', () => {
  // Height is what constrains this pane, so the frame follows it.
  const size = streamFrameSize({ width: 1000, height: 400 }, { baseWidth: 2560, baseHeight: 1440 }, 1, 160);
  assert.equal(size.width, 800);
  assert.equal(size.height, 450);
  assert.equal(size.width / size.height, 2560 / 1440);
});
