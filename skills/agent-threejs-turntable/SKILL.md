---
name: agent-threejs-turntable
description: Gate and review a 3D asset (a static .glb or a Three.js factory module) with the agent-threejs-turntable CLI. Use after creating or changing a mesh, material, palette or shader, before claiming an asset is done, and when asked to check budgets, palette, pivot, proportions or framing, or to produce a turntable contact sheet.
---

# agent-threejs-turntable

`agent-threejs-turntable` loads an asset in headless Chromium, measures it, checks it against the project's style card, and renders a labeled 3×3 contact sheet. It tells you whether the asset meets the card. It cannot tell you whether the asset looks right, so every pass ends with a blind visual review of the sheet.

## Run it

- Installed as a dev dependency: `npx agent-threejs-turntable <command>` from the project root.
- Installed under its own manifest (projects pinned to another `three`): call that folder's `node_modules/.bin/agent-threejs-turntable`.
- Missing: `npm install --save-dev agent-threejs-turntable && npx playwright install --only-shell chromium`. The browser takes about 280 MB on disk, so ask first.

`agent-threejs-turntable` with no arguments prints every command and flag. Asset commands exit **0** for a pass, **1** for a gate failure (read `findings` in the JSON report) and **2** for bad input, a renderer error or a gate the tool cannot evaluate (read the JSON error on stderr, or the `unsupported` finding in the report).

`<asset>` is a self-contained binary `.glb` or a factory module (`.ts`, `.mts`, `.js`, `.mjs`) that exports `buildAsset(THREE)` or a default function returning a `THREE.Object3D` or a promise of one. A factory may import project code. `.gltf` files and GLBs that require Draco, Meshopt or KTX2 exit 2; re-export them uncompressed with PNG or JPEG textures.

## Loop

1. **Turntable.** Run the full gate and render the evidence:
   `npx agent-threejs-turntable turntable <asset> --card <card.json> --out out/<name>`
   This writes `out/<name>/contact-sheet.png` and `report.json`.
2. **Check.** Fix one class of finding at a time. After each fix, re-run the measurement gates without rendering:
   `npx agent-threejs-turntable check <asset> --card <card.json>`
   `check` covers mesh, budget, palette, pivot and shape findings. View findings and shader errors only appear in `turntable`, so finish with step 1 again and require exit 0.
3. **Blind critic.** Hand `contact-sheet.png` to a fresh reviewer with the prompt below. Act on its most severe fix, then return to step 1. Use a new critic context every round.

After a change shared by many assets (a material, the palette, a common builder), gate the whole set: `npx agent-threejs-turntable batch <dir> --card <card.json> --out out/batch`. Read the table on stderr, then open `out/batch/<name>/report.json` for each FAIL or ERROR row.

The card is the project's contract. If an asset cannot meet a limit, report the conflict; do not loosen the card to get a pass. An unknown card key exits 2. A palette requires `paletteDeltaE76Max`. Separation pairs must name existing palette roles and include a `separationMinDeltaE76` threshold on the card.

## Findings

