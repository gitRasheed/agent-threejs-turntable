# Asset, harness and batch lifecycles

This document covers resource ownership, deadlines and files a caller can observe after a retry. Color math and gate evaluation operate on values. The GPU probe shares the harness and classifies its two backend results separately.

| Machine | State and owner | Evidence |
| --- | --- | --- |
| Browser asset session | One ordered sequence per asset. The browser owns the scene and render buffers, and Node owns the output files. | Checked with the GLB/factory parity test in `tests/assetSession.test.ts` and the two packed turntables in `scripts/smoke-pack.sh`. |
| Harness | A listening server can exist before the browser. An open page requires both. The caller owns the operation that runs on the page. | Checked with never-resolving factory and import cases in `tests/audit.test.ts`. |
| Batch | One asset runs at a time. Each row records either a completed report or an execution error. Files from earlier runs can survive independently of the row. | Checked with mixed gate results and a throwing factory in `tests/features.test.ts`. |

## Browser session

| From | Trigger | To and effect | Source |
| --- | --- | --- | --- |
| Input | Node finds the file, checks the timeout and inspects a GLB header | Bundle ready, or an input error before Chromium starts | `runAssetSession` (src/browserRuntime.ts) |
| Page ready | Import the bundled module and parse the GLB or await the factory | Scene ready when the root is a Three.js object | `run` (src/browserRuntime.ts) |
| Scene ready | Inspect the root, then render if requested | Metrics and, for a turntable, views and PNG data | `inspectRoot` (src/browserRuntime.ts) |
| Evaluating | Execution rejects, hits its deadline or returns with a recorded page error | Reject the session and start harness teardown | `runAssetSession` (src/browserRuntime.ts) |
| Payload ready | Node decodes and writes the requested images | Return metrics and view paths. The CLI evaluates the gates and writes the report | `decodePng` (src/browserRuntime.ts), `turntableReport` (src/cli.ts) |

The gate verdict comes after rendering. Both a passing asset and an over-budget asset can have a complete sheet. Image writes happen in sequence, so a filesystem error after the first write can leave a partial set.

## Harness

| From | Trigger | To and effect | Source |
| --- | --- | --- | --- |
| Idle | Listen on an ephemeral loopback port | Listening, with the bundle and input bytes available | `withHarnessPage` (src/harness.ts) |
| Listening | Launch Chromium and create a page | Attach diagnostic listeners, navigate to the origin, then call the session | `withHarnessPage` (src/harness.ts) |
| Evaluating | The operation settles or the timer expires | Clear the timer. The caller resumes with a value or exception | `withTimeout` (src/harness.ts) |
| Returning or throwing | Enter the cleanup block | Await browser closure if acquired, then request server closure | `withHarnessPage` (src/harness.ts) |

Navigation and page execution each have a deadline. Bundling and browser launch sit outside the execution timer. A timeout rejects the Node promise. Closing the browser ends the outstanding page work. If `browser.close()` itself rejects in `withHarnessPage`, execution skips `server.close()`. That path is untested.

## Batch

| From | Trigger | To and effect | Source |
| --- | --- | --- | --- |
| New | Validate the card and timeout, then enumerate and sort supported files | Reject empty input, duplicate output names or a summary path that would overwrite an input before the first render | `listBatchAssets` (src/cli.ts), `runBatch` (src/cli.ts) |
| Next asset | Turntable returns a report | Append its measurements, report path and exit code | `runBatch` (src/cli.ts) |
| Next asset | Turntable throws | Append an error row with exit 2 and a null report path, then continue | `runBatch` (src/cli.ts) |
| Rows complete | Black-fill requested and sheets available | Compose the masks for completed reports | `runBatch` (src/cli.ts) |
| Ready to summarize | Write both summaries | Print the JSON and table, then return the highest row exit code | `runBatch` (src/cli.ts) |

**Confirmed input collision, fixed.** A run that used `out/summary.json` as its card replaced the card on exit 0. Both summary paths now go through the existing input guard before rendering. The regression checks that each card retains its contents and the renderer creates no asset directory. See `tests/publication.test.ts`.

**Confirmed retry behavior.** A successful one-box batch followed by a run with a truncated GLB in the same output directory returned exit 2 and a null row report path. The previous report remained byte-for-byte identical. Read report paths from the current summary. Use a fresh output directory when inspecting artifacts directly. If finalization itself fails, the CLI exits 2 and an older summary may still be present. In `runBatch`, the per-asset catch ends before mask composition and summary writes.
