import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bendAllowance, resolveGeometry, defaultPart, sanitizePart, mergeCutOutlines, clampCutToPanel,
  removeBendCascade, nextFreeBendSlot, firstFreeEdge, cutHalfExtents, pointInRing, cutToRing,
} from '../src/index.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

test('bend allowance = angle(rad) * (r + K*t), r = t, K = 0.33', () => {
  near(bendAllowance(2, 90), (Math.PI / 2) * (2 + 0.33 * 2));
  near(bendAllowance(2, 0), 0);
  near(bendAllowance(1.5, 180, { kFactor: 0.5 }), Math.PI * (1.5 + 0.5 * 1.5));
});

test('U bracket: flanges are placed outward by bend allowance + half the flange', () => {
  const g = resolveGeometry(defaultPart());
  const ba = bendAllowance(2, 90);
  const [base, left, right] = g.segments;
  assert.equal(base.id, 'base');
  near(left.flatCenter.x, -150 - (ba + 30));
  near(left.flatCenter.y, 0);
  near(right.flatCenter.x, 150 + (ba + 30));
  assert.equal(left.width, 480);                  // hinge runs along the base length
  near(g.totalAreaM2, (300 * 480 + 2 * 480 * (60 + ba)) / 1e6);
  assert.equal(g.bendCount, 2);
});

test('the flat pattern ignores the fold angle for placement except through the allowance', () => {
  const a = sanitizePart({ ...defaultPart(), bends: [{ parent: 'base', edge: 'top', angle: 90, flangeLength: 40 }] });
  const b = sanitizePart({ ...defaultPart(), bends: [{ parent: 'base', edge: 'top', angle: 0, flangeLength: 40 }] });
  const ya = resolveGeometry(a).segments[1].flatCenter.y;
  const yb = resolveGeometry(b).segments[1].flatCenter.y;
  near(yb, 240 + 20);                              // angle 0 -> no allowance strip
  assert.ok(ya > yb);
});

test('a bend on a bend chains the frame (flange of a flange)', () => {
  const part = sanitizePart({
    thickness: 2, width: 100, length: 200,
    bends: [
      { parent: 'base', edge: 'top', angle: 90, flangeLength: 50 },
      { parent: 'bend1', edge: 'top', angle: 90, flangeLength: 30 },
    ],
  });
  const g = resolveGeometry(part);
  const ba = bendAllowance(2, 90);
  const b1 = g.segments[1];
  const b2 = g.segments[2];
  near(b1.flatCenter.y, 100 + ba + 25);
  near(b2.flatCenter.y, b1.flatCenter.y + 25 + ba + 15);   // continues in the same direction
  assert.equal(b2.parentId, 'bend1');
});

test('sanitize: no cycles, bad parents fall back, "bottom" on a flange becomes "top"', () => {
  const p = sanitizePart({
    bends: [
      { parent: 'bend9', edge: 'bottom', angle: 999, flangeLength: 1 },
      { parent: 'bend1', edge: 'bottom' },
    ],
  });
  assert.equal(p.bends[0].parent, 'base');
  assert.equal(p.bends[0].angle, 180);
  assert.equal(p.bends[0].flangeLength, 5);
  assert.equal(p.bends[1].parent, 'bend1');
  assert.equal(p.bends[1].edge, 'top');
});

test('sanitize: garbage input yields a valid default part', () => {
  const p = sanitizePart({ thickness: 'abc', width: -5, length: 1e9, bends: 'x', cuts: null });
  assert.equal(p.thickness, 2);
  assert.equal(p.width, 10);
  assert.equal(p.length, 6000);
  assert.ok(Array.isArray(p.bends) && Array.isArray(p.cuts));
});

test('cuts are clamped inside their panel with the minimum ligament', () => {
  const c = { shape: 'circular', x: 9999, y: -9999, rotation: 0, w: 500, h: 500 };
  clampCutToPanel(c, 100, 200, 2);
  assert.ok(c.w <= 96);
  assert.ok(Math.abs(c.x) + c.w / 2 <= 50 - 2 + 1e-9);
  assert.ok(Math.abs(c.y) + c.h / 2 <= 100 - 2 + 1e-9);
});

test('rotated rectangle: footprint grows with rotation', () => {
  const flat = cutHalfExtents({ shape: 'rectangular', w: 40, h: 10, rotation: 0 });
  const diag = cutHalfExtents({ shape: 'rectangular', w: 40, h: 10, rotation: 45 });
  assert.equal(flat.hx, 20);
  assert.ok(diag.hy > flat.hy);
});

test('overlapping cuts are merged into ONE outline; disjoint ones stay separate', () => {
  const overlapping = mergeCutOutlines([
    { shape: 'circular', x: 0, y: 0, w: 20, h: 20, rotation: 0 },
    { shape: 'circular', x: 10, y: 0, w: 20, h: 20, rotation: 0 },
  ]);
  assert.equal(overlapping.length, 1);
  assert.equal(overlapping[0].circle, null);       // merged polygon, not a lone circle

  const disjoint = mergeCutOutlines([
    { shape: 'circular', x: -50, y: 0, w: 10, h: 10, rotation: 0 },
    { shape: 'circular', x: 50, y: 0, w: 10, h: 10, rotation: 0 },
  ]);
  assert.equal(disjoint.length, 2);
  assert.ok(disjoint.every((d) => d.circle));      // each is an isolated circle -> exact CIRCLE entity
});

test('a circle fully inside a rectangle disappears into the rectangle outline', () => {
  const out = mergeCutOutlines([
    { shape: 'rectangular', x: 0, y: 0, w: 60, h: 40, rotation: 0 },
    { shape: 'circular', x: 0, y: 0, w: 10, h: 10, rotation: 0 },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].circle, null);
  assert.ok(pointInRing([25, 15], out[0].ring));
});

test('cutToRing is closed', () => {
  const r = cutToRing({ shape: 'triangular', x: 0, y: 0, w: 20, rotation: 30 });
  assert.deepEqual(r[0], r[r.length - 1]);
  assert.equal(r.length, 4);
});

test('an edge takes only one bend; next free slot prefers chaining on the last bend', () => {
  const bends = [{ parent: 'base', edge: 'right' }];
  assert.equal(firstFreeEdge(bends, 'base'), 'left');
  assert.deepEqual(nextFreeBendSlot(bends), { parent: 'bend1', edge: 'top' });
  const full = ['right', 'left', 'top', 'bottom'].map((edge) => ({ parent: 'base', edge }));
  assert.equal(firstFreeEdge(full, 'base'), null);
});

test('removing a bend removes its descendants, renumbers the rest and drops their cuts', () => {
  const cfg = {
    bends: [
      { parent: 'base', edge: 'left' },     // bend1
      { parent: 'bend1', edge: 'top' },     // bend2 (child of bend1)
      { parent: 'base', edge: 'right' },    // bend3
    ],
    cuts: [
      { segment: 'bend2' }, { segment: 'bend3' }, { segment: 'base' },
    ],
  };
  const res = removeBendCascade(cfg, 0);
  assert.deepEqual(res, { bends: 2, cuts: 1 });
  assert.equal(cfg.bends.length, 1);
  assert.equal(cfg.bends[0].edge, 'right');
  assert.deepEqual(cfg.cuts.map((c) => c.segment), ['bend1', 'base']);   // bend3 -> bend1
});