| Finding | What to do |
| --- | --- |
| `CONSOLE_ERROR` | A shader failed to compile or the factory logged an error. The finding quotes the first message; `consoleErrors` has the rest. Fix the cause. Use `--no-fail-on-console-error` only for a known harmless third-party message. |
| `DEGENERATE_TRIANGLES`, `EMPTY_GEOMETRY` | Zero-area triangles, or no visible triangles at all. Fix the geometry builder or export. |
| `OPEN_BOUNDARY_EDGES`, `NON_MANIFOLD_EDGES` | Close unintended holes or split edges shared by more than two triangles. `requireWatertight` sets both limits to zero. For intentionally open meshes, the card can set inclusive `maxOpenBoundaryEdges` and `maxNonManifoldEdges` limits. |
| `MISSING_NORMALS`, `ZERO_LENGTH_NORMALS`, `UNNORMALIZED_NORMALS` | `requireValidNormals` checks referenced vertices. Supply missing normals and recompute zero, nonfinite or non-unit normals. |
| `MISSING_UVS` | `requireUvsOnTextured` checks the UV channels each textured material uses. Supply a finite UV pair for each referenced vertex on those channels. |
| `INCONSISTENT_WINDING` | `requireConsistentWinding` found triangles that traverse a shared edge in the same direction. Correct their vertex order. |
| `TRIANGLES_OVER_BUDGET`, `MATERIALS_OVER_BUDGET`, `TEXTURES_OVER_BUDGET`, `GLB_BYTES_OVER_BUDGET` | `actual` and `limit` are in the finding. Reduce the asset. |
| `GLB_BUDGETS_SKIPPED` | The input is a factory. Run the card on the exported GLB to check file size and primitive modes. |
| `NON_TRIANGLE_PRIMITIVES` | Export triangle lists for every primitive when the card requires them. |
| `ROLE_SEPARATION_LOW` | The two named palette colors are closer than the card allows. Check the role pair and its colors with the card owner. |
| `SEPARATION_ROLE_MISSING` | A library caller supplied a separation pair with an unknown role. Correct the name or add the intended role to the palette. The CLI rejects this card before loading the asset. |
| `PALETTE_UNSUPPORTED_TEXTURED` | The card requires a palette measurement on a textured mesh. Supply the authored colors as untextured materials or report that the tool cannot verify this asset against the card. |
| `PALETTE_DELTA_E_EXCEEDED` | Names the mesh, its color and the nearest role. `metrics.palette.colors` lists the 48 most-sampled colors; decide whether the color is a mistake or the card lacks a role, and ask before adding a role. |
| `PALETTE_UNASSESSED_TEXTURED`, `PALETTE_UNASSESSED_SHADER` | Info only. Those meshes were not color-checked, so judge them on the sheet. |
| `PIVOT_CENTER_MISMATCH`, `PIVOT_GROUND_MISMATCH` | The origin is not where the card wants it. Move the geometry to match. |
| `GROUND_FLOATING`, `GROUND_SINKING`, `GROUND_FOOTPRINT_SMALL` | The lowest point is off y=0, or the asset rests on a point or edge. |
| `MIRROR_SYMMETRY_LOW`, `ASPECT_LENGTH_TO_WIDTH`, `ASPECT_HEIGHT_TO_LENGTH` | Shape is outside the card's range. `metrics.shape` has the measured values. |
| `VIEW_EDGE_CLIPPED` | The silhouette touches the tile edge. Check the framing in the named view. Clipping is informational when that view is zoomed in. |
| `VIEW_SUBJECT_MISSING` | The silhouette covers less than 1% of the tile. Check visibility and look for distant geometry that stretches the bounds. |
| `VIEW_BEAUTY_FLAT` | The tile has fewer than two quantized colors. Check the material and lighting. A flat face filling a zoomed tile is informational. |
| `INVERTED_WINDING` | Backface culling hides more than half the nearest front-sided surface in this view. Inspect triangle order before changing the mesh. |

## Look closer

Add these to `turntable` or `batch` when a finding or the critic points at a detail:

- `--tile-size 840x630 --zoom 1.4 --save-views` writes larger single views such as `persp-three-quarter.png`. `--zoom` crops only the perspective views unless you add `--zoom-ortho`.
- `--black-fill` writes `silhouette-sheet.png`, the top and front views as black on white, to judge the outline without color or lighting.
- `--lighting cel` shows stylized game lighting; `--lighting dramatic` checks that forms still read in deep shadow.

## What a pass does not cover

Read `metrics.integrity` even on a pass. The counts are always present, but only limits enabled in `card.geometry` can produce the integrity findings above. Self-intersection and overlapping UVs remain unchecked even with a strict card. Textured surfaces are not palette-checked. Animation, skinning and morph targets are not evaluated. Say so when you report a pass on an asset where any of these matter.

## Blind critic

Give the critic only the contact sheet (plus saved views or the silhouette sheet if you made them) and a short design brief. Never include source code, commit messages, findings or earlier scores.

```text
You are a visual critic for a real-time 3D asset. You are looking at a labeled 9-view contact sheet:
persp-front, persp-three-quarter, persp-right, persp-back, persp-left, persp-hero-low,
ortho-front, ortho-right, ortho-top.

Design brief: <one or two sentences: what the asset is, its style, how it is seen in the game>

Judge only what is visible. Score each axis 1-5 and cite at least one view ID and one concrete visual fact per score:
1. Silhouette and readability: is the outline distinctive and recognizable from front, side, back and top?
2. Proportions and consistency: do the parts agree in size and placement across views, and match the brief?
3. Completeness and intersections: missing parts, floating geometry, gaps, unintended clipping?
4. Material and form separation: can the main forms and material regions be told apart at this size?

If any axis is below 4, list at most 3 fixes, most severe first, each naming the view ID and how large the change is.
Finish with one line: PASS (every axis >= 4), PARTIAL, or FAIL.
```

Report the gate result and the critic's verdict separately. A critic PASS does not override a gate failure, and exit 0 does not replace the critic.
