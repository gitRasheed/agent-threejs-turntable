# Asset, harness and batch lifecycles

Audited 2026-11-25 against the standalone checkout based on `a4f55c2` and the changes in this commit. The scope covers resource ownership, deadlines and files a caller can observe after a retry. Color math and gate evaluation operate on values. The GPU probe shares the harness and classifies its two backend results separately.

| Machine | State and owner | Evidence |
| --- | --- | --- |
| Browser asset session | One ordered sequence per asset. The browser owns the scene and render buffers, and Node owns the output files. | Checked with the GLB/factory parity test in `tests/agent3d.test.ts:188` and the two packed turntables in `scripts/smoke-pack.sh`. |
| Harness | A listening server can exist before the browser. An open page requires both. The caller owns the operation that runs on the page. | Checked with never-resolving factory and import cases in `tests/audit.test.ts:70` and `tests/audit.test.ts:77`. |
| Batch | One asset runs at a time. Each row records either a completed report or an execution error. Files from earlier runs can survive independently of the row. | Checked with mixed gate results and a throwing factory in `tests/features.test.ts:491` and `tests/features.test.ts:537`. |

## Browser session

| From | Trigger | To and effect | Source |
| --- | --- | --- | --- |
| Input | Node finds the file, checks the timeout and inspects a GLB header | Bundle ready, or an input error before Chromium starts | `src/browserRuntime.ts:1027` |
| Page ready | Import the bundled module and parse the GLB or await the factory | Scene ready when the root is a Three.js object | `src/browserRuntime.ts:975` |
| Scene ready | Inspect the root, then render if requested | Metrics and, for a turntable, views and PNG data | `src/browserRuntime.ts:996` |
| Evaluating | Execution rejects, hits its deadline or returns with a recorded page error | Reject the session and start harness teardown | `src/browserRuntime.ts:1070` |
| Payload ready | Node decodes and writes the requested images | Return metrics and view paths. The CLI evaluates the gates and writes the report | `src/browserRuntime.ts:1077`, `src/cli.ts:446` |

The gate verdict comes after rendering. Both a passing asset and an over-budget asset can have a complete sheet. Image writes happen in sequence, so a filesystem error after the first write can leave a partial set.

## Harness

| From | Trigger | To and effect | Source |
| --- | --- | --- | --- |
| Idle | Listen on an ephemeral loopback port | Listening, with the bundle and input bytes available | `src/harness.ts:119` |
| Listening | Launch Chromium and create a page | Attach diagnostic listeners, navigate to the origin, then call the session | `src/harness.ts:129` |
| Evaluating | The operation settles or the timer expires | Clear the timer. The caller resumes with a value or exception | `src/harness.ts:66` |
| Returning or throwing | Enter the cleanup block | Await browser closure if acquired, then request server closure | `src/harness.ts:148` |

Navigation and page execution each have a deadline. Bundling and browser launch sit outside the execution timer. A timeout rejects the Node promise. Closing the browser ends the outstanding page work. One untested cleanup path remains: if `browser.close()` itself rejects, execution skips `server.close()` at `src/harness.ts:152`.

## Batch

| From | Trigger | To and effect | Source |
| --- | --- | --- | --- |
| New | Enumerate and sort supported files | Reject empty input, duplicate output names or a summary path that would overwrite an input before the first render | `src/cli.ts:466`, `src/cli.ts:526` |
| Next asset | Turntable returns a report | Append its measurements, report path and exit code | `src/cli.ts:537` |
| Next asset | Turntable throws | Append an error row with exit 2 and a null report path, then continue | `src/cli.ts:561` |
| Rows complete | Black-fill requested and sheets available | Compose the masks for completed reports | `src/cli.ts:591` |
| Ready to summarize | Write both summaries | Print the JSON and table, then return the highest row exit code | `src/cli.ts:610` |

**Confirmed input collision, fixed.** A run that used `out/summary.json` as its card replaced the card on exit 0. Both summary paths now go through the existing input guard before rendering. The regression checks that each card retains its contents and the renderer creates no asset directory. See `tests/publication.test.ts:96`.

**Confirmed retry behavior.** A successful one-box batch followed by a run with a truncated GLB in the same output directory returned exit 2 and a null row report path. The previous report remained byte-for-byte identical. Read report paths from the current summary. Use a fresh output directory when inspecting artifacts directly. If finalization itself fails, the CLI exits 2 and an older summary may still be present. The per-asset catch ends at `src/cli.ts:579` and summary writes follow mask composition at `src/cli.ts:610`.
