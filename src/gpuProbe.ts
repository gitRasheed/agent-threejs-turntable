import fs from 'node:fs';
import path from 'node:path';
import type { RawBackend } from './probeBrowser.js';
import { bundleBrowserEntry, validateTimeout, WEBGPU_SWIFTSHADER_FLAGS, withHarnessPage, withTimeout } from './harness.js';

export const GPU_PROBE_MIN_COLORS = 50;

export interface GpuProbeOptions {
  /** 'chrome' drives the installed Google Chrome (Playwright channel), 'chromium' the bundled build. */
  readonly browser: 'chrome' | 'chromium';
  readonly headed: boolean;
  readonly timeoutMs: number;
  readonly outDir?: string;
}

export interface GpuProbeBackendResult {
  readonly backend: string | null;
  readonly uniqueColors: number;
  readonly error: string | null;
}

export interface GpuProbeResult {
  readonly schemaVersion: 'agent-threejs-turntable/gpu-probe/v1';
  readonly ok: boolean;
  readonly exitCode: 0 | 1 | 3 | 4;
  readonly verdict: 'webgpu-ok' | 'webgpu-blank' | 'webgl-fallback' | 'webgl-failed';
  readonly browser: string;
  readonly browserVersion: string | null;
  readonly flags: readonly string[];
  readonly navigatorGpu: boolean;
  readonly adapter: Readonly<Record<string, string>> | null;
  readonly webgpu: GpuProbeBackendResult;
  readonly webgl: GpuProbeBackendResult;
  readonly consoleErrors: readonly string[];
  readonly files: readonly string[];
}

export function classifyGpuProbe(
  webgpu: GpuProbeBackendResult,
  webgl: GpuProbeBackendResult,
): Pick<GpuProbeResult, 'exitCode' | 'verdict'> {
  if (webgpu.backend === 'WebGPUBackend') {
    return webgpu.uniqueColors >= GPU_PROBE_MIN_COLORS
      ? { exitCode: 0, verdict: 'webgpu-ok' }
      : { exitCode: 1, verdict: 'webgpu-blank' };
  }
  // A WebGL2 fallback canvas reads back transparent, so it is never graded as a WebGPU pass.
  return webgl.error === null && webgl.uniqueColors >= GPU_PROBE_MIN_COLORS
    ? { exitCode: 3, verdict: 'webgl-fallback' }
    : { exitCode: 4, verdict: 'webgl-failed' };
}

function stripImage({ backend, uniqueColors, error }: RawBackend): GpuProbeBackendResult {
  return { backend, uniqueColors, error };
}

function reportMarkdown(r: GpuProbeResult): string {
  const row = (name: string, b: GpuProbeBackendResult): string =>
    `| ${name} | ${b.backend ?? '-'} | ${b.uniqueColors} | ${b.error ?? ''} |`;
  return [
    '# agent-threejs-turntable gpu-probe',
    '',
    `Verdict: **${r.verdict}** (exit ${r.exitCode}). Browser: ${r.browser} ${r.browserVersion ?? ''}.`,
    '',
    `navigator.gpu: ${r.navigatorGpu}. Adapter: ${r.adapter === null ? 'none' : JSON.stringify(r.adapter)}.`,
    '',
    '| Renderer | Backend | Unique colours | Error |',
    '| --- | --- | ---: | --- |',
    row('WebGPURenderer', r.webgpu),
    row('WebGLRenderer', r.webgl),
    '',
    `Pass needs the WebGPU backend and at least ${GPU_PROBE_MIN_COLORS} unique colours.`,
    '',
    `Flags: \`${r.flags.join(' ')}\``,
    '',
    ...(r.consoleErrors.length > 0 ? ['Console errors:', '', ...r.consoleErrors.map((e) => `- ${e}`), ''] : []),
  ].join('\n');
}

export async function runGpuProbe(options: GpuProbeOptions): Promise<GpuProbeResult> {
  const timeoutMs = validateTimeout(options.timeoutMs);
  const jsBundle = await bundleBrowserEntry('probeBrowser');
  const flags = WEBGPU_SWIFTSHADER_FLAGS;
  return withHarnessPage(
    {
      jsBundle,
      args: flags,
      headless: !options.headed,
      timeoutMs,
      ...(options.browser === 'chrome' ? { channel: 'chrome' as const } : {}),
    },
    async (h) => {
      const raw = await withTimeout(
        h.page.evaluate(async (url) => {
          const entry: typeof import('./probeBrowser.js') = await import(url);
          return entry.probe();
        }, `${h.baseUrl}/harness.js`),
        timeoutMs,
        'GPU probe',
      );
      const webgpu = stripImage(raw.webgpu);
      const webgl = stripImage(raw.webgl);
      const files: string[] = [];
      if (options.outDir !== undefined) {
        const dir = path.resolve(options.outDir);
        fs.mkdirSync(dir, { recursive: true });
        for (const [name, b] of [['webgpu.png', raw.webgpu], ['webgl.png', raw.webgl]] as const) {
          if (b.dataUrl?.startsWith('data:image/png;base64,') === true) {
            const file = path.join(dir, name);
            fs.writeFileSync(file, Buffer.from(b.dataUrl.slice('data:image/png;base64,'.length), 'base64'));
            files.push(file);
          }
        }
        files.push(path.join(dir, 'probe.json'), path.join(dir, 'REPORT.md'));
      }
      const verdict = classifyGpuProbe(webgpu, webgl);
      const final: GpuProbeResult = {
        schemaVersion: 'agent-threejs-turntable/gpu-probe/v1',
        ok: verdict.exitCode === 0,
        ...verdict,
        browser: options.browser,
        browserVersion: h.page.context().browser()?.version() ?? null,
        flags,
        navigatorGpu: raw.navigatorGpu,
        adapter: raw.adapter,
        webgpu,
        webgl,
        consoleErrors: [...h.consoleErrors, ...h.pageErrors],
        files,
      };
      if (options.outDir !== undefined) {
        const dir = path.resolve(options.outDir);
        fs.writeFileSync(path.join(dir, 'probe.json'), `${JSON.stringify(final, null, 2)}\n`);
        fs.writeFileSync(path.join(dir, 'REPORT.md'), reportMarkdown(final));
      }
      return final;
    },
  );
}
