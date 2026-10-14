# sheetmetal-geometry

Parametric sheet-metal geometry in **pure JavaScript** (no Three.js, no DOM, one dependency):
chained bends, K-factor bend allowance, flat-pattern layout, cut clamping and **boolean-merged
cut outlines**. It is the maths layer behind a B2B 3D configurator: one place that pricing, a
flat-pattern exporter and a 3D mesh builder can all share.

```js
import { defaultPart, resolveGeometry, bendAllowance, mergeCutOutlines } from 'sheetmetal-geometry';

const part = defaultPart();                      // a 300 x 480 mm U bracket, 2 mm, two 90 deg flanges
const g = resolveGeometry(part);

g.segments.map((s) => [s.id, s.flatCenter]);     // where each panel sits in the UNFOLDED pattern
g.totalAreaM2;                                   // developed area, bend strips included
g.totalPerimeterM;                               // laser cut length (hinges are not cut)
bendAllowance(2, 90);                            // 4.18 mm: angle * (r + K * t), r = t, K = 0.33
```

## What it does

| Function | Purpose |
|---|---|
| `resolveGeometry(part)` | Resolves the bend chain. Per segment: flat-pattern frame (`flatCenter`, `flatU`, `flatV`) and the hinge data a 3D builder needs. Also developed area and cut length. Bends can rest on **other bends** |
| `bendAllowance(t, angle, {kFactor, radiusFactor})` | Developed length of the bend strip |
| `sanitizePart(raw)` | Turns untrusted input (form, `localStorage`, API payload) into a valid part: bounds, no parent cycles, valid edges, cuts clamped inside their panel |
| `mergeCutOutlines(cuts)` | 2D **union** of overlapping cuts with [polygon-clipping](https://github.com/mfogel/polygon-clipping). One outline per group, lone circles flagged so you can emit an exact `CIRCLE`/arc |
| `clampCutToPanel`, `maxCutSize`, `cutHalfExtents` | Keep a cut inside its panel with a minimum ligament (≥ thickness, ≥ 2 mm), including rotated rectangles |
| `nextFreeBendSlot`, `firstFreeEdge`, `occupiedEdges` | "One bend per edge" rule for UI selectors |
| `removeBendCascade(cfg, i)` | Deletes a bend and everything hanging from it, renumbers parents and cut segments |

## Why overlapping cuts are merged first

Passing two overlapping holes separately to a triangulator (e.g. `THREE.Shape.holes`) breaks the
triangulation, and sending them separately to a laser re-cuts material that is already gone.
Union them once, get one clean outline.

## Conventions

- Units: mm. Axes: X = width, Z = length (3D); the flat pattern uses `(x, y)` for `(X, Z)`.
- Every panel uses the same local frame: `V` = outward from the chosen edge, `U` = `V` rotated -90°.
  A 3D builder using this frame lines up with the flat pattern point by point.
- Defaults are shop-floor rules of thumb: inner radius `r = t`, `K = 0.33`. Real values depend on
  material, tooling and die width: pass your own `{kFactor, radiusFactor}`.

## Scope and honesty

- This is geometry, **not** a manufacturing exporter: it does not write DXF/STL. It gives you
  everything such an exporter needs.
- Bend allowance uses the simple K-factor model. It is fine for quoting and previews; confirm
  against your press brake's own tables before cutting real metal.
- Extracted and generalised from the public [Industrial-Web-Template](https://github.com/ImSothe/Industrial-Web-Template)
  and rewritten as a standalone ES module with tests. Built with AI-assisted development; the
  behaviour is pinned by the tests below.

## Develop

```bash
npm install
npm test        # node --test, 13 tests
```

## Licence

MIT
