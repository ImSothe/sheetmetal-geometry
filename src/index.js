/**
 * sheetmetal-geometry: parametric sheet-metal geometry, pure JS (no Three.js, no DOM).
 *
 * Model of a part:
 *   {
 *     thickness, width, length,                       // mm
 *     bends: [{ parent: 'base'|'bend1'|..., edge: 'left'|'right'|'top'|'bottom',
 *               direction: 'up'|'down', angle: 0..180, flangeLength }],
 *     cuts:  [{ segment: 'base'|'bend1'|..., shape: 'circular'|'rectangular'|'triangular',
 *               x, y, rotation, w, h }],
 *   }
 *
 * Bend chain: every bend picks a `parent` (the base sheet or ANOTHER bend created earlier) and an
 * `edge` of that panel. The chain is resolved bend after bend, both for a 3D viewer and for the
 * flat pattern. In the flat pattern the angle does not matter for placement (it is always drawn
 * "unfolded"); it only changes the bend allowance strip between panels.
 *
 * Axes: X = width, Z = length in 3D; the 2D flat pattern uses (x, y) for (X, Z).
 */

import polygonClipping from 'polygon-clipping';

export const LIMITS = Object.freeze({
  maxBends: 8,
  minAngle: 0, maxAngle: 180,
  minFlange: 5, maxFlange: 500,
  minCutSize: 1, maxCutSize: 500,
  maxCuts: 200,
  minDim: 10, maxDim: 6000,
});

/** Shop-floor defaults: inner radius r = thickness, K-factor 0.33 (neutral-fibre position). */
export const DEFAULT_BEND = Object.freeze({ radiusFactor: 1, kFactor: 0.33 });

export const EDGES = ['left', 'right', 'top', 'bottom'];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const round2 = (v) => Math.round(v * 100) / 100;

/* ------------------------------------------------------------------------------------------
   Bend radius and allowance
   A real bend is not a sharp edge: the sheet curves around an inner radius r. The flat pattern
   inserts a "bend strip" of length BA = angle(rad) * (r + K * t) between the parent edge and the
   flange. "Flange length" is the straight part after the radius.
   ------------------------------------------------------------------------------------------ */

export function bendInnerRadius(t, { radiusFactor } = DEFAULT_BEND) {
  return radiusFactor * t;
}

export function bendAllowance(t, angleDeg, opts = DEFAULT_BEND) {
  const { kFactor } = { ...DEFAULT_BEND, ...opts };
  return (angleDeg * Math.PI / 180) * (bendInnerRadius(t, { ...DEFAULT_BEND, ...opts }) + kFactor * t);
}

/** Minimum material that must remain between a cut and its panel edge: never less than the thickness or 2 mm. */
export function cutEdgeMargin(t) {
  return Math.max(2, t || 0);
}

/* ------------------------------------------------------------------------------------------
   Panel dimensions and cut extents
   ------------------------------------------------------------------------------------------ */

/** Width/length of the base and of every bend, without the flat-pattern vectors. */
export function computeSegmentDims(width, length, bends) {
  const dims = { base: { width, length } };
  bends.forEach((b, i) => {
    const parent = dims[b.parent] || dims.base;
    const horizontalEdge = b.edge === 'left' || b.edge === 'right';
    dims[`bend${i + 1}`] = {
      width: horizontalEdge ? parent.length : parent.width,
      length: Math.max(1, b.flangeLength),
    };
  });
  return dims;
}

/** Half extents (already rotated) of the bounding box a cut occupies. */
export function cutHalfExtents(cut) {
  if (cut.shape === 'circular') return { hx: cut.w / 2, hy: cut.w / 2 };
  if (cut.shape === 'triangular') {
    const r = cut.w / Math.sqrt(3);   // circumradius: a safe bound for any rotation
    return { hx: r, hy: r };
  }
  const rad = (cut.rotation * Math.PI) / 180;
  const hw = cut.w / 2;
  const hh = cut.h / 2;
  return {
    hx: Math.abs(hw * Math.cos(rad)) + Math.abs(hh * Math.sin(rad)),
    hy: Math.abs(hw * Math.sin(rad)) + Math.abs(hh * Math.cos(rad)),
  };
}

/** Largest size a cut may have in a panel (panel minus the minimum ligament on each side). */
export function maxCutSize(cut, panelWidth, panelLength, t) {
  const m = cutEdgeMargin(t);
  const freeW = Math.max(LIMITS.minCutSize, panelWidth - 2 * m);
  const freeL = Math.max(LIMITS.minCutSize, panelLength - 2 * m);
  if (cut.shape === 'circular') return { w: Math.min(freeW, freeL), h: Math.min(freeW, freeL) };
  if (cut.shape === 'triangular') {
    const s = (Math.min(freeW, freeL) / 2) * Math.sqrt(3);
    return { w: s, h: s };
  }
  return { w: freeW, h: freeL };
}

