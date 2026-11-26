import * as THREE_GPU from 'three/webgpu';
import * as THREE from 'three';
import type { GpuProbeBackendResult } from './gpuProbe.js';

export interface RawBackend extends GpuProbeBackendResult {
  readonly dataUrl: string | null;
}

interface RawProbe {
  navigatorGpu: boolean;
  adapter: Record<string, string> | null;
  webgpu: RawBackend;
  webgl: RawBackend;
}

const SIZE = 256;
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

function buildScene() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x141826);
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(0, 0.6, 4.2);
  camera.lookAt(0, 0, 0);
  const knot = new THREE.Mesh(
    new THREE.TorusKnotGeometry(0.9, 0.3, 160, 24),
    new THREE.MeshStandardMaterial({ color: 0xe88332, roughness: 0.45, metalness: 0.1 }),
  );
  knot.rotation.set(0.4, 0.6, 0);
  scene.add(knot);
  const key = new THREE.DirectionalLight(0xfff1dc, 2.4);
  key.position.set(3, 4, 2);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x6b88ff, 1.4);
  rim.position.set(-3, 1, -3);
  scene.add(rim);
  scene.add(new THREE.HemisphereLight(0xaab8e0, 0x242038, 0.6));
  return { scene, camera };
}

async function countColors(dataUrl: string) {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, c.width, c.height).data;
  const colors = new Uint32Array(px.buffer, px.byteOffset, px.length / 4);
  return new Set(colors).size;
}

function newCanvas() {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  document.body.appendChild(canvas);
  return canvas;
}

export async function probe(): Promise<RawProbe> {
  let adapterInfo: RawProbe['adapter'] = null;
  let webgpu: RawBackend;
  let webgl: RawBackend;

  if (navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        const info = adapter.info;
        adapterInfo = {
          vendor: String(info.vendor || ''),
          architecture: String(info.architecture || ''),
          device: String(info.device || ''),
          description: String(info.description || ''),
        };
      }
    } catch (err) {
      adapterInfo = { error: err instanceof Error ? err.message : String(err) };
    }
  }

  try {
    const canvas = newCanvas();
    const renderer = new THREE_GPU.WebGPURenderer({ canvas, antialias: false });
    renderer.setPixelRatio(1);
    renderer.setSize(SIZE, SIZE, false);
    await renderer.init();
    const backend = renderer.backend instanceof THREE_GPU.WebGPUBackend ? 'WebGPUBackend'
      : renderer.backend instanceof THREE_GPU.WebGLBackend ? 'WebGLBackend' : String(renderer.backend.constructor.name);
    const { scene, camera } = buildScene();
    // Default framebuffer, then wait for the GPU queue and two frames before reading pixels back.
    renderer.render(scene, camera);
    if ('device' in renderer.backend && renderer.backend.device instanceof GPUDevice) {
      await renderer.backend.device.queue.onSubmittedWorkDone();
    }
    await nextFrame();
    await nextFrame();
    const dataUrl = canvas.toDataURL('image/png');
    webgpu = { backend, uniqueColors: await countColors(dataUrl), error: null, dataUrl };
    renderer.dispose();
  } catch (err) {
    webgpu = { backend: null, uniqueColors: 0, error: err instanceof Error ? err.message : String(err), dataUrl: null };
  }

  try {
    const canvas = newCanvas();
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setSize(SIZE, SIZE, false);
    const { scene, camera } = buildScene();
    renderer.render(scene, camera);
    const dataUrl = canvas.toDataURL('image/png');
    webgl = { backend: 'WebGLRenderer', uniqueColors: await countColors(dataUrl), error: null, dataUrl };
    renderer.dispose();
  } catch (err) {
    webgl = { backend: null, uniqueColors: 0, error: err instanceof Error ? err.message : String(err), dataUrl: null };
  }
  return { navigatorGpu: Boolean(navigator.gpu), adapter: adapterInfo, webgpu, webgl };
}
