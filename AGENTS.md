# Working on agent-3d

## Module boundaries

- Keep CLI parsing, exit codes and report files in `src/cli.ts`. Put installation of the packaged skill in `src/installSkill.ts`.
- Read GLB container metadata in `src/glbHeader.ts`. In `src/browserRuntime.ts`, load the scene, measure geometry and produce images. Use the shared Three.js instance when bundling a factory.
- Let `src/harness.ts` own Chromium, its page and the loopback server. The asset runner and GPU probe use this harness for each session.
- Keep `src/evaluate.ts` and `src/color.ts` independent of the filesystem, browser and renderer. Define report shapes in `src/types.ts` and export the public library through `src/index.ts`.

## Invariants

- Gate the geometry that Three.js draws. Keep vertex transforms, visibility, instance counts and color conversion consistent across factory and GLB inputs.
- Derive CLI and batch outcomes from the same findings. A completed asset can fail a card and still produce a contact sheet. Batch records a row for each input and returns the highest asset exit code.
- Keep the GPU probe's backend and pixel checks separate from the WebGL turntable gates.
- Ship the skill and examples with the package. The two cards exercise the inclusive triangle budget on the same licensed asset.

## Verification

Use Node 20.19+ on the 20.x line or Node 22.13+ on the 22.x line for development. Run `npm ci` and `npx playwright install chromium` before the first check.

- Run `npm run check` for strict lint, TypeScript compilation and tests against Chromium.
- Run `bash scripts/smoke-pack.sh` after changes to the CLI, examples, skill, package manifest or browser bundle. It exercises the installed tarball from a temporary directory.
- Update `STATE_MACHINES.md` when resource ownership, timeout handling or the batch lifecycle changes.
