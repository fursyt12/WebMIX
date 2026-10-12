/*
 * Tests for editing a scene item by OBS's rules: where its box is, what a drag
 * of the body, a handle or the rotation knob does to its transform, and what
 * it sticks to on the way.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { HANDLES, boxOf, toScene, toBox, contains, bounds, snapLines, move, stretch, crop, rotate } from '../src/scene-transform.js';

const CANVAS = { baseWidth: 1920, baseHeight: 1080 };
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-6, `${message ?? ''} ${actual} != ${expected}`);

/** An 800x600 source at (100, 50), top-left aligned, at scale 1. */
const item = (extra = {}) => ({
  positionX: 100, positionY: 50, rotation: 0, scaleX: 1, scaleY: 1, sourceWidth: 800, sourceHeight: 600,
  alignment: 5, boundsType: 'OBS_BOUNDS_NONE', boundsWidth: 0, boundsHeight: 0,
  cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0, ...extra,
});
const apply = (transform, result) => ({ ...transform, ...result.patch });

test('the box is the cropped source at scale, placed by its alignment', () => {
  const box = boxOf(item({ scaleX: 0.5, scaleY: 0.5, cropLeft: 100, cropTop: 100 }));
  assert.equal(box.width, 350);
  assert.equal(box.height, 250);
  assert.deepEqual(toScene(box, 0, 0), { x: 100, y: 50 });
  // Centre-aligned: the position is the middle of the box.
  const centred = boxOf(item({ alignment: 0 }));
  assert.deepEqual(toScene(centred, 0.5, 0.5), { x: 100, y: 50 });
  assert.deepEqual(bounds(centred), { left: -300, top: -250, right: 500, bottom: 350 });
});

test('a bounding box is the box', () => {
  const box = boxOf(item({ boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsWidth: 400, boundsHeight: 400 }));
  assert.equal(box.width, 400);
  assert.equal(box.height, 400);
  assert.ok(box.bounded);
});

test('a turned box is hit where it is drawn', () => {
  const box = boxOf(item({ rotation: 90 }));
  // Turned a quarter about its corner at (100, 50): it now extends left and down.
  near(toScene(box, 1, 0).x, 100);
  near(toScene(box, 1, 0).y, 850);
  assert.ok(contains(box, { x: -200, y: 400 }));
  assert.ok(!contains(box, { x: 400, y: 300 }));
  const round = toBox(box, toScene(box, 0.25, 0.75));
  near(round.u, 0.25);
  near(round.v, 0.75);
});

test('moving sticks an edge to the canvas edge, another source or the centre', () => {
  const lines = snapLines(CANVAS, [{ left: 1200, top: 700, right: 1500, bottom: 900 }], { center: true });
  // 6 px short of the left edge of the canvas: pulled onto it.
  let result = move(item(), -94, 0, lines, 10);
  assert.equal(result.patch.positionX, 0);
  assert.equal(result.guides.x, 0);
  // Right edge 4 px from the other source's left edge.
  result = move(item(), 296, 0, lines, 10);
  assert.equal(result.patch.positionX, 400);
  assert.equal(result.guides.x, 1200);
  // Centre 5 px from the canvas centre.
  result = move(item(), 455, 0, lines, 10);
  assert.equal(result.patch.positionX, 560);
  assert.equal(result.guides.x, 960);
  // Out of reach, or snapping off: exactly where it was put.
  assert.equal(move(item(), 200, 30, lines, 10).patch.positionX, 300);
  assert.equal(move(item(), -94, 0, null, 0).patch.positionX, 6);
});

test('options decide what there is to stick to', () => {
  const others = [{ left: 10, top: 20, right: 30, bottom: 40 }];
  assert.deepEqual(snapLines(CANVAS, others, { screen: false, sources: false }).x, []);
  assert.deepEqual(snapLines(CANVAS, others, { sources: false }).x, [0, 1920]);
  assert.deepEqual(snapLines(CANVAS, others).centerX, []);
});

test('a corner scales in proportion and the opposite corner stays put', () => {
  const start = item();
  const after = apply(start, stretch(start, HANDLES.se, { x: 500, y: 250 }));
  near(after.scaleX, 0.5);
  near(after.scaleY, 0.5);
  assert.equal(after.positionX, 100);
  assert.equal(after.positionY, 50);
  // From the opposite corner, the item moves so that the far corner does not.
  const grown = apply(start, stretch(start, HANDLES.nw, { x: 100 - 800, y: 50 - 600 }));
  near(grown.scaleX, 2);
  near(toScene(boxOf(grown), 1, 1).x, 900);
  near(toScene(boxOf(grown), 1, 1).y, 650);
});

test('Shift frees the proportions, an edge stretches one dimension', () => {
  const start = item();
  const free = apply(start, stretch(start, HANDLES.se, { x: 500, y: 650 }, { free: true }));
  near(free.scaleX, 0.5);
  near(free.scaleY, 1);
  const wide = apply(start, stretch(start, HANDLES.e, { x: 1700, y: 0 }));
  near(wide.scaleX, 2);
  near(wide.scaleY, 1);
});

test('stretching sticks the dragged edge to a line', () => {
  const start = item();
  const lines = snapLines(CANVAS);
  const result = stretch(start, HANDLES.e, { x: 1915, y: 300 }, { lines, threshold: 10 });
  near(toScene(boxOf(apply(start, result)), 1, 0).x, 1920);
  assert.equal(result.guides.x, 1920);
});

test('an item with a bounding box gets a new box, not a new scale', () => {
  const start = item({ boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsWidth: 400, boundsHeight: 300 });
  const result = stretch(start, HANDLES.se, { x: 900, y: 650 });
  near(result.patch.boundsWidth, 800);
  near(result.patch.boundsHeight, 600);
  assert.equal(result.patch.scaleX, undefined);
});

test('a turned item stretches along its own axes', () => {
  const start = item({ rotation: 90 });
  // Its "east" edge now points down: pulling down by 800 doubles the width.
  const after = apply(start, stretch(start, HANDLES.e, { x: 0, y: 50 + 1600 }));
  near(after.scaleX, 2);
  near(after.scaleY, 1);
  near(after.positionX, 100);
  near(after.positionY, 50);
});

test('Alt crops the dragged side, in source pixels, and nothing else moves', () => {
  const start = item({ scaleX: 0.5, scaleY: 0.5 });
  // The box is 400 wide; pulling the right edge in by 100 px hides 200 source px.
  const right = apply(start, crop(start, HANDLES.e, { x: 400, y: 200 }));
  assert.equal(right.cropRight, 200);
  assert.equal(right.positionX, 100);
  // The left edge: the picture that remains stays where it was.
  const left = apply(start, crop(start, HANDLES.w, { x: 200, y: 200 }));
  assert.equal(left.cropLeft, 200);
  near(toScene(boxOf(left), 1, 0).x, 500);
  // Never more than there is.
  assert.equal(crop(start, HANDLES.e, { x: 5000, y: 0 }).patch.cropRight, 0);
});

test('the knob turns the item about its centre', () => {
  const start = item();
  const centre = toScene(boxOf(start), 0.5, 0.5);
  const quarter = apply(start, rotate(start, { x: centre.x + 300, y: centre.y }));
  near(quarter.rotation, 90);
  near(toScene(boxOf(quarter), 0.5, 0.5).x, centre.x);
  near(toScene(boxOf(quarter), 0.5, 0.5).y, centre.y);
  // Shift rounds to 15 degrees.
  const stepped = rotate(start, { x: centre.x + 300, y: centre.y - 20 }, { step: 15 });
  near(stepped.patch.rotation, 90);
});