/* ------------------------------------------------------------------------------------------
   Boolean merge of cuts (2D union)
   Overlapping cuts (a circle inside a rectangle, two touching circles) cannot be passed
   separately to a triangulator as holes, nor to a laser cut path (it would re-cut cut material).
   They are unioned first with polygon-clipping, giving ONE clean outline per group of cuts that touch.
   ------------------------------------------------------------------------------------------ */

export const CUT_CIRCLE_SEGMENTS = 64;

/** Closed outline of a cut in mm, in panel coordinates (x = width, y = length), already rotated. */
export function cutToRing(cut, segments = CUT_CIRCLE_SEGMENTS) {
  const ring = [];
  if (cut.shape === 'circular') {
    const r = cut.w / 2;
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      ring.push([cut.x + r * Math.cos(a), cut.y + r * Math.sin(a)]);
    }
  } else {
    const rad = ((cut.rotation || 0) * Math.PI) / 180;
    const co = Math.cos(rad);
    const si = Math.sin(rad);
    let pts;
    if (cut.shape === 'rectangular') {
      pts = [[-cut.w / 2, -cut.h / 2], [cut.w / 2, -cut.h / 2], [cut.w / 2, cut.h / 2], [-cut.w / 2, cut.h / 2]];
    } else {
      const s = cut.w;
      const h = (Math.sqrt(3) / 2) * s;
      pts = [[-s / 2, -h / 3], [s / 2, -h / 3], [0, (2 * h) / 3]];
    }
    pts.forEach(([px, py]) => ring.push([cut.x + px * co - py * si, cut.y + px * si + py * co]));
  }
  ring.push(ring[0].slice());
  return ring;
}

export function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Final holes of a panel after the union.
 * Returns [{ ring: closed [[x,y],...], circle: cut|null }]:
 *   - circle != null: the group is ONE isolated circle (draw it as an exact arc / CIRCLE entity).
 *   - circle == null: merged polygonal outline.
 * If several cuts fully enclose an island of material, that island is scrap and only the outer
 * outline of each group is kept.
 */
export function mergeCutOutlines(cuts) {
  if (!cuts.length) return [];
  const rings = cuts.map((c) => cutToRing(c));
  if (rings.length === 1) return [{ ring: rings[0], circle: cuts[0].shape === 'circular' ? cuts[0] : null }];
  const merged = polygonClipping.union(...rings.map((r) => [r]));
  return merged.map((poly) => {
    const outer = poly[0];
    const inside = cuts.filter((c) => pointInRing([c.x, c.y], outer));
    const lone = inside.length === 1 && inside[0].shape === 'circular' ? inside[0] : null;
    return { ring: outer, circle: lone };
  });
}

/**
 * Clamp a cut so it ALWAYS fits inside its panel (mutates the cut):
 *   1) size: <= panel - 2 * ligament; a rotated footprint that does not fit is scaled down.
 *   2) position: |x| <= width/2 - half-extent - ligament (same for y).
 */
export function clampCutToPanel(cut, panelWidth, panelLength, t) {
  const m = cutEdgeMargin(t);
  const max = maxCutSize(cut, panelWidth, panelLength, t);
  cut.w = clamp(cut.w, LIMITS.minCutSize, max.w);
  cut.h = clamp(cut.h, LIMITS.minCutSize, max.h);
  if (cut.shape === 'circular' || cut.shape === 'triangular') cut.h = cut.w;

  let { hx, hy } = cutHalfExtents(cut);
  const room = Math.min(1, (panelWidth / 2 - m) / (hx || 1), (panelLength / 2 - m) / (hy || 1));
  if (room < 1) {
    cut.w = Math.max(LIMITS.minCutSize, round2(cut.w * room));
    cut.h = Math.max(LIMITS.minCutSize, round2(cut.h * room));
    ({ hx, hy } = cutHalfExtents(cut));
  }

  const maxX = Math.max(0, panelWidth / 2 - hx - m);
  const maxY = Math.max(0, panelLength / 2 - hy - m);
  cut.x = round2(clamp(cut.x, -maxX, maxX));
  cut.y = round2(clamp(cut.y, -maxY, maxY));
  return cut;
}

/* ------------------------------------------------------------------------------------------
   Edge occupancy: an edge accepts only ONE bend
   ------------------------------------------------------------------------------------------ */

