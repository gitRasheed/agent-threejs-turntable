import fs from 'node:fs';
import path from 'node:path';
import type { AssetBrowserInput, FactoryModule } from './assetBrowser.js';
import { inspectGlbSource } from './glbHeader.js';
import {
  bundleBrowserEntry,
  DEFAULT_TIMEOUT_MS,
  validateTimeout,
  WEBGL_SWIFTSHADER_FLAGS,
  withHarnessPage,
  withTimeout,
} from './harness.js';
import type { AssetMetrics, CaptureSettings, GlbSourceInfo, StyleCard, ViewMetrics } from './types.js';

export { DEFAULT_TIMEOUT_MS };

export const DEFAULT_CAPTURE: CaptureSettings = {
  tileWidth: 420,
  tileHeight: 315,
  zoom: 1,
  zoomOrtho: false,
  lighting: 'studio',
};

export interface BrowserSessionOptions {
  readonly assetPath: string;
  readonly card: StyleCard | null;
  readonly renderSheet: boolean;
  readonly timeoutMs?: number;
  readonly contactSheetPath?: string;
  readonly capture?: CaptureSettings;
  /** Directory for one PNG per view (`<view-id>.png`); omit to skip. */
  readonly viewsDir?: string;
  /** Black-on-white ortho-top and ortho-front mask sheet; omit to skip. */
  readonly silhouetteSheetPath?: string;
}

export interface BrowserSessionResult {
  readonly metrics: AssetMetrics;
  readonly views: readonly ViewMetrics[];
  readonly consoleErrors: readonly string[];
  readonly viewPaths: readonly string[];
}

function decodePng(dataUrl: string | null | undefined, what: string): Buffer {
  const prefix = 'data:image/png;base64,';
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith(prefix)) {
    throw new Error(`Browser harness did not return a valid ${what} PNG`);
  }
  return Buffer.from(dataUrl.slice(prefix.length), 'base64');
}

export async function runAssetSession(options: BrowserSessionOptions): Promise<BrowserSessionResult> {
  const absAsset = path.resolve(options.assetPath);
  if (!fs.existsSync(absAsset) || !fs.statSync(absAsset).isFile()) {
    throw new Error(`Asset file not found: ${absAsset}`);
  }
  if (path.extname(absAsset).toLowerCase() === '.gltf') {
    throw new Error('Unsupported .gltf input. Supply a binary .glb or a Three.js factory module.');
  }
  const timeoutMs = validateTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const capture = options.capture ?? DEFAULT_CAPTURE;
  const isGlb = absAsset.toLowerCase().endsWith('.glb');
  const glbSource: GlbSourceInfo | null = isGlb ? inspectGlbSource(absAsset) : null;
  const files = new Map<string, { type: string; body: Buffer }>();
  if (isGlb) files.set('/asset.glb', { type: 'model/gltf-binary', body: fs.readFileSync(absAsset) });

  const jsBundle = await bundleBrowserEntry('assetBrowser', isGlb ? undefined : absAsset);

  return withHarnessPage({ jsBundle, files, args: WEBGL_SWIFTSHADER_FLAGS, timeoutMs }, async (h) => {
    const execution = h.page.evaluate(async ({ harnessUrl, ...input }) => {
      const entry: typeof import('./assetBrowser.js') & { factory?: FactoryModule } = await import(harnessUrl);
      return entry.run(input, entry.factory);
    }, {
      harnessUrl: `${h.baseUrl}/harness.js`,
      inputKind: isGlb ? 'glb' : 'factory',
      glbUrl: `${h.baseUrl}/asset.glb`,
      glbSource,
      card: options.card,
      renderSheet: options.renderSheet,
      capture: {
        ...capture,
        saveViews: options.viewsDir !== undefined,
        blackFill: options.silhouetteSheetPath !== undefined,
      },
    } satisfies AssetBrowserInput & { harnessUrl: string });
    const payload = await withTimeout(execution, timeoutMs);

    if (h.pageErrors.length > 0) {
      throw new Error(`Browser page errors: ${h.pageErrors.join('; ')}`);
    }

    if (options.renderSheet && options.contactSheetPath !== undefined) {
      const pngBytes = decodePng(payload.sheetDataUrl, 'contact sheet');
      fs.mkdirSync(path.dirname(path.resolve(options.contactSheetPath)), { recursive: true });
      fs.writeFileSync(options.contactSheetPath, pngBytes);
    }

    if (options.renderSheet && options.silhouetteSheetPath !== undefined) {
      const pngBytes = decodePng(payload.silhouetteDataUrl, 'silhouette sheet');
      fs.mkdirSync(path.dirname(path.resolve(options.silhouetteSheetPath)), { recursive: true });
      fs.writeFileSync(options.silhouetteSheetPath, pngBytes);
    }

    const viewPaths: string[] = [];
    if (options.renderSheet && options.viewsDir !== undefined) {
      fs.mkdirSync(path.resolve(options.viewsDir), { recursive: true });
      for (const image of payload.viewImages) {
        const viewPath = path.join(path.resolve(options.viewsDir), `${image.id}.png`);
        fs.writeFileSync(viewPath, decodePng(image.dataUrl, `view ${image.id}`));
        viewPaths.push(viewPath);
      }
    }

    return {
      metrics: payload.metrics,
      views: payload.views,
      consoleErrors: [...h.consoleErrors],
      viewPaths,
    };
  });
}

export interface LabeledPng {
  readonly label: string;
  readonly png: Buffer;
}

/** Stacks PNGs of equal width into one image, each under a label bar. */
export async function stackLabeledPngs(images: readonly LabeledPng[], outPath: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
  const files = new Map(images.map((img, i) => [`/${i}.png`, { type: 'image/png', body: img.png }]));
  const dataUrl = await withHarnessPage({ jsBundle: '', files, args: [], timeoutMs }, async (h) => {
    const execution = h.page.evaluate(async ({ baseUrl, labels }) => {
      const bitmaps = await Promise.all(labels.map(async (_, i) => {
        const resp = await fetch(`${baseUrl}/${i}.png`);
        return createImageBitmap(await resp.blob());
      }));
      const labelH = 26;
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(...bitmaps.map((b) => b.width));
      canvas.height = bitmaps.reduce((sum, b) => sum + labelH + b.height, 0);
      const ctx = canvas.getContext('2d');
      if (ctx === null) throw new Error('2D canvas unavailable');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.font = 'bold 14px monospace';
      ctx.textAlign = 'left';
      let y = 0;
      bitmaps.forEach((bitmap, i) => {
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, y, canvas.width, labelH);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(labels[i] ?? '', 10, y + 18);
        ctx.drawImage(bitmap, 0, y + labelH);
        y += labelH + bitmap.height;
      });
      return canvas.toDataURL('image/png');
    }, { baseUrl: h.baseUrl, labels: images.map((img) => img.label) });
    return withTimeout(execution, timeoutMs, 'Mask composition');
  });
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, decodePng(dataUrl, 'black-fill masks'));
}
