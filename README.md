# agent-3d

A CI gate for 3D assets. Point it at a static `.glb` or at the Three.js module that builds your mesh. It loads the asset in headless Chromium, measures it, checks it against a JSON style card, and renders a labeled 3×3 contact sheet. Asset commands exit 0 for a pass, 1 for a gate failure and 2 for an input or execution error, and print a JSON report with one finding per failure.

MIT licensed. Needs Node.js 20 or later.

## When to use it

| Job | Tool |
| --- | --- |
| Build or repair a model interactively | [Blender MCP](https://github.com/ahujasid/mcp-for-blender) |
| Inspect, optimize or compress a glTF file | [glTF Transform](https://gltf-transform.dev/cli) |
| Fail an unattended build when an asset breaks the project's rules, and keep rendered evidence of why | agent-3d |

Both of those tools overlap with parts of this one, and you should reach for them first for their own jobs. agent-3d covers what is left:

- **It runs the code you ship.** A factory module is bundled and executed in a real browser against Three.js, so a shader that fails to compile or link fails the gate, and so does a view that renders empty or as one flat color. A static GLB goes through the same path.
- **The rules are a file in your repo.** One style card holds the budgets, palette, pivot and proportion limits for a whole set of assets, and every asset is judged against it the same way.
- **The verdict is machine-readable.** Each run returns an exit code and a finding ID with the measured value and the limit, and leaves a contact sheet to attach to the build.

These gates run without a card. View checks run when you render a turntable.

| Area | Gates |
| --- | --- |
| Mesh | Empty geometry, degenerate triangles |
| Each rendered view | Subject visible, inside the tile, not one flat color, winding not inverted |
| Runtime | Browser console errors, which include shader compile and link errors |

A card adds the project's own limits:

| Area | Gates |
| --- | --- |
| Budgets | Triangles, materials, textures, GLB bytes, triangle-list primitives |
| Mesh integrity | Open and non-manifold edges, inconsistent winding, invalid normals and missing UVs on textured geometry |
| Palette | Every authored color within a CIE76 distance of a named role |
| Pivot | Origin at the center of the bounds, or on the ground plane |
| Proportions | Length to width, height to length, mirror symmetry, ground contact and footprint |

## What a pass does not tell you

- **Mesh integrity gates are opt-in.** A cube missing one face reports four open boundary edges in `metrics.integrity`. It can still pass unless the card limits open edges. Even a strict card leaves self-intersection and overlapping UVs unchecked.
- **The rendered winding check is a heuristic.** It fires when backface culling hides more than half of the nearest front-sided surface in a view. To catch a single flipped triangle along a shared edge, enable `requireConsistentWinding`. A uniformly reversed closed shell still has consistent winding.
- **Textured surfaces are not palette-checked.** A mesh colored by a texture, or by a shader with no recognized color uniform, gets an info finding and is left for visual review.
- **Role separation compares the card with itself.** `separationRoles` measures the distance between two palette entries in the card. It does not measure colors on the asset.
- **Nothing here judges how the asset looks.** Silhouette, readability and whether the proportions feel right need a reviewer looking at the sheet. The package ships a critic prompt for that in its [agent skill](skills/agent-3d/SKILL.md); it does not call a model.
- **Assets are measured as stored.** Animations are never played, and the measurements ignore skinning and morph targets.

## Install

```bash
npm install --save-dev agent-3d
npx playwright install --only-shell chromium
```

**Browser footprint.** Every asset command launches a browser, `check` included. `check`, `turntable` and `batch` need only Playwright's Chromium headless shell, which takes 282 MiB on disk on Linux x64 (Playwright 1.65.1, Chrome 159). The npm packages add about 53 MB. Omitting `--only-shell` also installs full Chromium, which takes another 414 MiB on disk on the same platform. Install it if you run `gpu-probe --browser chromium --headed`. On a bare Linux CI image, add `--with-deps` to install the system libraries. Rendering is software WebGL through SwiftShader, which ships inside the browser, so no GPU or display is needed.

**Three.js version.** `three@^0.187.0` is a peer dependency. npm installs it for you when the project has no `three`. In a project pinned to another `three`, the install fails with `ERESOLVE`. Give the tool its own manifest:

```bash
mkdir -p tools/asset-qa && cd tools/asset-qa
npm init -y && npm install agent-3d
npx playwright install --only-shell chromium
```

Then run `tools/asset-qa/node_modules/.bin/agent-3d` from the project root. Either way, a factory runs against the `three` that agent-3d resolves, because every `three` import in the bundle is aliased to that one copy. With a separate manifest, that copy is a 0.187 release and not the version your game ships.

**GLB support.** Input must be a binary `.glb` that is self-contained and static.

- `.gltf` is rejected with exit 2.
- A GLB that requires `KHR_draco_mesh_compression`, `EXT_meshopt_compression` or `KHR_texture_basisu` is rejected with exit 2 and a message that names the extension. Re-export it without mesh compression and with PNG or JPEG textures.
- Only the default scene is loaded.

## Quickstart

The package bundles a 12-triangle box and two cards. `pass-card.json` allows 12 triangles and `fail-card.json` allows 11.

```bash
ex=node_modules/agent-3d/examples
npx agent-3d turntable $ex/BoxVertexColors.glb --card $ex/pass-card.json --out out/pass   # exit 0
npx agent-3d turntable $ex/BoxVertexColors.glb --card $ex/fail-card.json --out out/fail   # exit 1
```

Each run takes under a second on a 16-core desktop and writes `contact-sheet.png` and `report.json` to its output directory. The same report goes to stdout. The failing run's report contains:

```json
"findings": [
  {
    "id": "TRIANGLES_OVER_BUDGET",
    "severity": "fail",
    "message": "Visible triangles (12) exceed budget (11)",
    "actual": 12,
    "limit": 11
  }
]
```

Open `out/pass/contact-sheet.png` to see the nine views. The box is CC0; its source is in [BoxVertexColors.LICENSE.txt](examples/BoxVertexColors.LICENSE.txt).

## Agent skill

```bash
npx agent-3d skill install --project
```

This copies the packaged [SKILL.md](skills/agent-3d/SKILL.md) to `.agents/skills/agent-3d/` and `.claude/skills/agent-3d/` in the current directory, where coding agents discover it. Without `--project`, both copies go under your home directory. The skill covers the gate, inspect and blind-critic loop.

Running it again is safe when the copies are identical. If either destination holds a different `SKILL.md`, the command exits 2 and writes nothing. After you upgrade agent-3d or edit a copy, move the old copies aside and install again.

## In CI

```yaml
- run: npm ci
- run: npx playwright install --with-deps --only-shell chromium
- run: npx agent-3d batch assets/ships --card assets/ships.card.json --out artifacts/agent-3d
- uses: actions/upload-artifact@v4
  if: always()
  with:
    name: agent-3d
    path: artifacts/agent-3d
```

`batch` exits with the worst result in the directory, and the uploaded folder holds a contact sheet and a report for every asset.

## Commands

```bash
agent-3d check <asset> [--card card.json] [--out report.json]
agent-3d turntable <asset> --out <dir> [--card card.json] [capture options]
agent-3d batch <dir> --out <dir> [--card card.json] [capture options]
agent-3d gpu-probe [--out <dir>] [--browser chrome|chromium] [--headed]
agent-3d skill install [--project]
```

`<asset>` is a `.glb` or a factory module (`.ts`, `.mts`, `.js`, `.mjs`). The first four commands accept `--timeout <ms>` (default 30000), which also bounds factory loading.

**check** measures geometry and authored colors without rendering. It reports triangle, material and texture counts, degenerate triangles, world bounds, shape (length, width, height, mirror symmetry, ground offset and footprint) and every sampled color with its nearest palette role.

**turntable** runs the same checks, then renders nine views (`persp-front`, `persp-three-quarter`, `persp-right`, `persp-back`, `persp-left`, `persp-hero-low`, `ortho-front`, `ortho-right`, `ortho-top`) into `<dir>/contact-sheet.png` and writes `<dir>/report.json`. Each view is gated: the subject must cover at least 1% of the tile, must not touch the tile edge, must not be a single flat color, and backface culling must not hide more than half of the nearest `FrontSide` surface.

Capture options for `turntable` and `batch`:

| Flag | Default | Effect |
| --- | --- | --- |
| `--tile-size <WxH>` | `420x315` | Pixel size of each view, 64 to 2048 per side. Use `840x630` to inspect seams and glints. |
| `--zoom <factor>` | `1` | Camera zoom for the perspective views, 0.25 to 8. Above 1, edge clipping in a zoomed view is reported as info, and so is a flat tile the subject fills completely. Ortho views stay at zoom 1, so their silhouettes are never clipped. |
| `--zoom-ortho` | off | Apply `--zoom` to the ortho views as well. |
| `--lighting <preset>` | `studio` | `studio`: soft key, rim and sky fill with ACES tone mapping. `cel`: hard warm key, cool rim and a violet sky fill with no tone mapping, close to how stylized toon games light their models. `dramatic`: low raking key, faint rim, deep shadows. Presets change lights and tone mapping only. |
| `--save-views` | off | Also write `<view-id>.png` for each view next to the contact sheet. |
| `--black-fill` | off | Also write `silhouette-sheet.png`: `ortho-top` and `ortho-front` as black silhouettes on white, taken from the same mask that measures coverage, so every visible mesh counts, glow and additive plume meshes included. `batch` stacks every asset's sheet into `<out>/black-fill-masks.png`. |
| `--no-fail-on-console-error` | off | Report browser console errors as a warning instead of failing. |

**Console errors.** Both `check` and `turntable` capture `console.error` output from the page, including Three.js shader compile and link errors. Any console error fails the run with a `CONSOLE_ERROR` finding that quotes the first message; all messages (up to 20, truncated) are in `consoleErrors`. `--fail-on-console-error` states the default explicitly. Shader errors only show up in `turntable`, because `check` never renders.

**batch** runs `turntable` on every `.glb`, `.ts`, `.mts`, `.js` and `.mjs` file in a directory (not recursive, `.d.ts` skipped, sorted by name) with one card and one set of capture options. Each asset gets `<out>/<name>/contact-sheet.png` and `report.json`. A crash or timeout on one asset becomes an error row and the batch continues. It prints one compact JSON summary to stdout, a table to stderr, and writes both to `<out>/summary.json` and `<out>/summary.txt`:

```text
asset    tris  degen  palette           scored  shader  unscored  samples  maxΔE76  result
-------  ----  -----  ----------------  ------  ------  --------  -------  -------  ------
crate    12    0      assessed          1       0       0         1        0.00     PASS
lantern  944   0      partial_textured  9       6       2         42       14.20    FAIL
lantern: PALETTE_DELTA_E_EXCEEDED
1/2 passed against card 'props'
```

`scored` counts meshes whose color was checked, `shader` how many of those were read from `ShaderMaterial` uniforms, and `unscored` the textured or colorless-shader meshes left for visual review.

The exit code is the worst per-asset code: 1 if any gate failed, 2 if any asset errored.

**gpu-probe** checks whether headless Chrome can render through WebGPU on this machine. It renders the same lit scene with `WebGPURenderer` and `WebGLRenderer`, flushes the GPU queue and waits two frames before reading pixels, and writes `probe.json`, `REPORT.md`, `webgpu.png` and `webgl.png` to `--out`. It launches the installed Google Chrome by default (`--browser chromium` uses Playwright's build) with the SwiftShader flag set:

```text
--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --enable-unsafe-webgpu
--enable-features=Vulkan --use-vulkan=swiftshader --use-webgpu-adapter=swiftshader --ignore-gpu-blocklist
```

Do not add `--disable-vulkan-surface`; it blanks compositor screenshots. Exit codes: 0 WebGPU rendered at least 50 unique colors, 1 WebGPU backend but a blank capture, 2 launch error, 3 three.js silently fell back to WebGL, 4 WebGL failed too. The turntable itself always uses WebGL; treat the probe as a separate smoke job.

## Style card

```json
{
  "id": "lowpoly-starships",
  "frontAxis": "-Z",
  "topUpAxis": "-Z",
  "pivot": "center",
  "pivotToleranceFraction": 0.1,
  "palette": { "hull": "#dfd9cc", "accent": "#e88332", "ink": "#070712" },
  "paletteDeltaE76Max": 8,
  "requirePaletteOnTextured": false,
  "shaderColorUniforms": ["uAlbedo", "uColor", "color"],
  "shaderEmissiveUniforms": ["uEmissive", "uEmissiveIntensity"],
  "separationMinDeltaE76": 12,
  "separationRoles": [["hull", "accent"]],
  "budgets": {
    "trisMax": 2000,
    "materialsMax": 12,
    "texturesMax": 4,
    "bytesMax": 200000,
    "degenerateTrianglesMax": 0,
    "requireTriangleLists": true
  },
  "geometry": {
    "requireWatertight": true,
    "requireValidNormals": true,
    "requireUvsOnTextured": true,
    "requireConsistentWinding": true,
    "groundContact": true,
    "groundToleranceFraction": 0.01,
    "groundFootprintMin": 0.25,
    "mirrorSymmetryMin": 0.95,
    "symmetryToleranceFraction": 0.01,
    "lengthToWidth": [1, 4],
    "heightToLength": [0.1, 0.6]
  }
}
```

Every key except `id` is optional. An unknown key is rejected with exit 2, so a typo cannot silently disable a gate.

- **Axes.** `frontAxis` is the direction the asset faces; it sets the front view and the length axis. `topUpAxis` is screen-up in the top view and cannot be ±Y.
- **Pivot.** `"center"` requires the center of the world bounds to sit at the origin. `"ground"` requires the lowest point to sit on y=0. Both allow `pivotToleranceFraction` (default 0.05) of the largest extent.
- **Palette.** For each untextured material the checker adds emissive color times intensity to the linear base color (after vertex and instance tinting), clamps to the sRGB gamut, and takes the CIE76 distance to the nearest role. The worst sample must stay within `paletteDeltaE76Max`. A `ShaderMaterial` is scored from its uniforms: the first of `shaderColorUniforms` (default `uAlbedo`, `uColor`, `color`) that holds a `Color` or `Vector3` is the base color, and `shaderEmissiveUniforms` (default `uEmissive`, `uEmissiveIntensity`) is added like emissive when present. Meshes colored by a texture, including a shader with a texture uniform, or by a shader with none of those uniforms, cannot be scored and are listed as info for visual review. `requirePaletteOnTextured: true` turns the textured case into an unsupported-gate exit 2. The report's `palette.colors` lists the 48 most-sampled colors with their nearest role, which is the quickest way to build or tune a palette.
- **Separation.** Each pair in `separationRoles` must be at least `separationMinDeltaE76` apart. The pair is two roles from this card's `palette`, so the gate catches a palette whose roles are too close to tell apart.
- **Geometry.** The report always includes shape measurements in `metrics.shape` and mesh integrity counts in `metrics.integrity`. Set the corresponding keys in `card.geometry` to make them gates. Ground contact needs the lowest point on y=0. The footprint is the x/z box of vertices within tolerance of the lowest point, divided by the full x/z box; a small value means the asset balances on a point or edge. Mirror symmetry is the share of vertices whose reflection across the width-axis mid-plane lands within tolerance of another vertex. Aspect ranges are inclusive `[min, max]`, with length measured along `frontAxis`.
- **Budgets.** `bytesMax` and `requireTriangleLists` apply only to GLB input and are listed as skipped for factories. Degenerate triangles fail at any count above `degenerateTrianglesMax` (default 0), with or without a card.

Integrity checks use the triangles drawn by each mesh across its active material groups. Edge counts join vertices at identical positions, so a UV seam alone does not open a boundary.

| Key in `card.geometry` | Failure condition | Finding ID |
| --- | --- | --- |
| `requireWatertight` | Any open or non-manifold edge. Sets both edge limits to zero even if the card specifies higher limits. | `OPEN_BOUNDARY_EDGES`, `NON_MANIFOLD_EDGES` |
| `maxOpenBoundaryEdges` | Edges used by exactly one triangle exceed the limit. | `OPEN_BOUNDARY_EDGES` |
| `maxNonManifoldEdges` | Edges used by more than two triangles exceed the limit. | `NON_MANIFOLD_EDGES` |
| `requireValidNormals` | A referenced vertex has no normal, a zero-length normal, or a normal whose length is nonfinite or differs from 1 by more than 0.001. | `MISSING_NORMALS`, `ZERO_LENGTH_NORMALS`, `UNNORMALIZED_NORMALS` |
| `requireUvsOnTextured` | A vertex lacks a finite UV pair on a channel used by its material's texture maps. | `MISSING_UVS` |
| `requireConsistentWinding` | Two triangles traverse a shared edge in the same direction. | `INCONSISTENT_WINDING` |

Bounds come from the vertices Three.js actually draws, after node transforms and accessor dequantization, so quantized GLBs (`KHR_mesh_quantization`, normalized integer positions) report real-world bounds. A test pins this against `getBounds()` from `@gltf-transform/core`.

## Factory modules

A factory is a browser-compatible module that exports `buildAsset(THREE)` (or a default function) returning a `THREE.Object3D` or a promise of one. The CLI bundles it with esbuild against one shared copy of `three`, so a factory may import project code that imports `three`. Its `console.error` calls count as console errors.

```js
export function buildAsset(THREE) {
  return new THREE.Mesh(new THREE.BoxGeometry(1, 0.5, 2), new THREE.MeshStandardMaterial({ color: 0xe88332 }));
}
```

The factory executes in the headless browser on your machine, so run only modules you trust.

## Library use

```ts
import { runAssetSession, evaluateAssetGates } from 'agent-3d';

const session = await runAssetSession({ assetPath: 'ship.glb', card: null, renderSheet: false });
const { ok, findings } = evaluateAssetGates(session.metrics, null, undefined, { consoleErrors: session.consoleErrors });
```

## Development

```bash
npm ci
npx playwright install --only-shell chromium
npm run check
bash scripts/smoke-pack.sh
```

`npm run check` lints, type-checks and runs the CLI and Chromium regression suite. The smoke test packs the CLI, installs it in a temporary consumer and renders both quickstart cards.