/** Edges a bend can attach to: the base has 4; a flange has its free end ('top') and its two sides. */
export function edgeOptionsFor(parentId) {
  return parentId === 'base' || !parentId ? ['right', 'left', 'top', 'bottom'] : ['top', 'left', 'right'];
}

export function occupiedEdges(bends, parentId, exceptIndex = -1) {
  const used = new Set();
  bends.forEach((b, j) => { if (j !== exceptIndex && b.parent === parentId) used.add(b.edge); });
  return used;
}

export function firstFreeEdge(bends, parentId, exceptIndex = -1) {
  const used = occupiedEdges(bends, parentId, exceptIndex);
  return edgeOptionsFor(parentId).find((e) => !used.has(e)) ?? null;
}

/** Panel + edge for a NEW bend: prefer chaining on the last bend, then the base, then any other; null if full. */
export function nextFreeBendSlot(bends) {
  const ids = ['base', ...bends.map((_, j) => `bend${j + 1}`)];
  const order = bends.length ? [ids[ids.length - 1], 'base', ...ids.slice(1, -1)] : ['base'];
  for (const parent of order) {
    const edge = firstFreeEdge(bends, parent);
    if (edge) return { parent, edge };
  }
  return null;
}

/**
 * Remove bend `index` and, in CASCADE, every bend hanging from it (a flange cannot float).
 * Renumbers the remaining `parent` ids and cut segments; cuts on removed bends are dropped.
 * Mutates `cfg`; returns { bends, cuts } removed counts.
 */
export function removeBendCascade(cfg, index) {
  const segIndex = (id) => (id === 'base' ? -1 : Number(String(id).replace('bend', '')) - 1);
  const removed = new Set([index]);
  cfg.bends.forEach((b, j) => { if (j > index && removed.has(segIndex(b.parent))) removed.add(j); });
  const newIndex = new Map();
  let k = 0;
  cfg.bends.forEach((_, j) => { if (!removed.has(j)) newIndex.set(j, k++); });
  const remap = (id) => {
    const j = segIndex(id);
    if (j < 0) return 'base';
    return removed.has(j) || !newIndex.has(j) ? null : `bend${newIndex.get(j) + 1}`;
  };
  cfg.bends = cfg.bends.filter((_, j) => !removed.has(j)).map((b) => ({ ...b, parent: remap(b.parent) }));
  const cutsBefore = cfg.cuts.length;
  cfg.cuts = cfg.cuts.filter((c) => remap(c.segment) !== null).map((c) => ({ ...c, segment: remap(c.segment) }));
  return { bends: removed.size, cuts: cutsBefore - cfg.cuts.length };
}

/* ------------------------------------------------------------------------------------------
   Sanitising untrusted input (user form, localStorage, API payload)
   ------------------------------------------------------------------------------------------ */

export function defaultPart() {
  return {
    thickness: 2, width: 300, length: 480,
    bends: [
      { parent: 'base', edge: 'left', direction: 'up', angle: 90, flangeLength: 60 },
      { parent: 'base', edge: 'right', direction: 'up', angle: 90, flangeLength: 60 },
    ],
    cuts: [],
  };
}

export function sanitizePart(raw) {
  const d = defaultPart();
  const c = {
    thickness: clamp(num(raw?.thickness, d.thickness), 0.4, 25),
    width: clamp(num(raw?.width, d.width), LIMITS.minDim, LIMITS.maxDim),
    length: clamp(num(raw?.length, d.length), LIMITS.minDim, LIMITS.maxDim),
  };

  // Each bend may only rest on 'base' or on a bend ALREADY validated earlier in the list (no cycles).
  const rawBends = Array.isArray(raw?.bends) ? raw.bends : d.bends;
  const validIds = new Set(['base']);
  c.bends = rawBends.slice(0, LIMITS.maxBends).map((b, i) => {
    const parent = b && validIds.has(b.parent) ? b.parent : (i > 0 ? `bend${i}` : 'base');
    validIds.add(`bend${i + 1}`);
    let edge = EDGES.includes(b?.edge) ? b.edge : 'right';
    if (parent !== 'base' && edge === 'bottom') edge = 'top';   // a flange's 'bottom' is its own hinge
    return {
      parent,
      edge,
      direction: b?.direction === 'down' ? 'down' : 'up',
      angle: clamp(num(b?.angle, 90), LIMITS.minAngle, LIMITS.maxAngle),
      flangeLength: clamp(num(b?.flangeLength, 40), LIMITS.minFlange, LIMITS.maxFlange),
    };
  });

  const segmentIds = ['base', ...c.bends.map((_, i) => `bend${i + 1}`)];
  const SHAPES = ['circular', 'rectangular', 'triangular'];
  const rawCuts = Array.isArray(raw?.cuts) ? raw.cuts : d.cuts;
  c.cuts = rawCuts.slice(0, LIMITS.maxCuts).map((k) => ({
    segment: segmentIds.includes(k?.segment) ? k.segment : 'base',
    shape: SHAPES.includes(k?.shape) ? k.shape : 'circular',
    x: num(k?.x, 0),
    y: num(k?.y, 0),
    rotation: num(k?.rotation, 0),
    w: clamp(num(k?.w, 12), LIMITS.minCutSize, LIMITS.maxCutSize),
    h: clamp(num(k?.h, 12), LIMITS.minCutSize, LIMITS.maxCutSize),
  }));

  // Physical limit: no cut may end up outside its panel.
  const dims = computeSegmentDims(c.width, c.length, c.bends);
  c.cuts.forEach((k) => {
    const panel = dims[k.segment] || dims.base;
    clampCutToPanel(k, panel.width, panel.length, c.thickness);
  });
  return c;
}

/* ------------------------------------------------------------------------------------------
   resolveGeometry(part): resolve the bend chain
   For each segment (base + every bend) it returns what is needed to draw it in the flat pattern
   (flatCenter / flatU / flatV; angle ignored) and in 3D (parentId / edge / angleDeg / direction /
   flangeLength / hingeDim, to build the hinge chain).
   ------------------------------------------------------------------------------------------ */

export function resolveGeometry(part, bendOpts = DEFAULT_BEND) {
  const segMap = new Map();
  segMap.set('base', {
    id: 'base', parentId: null, label: 'Base sheet',
    width: part.width, length: part.length,
    hingeDim: null, flangeLength: null, edge: null, angleDeg: 0, direction: 'up',
    flatCenter: { x: 0, y: 0 }, flatU: { x: 1, y: 0 }, flatV: { x: 0, y: 1 },
  });

  part.bends.forEach((b, i) => {
    const parent = segMap.get(b.parent) || segMap.get('base');
    const horizontalEdge = b.edge === 'left' || b.edge === 'right';
    const hingeDim = horizontalEdge ? parent.length : parent.width;
    const length = Math.max(1, b.flangeLength);

    // "Outward" vector (outgoing normal of the chosen edge) and "along the hinge" vector. SAME
    // convention in every panel, including bends on bends: V = outward, U = V rotated -90 deg
    // (in 3D, U = normal x V). A 3D mesh builder using this local frame matches the flat pattern point by point.
    const sign = (b.edge === 'right' || b.edge === 'top') ? 1 : -1;
    const outwardBase = horizontalEdge ? parent.flatU : parent.flatV;
    const outward = { x: outwardBase.x * sign, y: outwardBase.y * sign };
    const alongHinge = { x: outward.y, y: -outward.x };
    const parentHalf = horizontalEdge ? parent.width / 2 : parent.length / 2;
    const hingeMid = { x: parent.flatCenter.x + outward.x * parentHalf, y: parent.flatCenter.y + outward.y * parentHalf };
    const ba = bendAllowance(part.thickness, b.angle, bendOpts);
    const flatCenter = {
      x: hingeMid.x + outward.x * (ba + length / 2),
      y: hingeMid.y + outward.y * (ba + length / 2),
    };

    const id = `bend${i + 1}`;
    segMap.set(id, {
      id, parentId: parent.id, label: `Bend ${i + 1}`,
      width: hingeDim, length, hingeDim, flangeLength: length,
      edge: b.edge, angleDeg: b.angle, direction: b.direction,
      flatCenter, flatU: alongHinge, flatV: outward,
      hingeMid, bendAllowance: ba,
    });
  });

  const segments = ['base', ...part.bends.map((_, i) => `bend${i + 1}`)].map((id) => segMap.get(id));
  const cuts = part.cuts.map((k) => ({ ...k, resolvedSegment: segMap.get(k.segment) || segMap.get('base') }));

  let totalAreaM2 = 0;
  let totalPerimeterM = 0;
  segments.forEach((s) => {
    const ba = s.bendAllowance || 0;
    totalAreaM2 += (s.width * (s.length + ba)) / 1e6;
    totalPerimeterM += s.parentId === null
      ? (2 * (s.width + s.length)) / 1000                 // base: the whole outline is cut
      : (2 * (s.flangeLength + ba) + s.hingeDim) / 1000;   // flange: 3 sides (the hinge is not cut)
  });

  return {
    segments, cuts, totalAreaM2, totalPerimeterM,
    bendCount: part.bends.length,
    cutCount: part.cuts.length,
  };
}
