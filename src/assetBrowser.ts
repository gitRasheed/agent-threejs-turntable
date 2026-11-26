import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { deltaE76, hexSrgbToLinearRgb, linearRgbToLabD65, linearRgbToHexSrgb } from './color.js';
import { DEFAULT_SHADER_COLOR_UNIFORMS } from './evaluate.js';
import { EMPTY_INTEGRITY, inspectGeometryIntegrity, type TriangleBuffers } from './geometryIntegrity.js';
import type {
  AssetMetrics, AxisDirection, CaptureSettings, GlbSourceInfo, LightingPreset, PaletteAssessment,
  PaletteCornerViolation, ShapeMetrics, StyleCard, ViewMetrics,
} from './types.js';

interface BrowserCapture extends CaptureSettings {
  saveViews: boolean;
  blackFill: boolean;
}

export interface AssetBrowserInput {
  inputKind: AssetMetrics['inputKind'];
  glbUrl: string;
  glbSource: GlbSourceInfo | null;
  card: StyleCard | null;
  renderSheet: boolean;
  capture: BrowserCapture;
}

interface RenderedViews {
  views: ViewMetrics[];
  viewImages: { id: string; dataUrl: string }[];
  sheetDataUrl: string | null;
  silhouetteDataUrl: string | null;
}

interface AssetBrowserResult extends RenderedViews {
  metrics: AssetMetrics;
}

export interface FactoryModule {
  buildAsset?: (three: typeof THREE) => unknown;
  default?: (three: typeof THREE) => unknown;
}

type Drawable = THREE.Object3D & { material: THREE.Material | THREE.Material[] };

function hasMaterial(obj: THREE.Object3D): obj is Drawable {
  return 'material' in obj && Boolean(obj.material);
}

// Three.js also accepts objects created through its separate source-module entry points.
type ThreeKind = 'Object3D' | 'Mesh' | 'Line' | 'Group' | 'InstancedMesh' | 'InstancedBufferGeometry'
  | 'InterleavedBufferAttribute' | 'InstancedBufferAttribute' | 'InstancedInterleavedBuffer'
  | 'Texture' | 'ShaderMaterial' | 'Color' | 'Vector3';

function isThree<K extends ThreeKind>(value: unknown, kind: K): value is InstanceType<(typeof THREE)[K]> {
  return value !== null && typeof value === 'object' && Reflect.get(value, `is${kind}`) === true;
}

type Material = THREE.Material & Partial<Pick<THREE.MeshStandardMaterial, 'color' | 'map' | 'emissive' | 'emissiveIntensity' | 'emissiveMap'>> & {
  uniforms?: Record<string, { value: unknown }>;
};

interface Span {
  start: number;
  end: number;
  triCount: number;
  material: Material;
}

const MAX_REPORTED_COLORS = 48;
const MAX_SHAPE_POINTS = 60000;

function axisVec(name: AxisDirection | null | undefined, fallback: THREE.Vector3) {
  switch (name) {
    case '+X': return new THREE.Vector3(1, 0, 0);
    case '-X': return new THREE.Vector3(-1, 0, 0);
    case '+Y': return new THREE.Vector3(0, 1, 0);
    case '-Y': return new THREE.Vector3(0, -1, 0);
    case '+Z': return new THREE.Vector3(0, 0, 1);
    case '-Z': return new THREE.Vector3(0, 0, -1);
    default: return fallback.clone();
  }
}

function isObjectVisibleInHierarchy(obj: THREE.Object3D) {
  let cur: THREE.Object3D | null = obj;
  while (cur) {
    if (!cur.visible) return false;
    cur = cur.parent;
  }
  return true;
}

// Mirrors WebGLRenderer: InstancedMesh.count wins; otherwise instanceCount is clamped by the instanced
// attributes the shader reads, and an unclamped Infinity reaches GL as 0 instances.
function drawnInstances(mesh: THREE.Mesh, spans: Span[]) {
  if (isThree(mesh, 'InstancedMesh')) return mesh.count;
  const geo = mesh.geometry;
  if (!isThree(geo, 'InstancedBufferGeometry')) return 1;
  const read = new Set<string>();
  for (const { material } of spans) {
    if ('vertexShader' in material && typeof material.vertexShader === 'string') {
      for (const name of material.vertexShader.split(/[^A-Za-z0-9_]+/)) read.add(name);
    }
  }
  let max = Infinity;
  for (const [name, attr] of Object.entries(geo.attributes)) {
    const data = isThree(attr, 'InterleavedBufferAttribute') ? attr.data : attr;
    if (!isThree(data, 'InstancedBufferAttribute') && !isThree(data, 'InstancedInterleavedBuffer')) continue;
    if (!read.has(name)) continue;
    max = Math.min(max, data.meshPerAttribute * data.count);
  }
  const n = Math.min(geo.instanceCount, max);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

function activeSpansForMesh(mesh: THREE.Mesh): Span[] {
  const geo = mesh.geometry;
  const pos = geo.getAttribute('position');
  if (!pos) return [];
  const idx = geo.index;
  const total = idx ? idx.count : pos.count;
  const drStart = Math.max(0, geo.drawRange.start);
  const drEnd = Math.min(total, drStart + geo.drawRange.count);
  if (drEnd - drStart < 3) return [];

  const spans = [];
  if (Array.isArray(mesh.material)) {
    for (const g of geo.groups) {
      const start = Math.max(drStart, g.start);
      const end = Math.min(drEnd, g.start + g.count);
      if (end - start < 3) continue;
      if (g.materialIndex === undefined) continue;
      const mat = mesh.material[g.materialIndex];
      if (!mat || mat.visible === false) continue;
      const triCount = Math.floor((end - start) / 3);
      if (triCount <= 0) continue;
      spans.push({ start, end: start + triCount * 3, triCount, material: mat });
    }
    return spans;
  }

  const mat = mesh.material;
  if (!mat || mat.visible === false) return [];
  const triCount = Math.floor((drEnd - drStart) / 3);
  if (triCount <= 0) return [];
  spans.push({ start: drStart, end: drStart + triCount * 3, triCount, material: mat });
  return spans;
}

function collectTexturesFromUniformValue(val: unknown, outSet: Set<THREE.Texture>, seen: Set<object>) {
  if (!val || typeof val !== 'object' || seen.has(val)) return;
  if (isThree(val, 'Texture')) {
    outSet.add(val);
    return;
  }
  seen.add(val);
  if (Array.isArray(val)) {
    for (const item of val) {
      collectTexturesFromUniformValue(item, outSet, seen);
    }
    return;
  }
  if (Object.getPrototypeOf(val) === Object.prototype) {
    for (const nested of Object.values(val)) {
      collectTexturesFromUniformValue(nested, outSet, seen);
    }
  }
}

function collectMaterialTextures(mat: Material, outSet: Set<THREE.Texture>) {
  const uvChannels = new Set<number>();
  const textures = new Set<THREE.Texture>();
  for (const [name, val] of Object.entries(mat)) {
    if (isThree(val, 'Texture')) {
      textures.add(val);
      if (!isThree(mat, 'ShaderMaterial') && (name === 'map' || name.endsWith('Map')) && name !== 'envMap' && name !== 'gradientMap') {
        uvChannels.add(val.channel);
      }
    }
  }
  if (mat.uniforms && typeof mat.uniforms === 'object') {
    const seen = new Set<object>();
    for (const uniform of Object.values(mat.uniforms)) {
      if (uniform && typeof uniform === 'object' && 'value' in uniform) {
        collectTexturesFromUniformValue(uniform.value, textures, seen);
      }
    }
  }
  for (const texture of textures) outSet.add(texture);
  if (textures.size && isThree(mat, 'ShaderMaterial')) {
    const source = (mat.vertexShader + '\n' + mat.fragmentShader)
      .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ' ');
    for (const match of source.matchAll(/\buv([123]?)\b/g)) uvChannels.add(Number(match[1]));
  }
  return uvChannels;
}

function materialHasUniformTexture(mat: Material) {
  if (!mat.uniforms || typeof mat.uniforms !== 'object') return false;
  const found = new Set<THREE.Texture>();
  const seen = new Set<object>();
  for (const uniform of Object.values(mat.uniforms)) {
    if (uniform && typeof uniform === 'object' && 'value' in uniform) {
      collectTexturesFromUniformValue(uniform.value, found, seen);
      if (found.size > 0) return true;
    }
  }
  return false;
}

const DEFAULT_SHADER_EMISSIVE_UNIFORMS = ['uEmissive', 'uEmissiveIntensity'] as const;

// Uniform values are linear like Material.color; a Vector3 is read as linear rgb.
function uniformRgb(mat: Material, name: string) {
  const v = mat.uniforms?.[name]?.value;
  if (isThree(v, 'Color')) return v.clone();
  if (isThree(v, 'Vector3')) return new THREE.Color(v.x, v.y, v.z);
  return null;
}

function shaderUniformColors(mat: Material, card: StyleCard | null) {
  if (!mat.uniforms || typeof mat.uniforms !== 'object') return null;
  let base = null;
  for (const name of (card && card.shaderColorUniforms) || DEFAULT_SHADER_COLOR_UNIFORMS) {
    base = uniformRgb(mat, name);
    if (base) break;
  }
  if (!base) return null;
  const [colorName, intensityName] = (card && card.shaderEmissiveUniforms) || DEFAULT_SHADER_EMISSIVE_UNIFORMS;
  const emission = uniformRgb(mat, colorName);
  const intensity = mat.uniforms[intensityName]?.value;
  if (emission && typeof intensity === 'number') emission.multiplyScalar(intensity);
  return { base, emission };
}

async function gltfPrimitiveOwners(gltf: GLTF) {
  const { parser } = gltf;
  const json: {
    scene?: number;
    scenes: { nodes?: number[] }[];
    nodes?: { children?: number[]; mesh?: number }[];
    meshes?: { primitives: unknown[] }[];
  } = parser.json;
  const pending = [...(json.scenes[json.scene ?? 0]?.nodes ?? [])];
  const owners = new Map<THREE.Object3D, THREE.Object3D>();
  for (let index = pending.pop(); index !== undefined; index = pending.pop()) {
    const node = json.nodes?.[index];
    if (!node) throw new Error(`Missing GLB node ${index}`);
    for (const child of node.children ?? []) pending.push(child);
    const count = node.mesh === undefined ? 0 : json.meshes?.[node.mesh]?.primitives.length ?? 0;
    if (count < 2) continue;
    const object: THREE.Object3D = await parser.getDependency('node', index);
    // GLTFLoader wraps the mesh group when a node also carries a camera, light or bone.
    const child = object.children[0];
    const group = isThree(child, 'Group') ? child : object;
    for (const primitive of group.children.slice(0, count)) owners.set(primitive, group);
  }
  return owners;
}

function inspectRoot(root: THREE.Object3D, inputKind: AssetMetrics['inputKind'], glbSource: GlbSourceInfo | null,
  card: StyleCard | null, primitiveOwners?: Map<THREE.Object3D, THREE.Object3D>) {
  root.updateMatrixWorld(true);

  const integrity = { ...EMPTY_INTEGRITY };
  const primitivesByMesh = new Map<THREE.Object3D, TriangleBuffers[]>();
  const uniqueGeos = new Set<THREE.BufferGeometry>();
  const effectiveMaterials = new Set<Material>();
  const effectiveTextures = new Set<THREE.Texture>();
  const activeMeshEntries: { mesh: THREE.Mesh; spans: Span[]; instances: number }[] = [];
  let hiddenMeshCount = 0;
  let trianglesByOccurrence = 0;
  let lineSegmentsCount = 0;
  let lineVerticesCount = 0;

  const worldBox = new THREE.Box3();
  const vA = new THREE.Vector3();
  const vB = new THREE.Vector3();
  const vC = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const cross = new THREE.Vector3();
  const instMat = new THREE.Matrix4();
  const combinedMat = new THREE.Matrix4();
  const instColor = new THREE.Color();

  root.traverse((obj) => {
    if (isThree(obj, 'Line')) {
      if (isObjectVisibleInHierarchy(obj)) {
        lineSegmentsCount += 1;
        const pos = obj.geometry && obj.geometry.getAttribute('position');
        if (pos) lineVerticesCount += pos.count;
      }
      return;
    }
    if (!isThree(obj, 'Mesh')) return;
    if (!isObjectVisibleInHierarchy(obj)) {
      hiddenMeshCount += 1;
      return;
    }
    const spans = activeSpansForMesh(obj);
    const drawn = spans.length === 0 ? 0 : drawnInstances(obj, spans);
    if (drawn <= 0) {
      hiddenMeshCount += 1;
      return;
    }
    // Only InstancedMesh carries per-instance matrices and colors; geometry instancing places copies in the shader.
    const instances = isThree(obj, 'InstancedMesh') ? drawn : 1;
    activeMeshEntries.push({ mesh: obj, spans, instances });
    const geo = obj.geometry;
    uniqueGeos.add(geo);
    const integritySpans = spans.map(span => {
      trianglesByOccurrence += span.triCount * drawn;
      effectiveMaterials.add(span.material);
      const channels = collectMaterialTextures(span.material, effectiveTextures);
      const requiredUvs = Array.from(channels, ch => geo.getAttribute(ch === 0 ? 'uv' : 'uv' + ch));
      return { start: span.start, end: span.end, requiredUvs };
    });
    const owner = primitiveOwners?.get(obj) ?? obj;
    const primitives = primitivesByMesh.get(owner) ?? [];
    primitivesByMesh.set(owner, primitives);
    primitives.push({
      spans: integritySpans,
      position: geo.getAttribute('position'), index: geo.index, normal: geo.getAttribute('normal'),
    });
  });
  for (const primitives of primitivesByMesh.values()) {
    const measured = inspectGeometryIntegrity(primitives);
    for (const key of Object.keys(measured) as (keyof typeof measured)[]) integrity[key] += measured[key];
  }

  // Compute exact world bounds from vertices referenced by active spans only.
  const worldPoints = [];
  for (const entry of activeMeshEntries) {
    const { mesh, spans, instances } = entry;
    const geo = mesh.geometry;
    const pos = geo.getAttribute('position');
    const idx = geo.index;
    const referencedVerts = new Set<number>();
    for (const span of spans) {
      for (let i = span.start; i < span.end; i += 1) {
        referencedVerts.add(idx ? idx.getX(i) : i);
      }
    }
    for (let inst = 0; inst < instances; inst += 1) {
      if (isThree(mesh, 'InstancedMesh')) {
        mesh.getMatrixAt(inst, instMat);
        combinedMat.multiplyMatrices(mesh.matrixWorld, instMat);
      } else {
        combinedMat.copy(mesh.matrixWorld);
      }
      for (const vi of referencedVerts) {
        vA.fromBufferAttribute(pos, vi).applyMatrix4(combinedMat);
        worldBox.expandByPoint(vA);
        worldPoints.push(vA.x, vA.y, vA.z);
      }
    }
  }

  let trianglesUnique = 0;
  let positionVerticesUnique = 0;
  for (const geo of uniqueGeos) {
    const pos = geo.getAttribute('position');
    const idx = geo.index;
    const total = idx ? idx.count : (pos ? pos.count : 0);
    const start = Math.max(0, geo.drawRange.start);
    const count = Math.min(total - start, geo.drawRange.count);
    trianglesUnique += Math.max(0, Math.floor(count / 3));
    if (pos) positionVerticesUnique += pos.count;
  }

  const hasBounds = !worldBox.isEmpty();
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  if (hasBounds) {
    worldBox.getSize(size);
    worldBox.getCenter(center);
  }
  const maxExtent = hasBounds ? Math.max(size.x, size.y, size.z) : 0;
  const boundingRadius = hasBounds ? size.length() * 0.5 : 0;
  // Scale-relative degeneracy floor with no artificial minimum floor so tiny valid geometry is preserved.
  const minArea = maxExtent > 0 ? Math.pow(maxExtent * 1e-6, 2) : 0;

  let degenerateTriangles = 0;
  for (const entry of activeMeshEntries) {
    const { mesh, spans, instances } = entry;
    const geo = mesh.geometry;
    const pos = geo.getAttribute('position');
    const idx = geo.index;
    for (let inst = 0; inst < instances; inst += 1) {
      if (isThree(mesh, 'InstancedMesh')) {
        mesh.getMatrixAt(inst, instMat);
        combinedMat.multiplyMatrices(mesh.matrixWorld, instMat);
      } else {
        combinedMat.copy(mesh.matrixWorld);
      }
      for (const span of spans) {
        for (let i = span.start; i + 2 < span.end; i += 3) {
          const i0 = idx ? idx.getX(i) : i;
          const i1 = idx ? idx.getX(i + 1) : i + 1;
          const i2 = idx ? idx.getX(i + 2) : i + 2;
          vA.fromBufferAttribute(pos, i0).applyMatrix4(combinedMat);
          vB.fromBufferAttribute(pos, i1).applyMatrix4(combinedMat);
          vC.fromBufferAttribute(pos, i2).applyMatrix4(combinedMat);
          e1.subVectors(vB, vA);
          e2.subVectors(vC, vA);
          cross.crossVectors(e1, e2);
          if (0.5 * cross.length() <= minArea) {
            degenerateTriangles += 1;
          }
        }
      }
    }
  }

  const palEntries = card && card.palette
    ? Object.entries(card.palette).map(([role, hex]) => {
        const lin = hexSrgbToLinearRgb(hex);
        return { role, hex, lab: linearRgbToLabD65(lin[0], lin[1], lin[2]) };
      })
    : [];
  const hasPalette = palEntries.length > 0;

  let assessedMeshes = 0;
  let texturedMeshes = 0;
  let shaderMeshes = 0;
  let shaderUniformMeshes = 0;
  let sampledCorners = 0;
  let maxDelta = 0;
  let worst: PaletteCornerViolation | null = null;
  type Match = { nearestRole: string; nearestHex: string; deltaE76: number };
  const scores = new Map<string, Match>();
  const colorSamples = new Map<string, { hexSrgb: string; samples: number; meshes: Set<string>; match: Match | null }>();

  const evalLinearColor = (meshName: string, lr: number, lg: number, lb: number) => {
    sampledCorners += 1;
    const hexSrgb = linearRgbToHexSrgb(lr, lg, lb);
    let match = null;
    if (hasPalette) {
      const key = `${lr},${lg},${lb}`;
      match = scores.get(key) ?? null;
      if (!match) {
        const lab = linearRgbToLabD65(lr, lg, lb);
        for (const p of palEntries) {
          const distance = deltaE76(lab, p.lab);
          if (!match || distance < match.deltaE76) {
            match = { nearestRole: p.role, nearestHex: p.hex, deltaE76: distance };
          }
        }
        if (match) scores.set(key, match);
      }
      if (match && match.deltaE76 > maxDelta) {
        maxDelta = match.deltaE76;
        worst = { meshName, hexSrgb, ...match };
      }
    }

    const entry = colorSamples.get(hexSrgb);
    if (!entry) {
      colorSamples.set(hexSrgb, { hexSrgb, samples: 1, meshes: new Set([meshName]), match });
    } else {
      entry.samples += 1;
      entry.meshes.add(meshName);
      if (match && (!entry.match || match.deltaE76 > entry.match.deltaE76)) entry.match = match;
    }
  };

  for (const entry of activeMeshEntries) {
    const { mesh, spans, instances } = entry;
    const geo = mesh.geometry;
    const colorAttr = geo.getAttribute('color');
    const idx = geo.index;
    const meshName = mesh.name || 'unnamed';
    let meshHadTextured = false;
    let meshHadShader = false;
    let meshHadShaderUniform = false;
    let meshHadAssessed = false;

    for (const span of spans) {
      const mat = span.material;
      const emission = mat.emissive?.clone().multiplyScalar(mat.emissiveIntensity ?? 1);
      const hasEmissiveTexture = mat.emissiveMap?.isTexture && emission &&
        (emission.r !== 0 || emission.g !== 0 || emission.b !== 0);
      const hasColorTexture =
        mat.map?.isTexture || hasEmissiveTexture ||
        (isThree(mat, 'ShaderMaterial') && materialHasUniformTexture(mat));
      if (hasColorTexture) {
        meshHadTextured = true;
        continue;
      }
      let baseColor = mat.color;
      let addColor: THREE.Color | null | undefined = emission;
      if (isThree(mat, 'ShaderMaterial') && !baseColor) {
        const shaded = shaderUniformColors(mat, card);
        // A shader with no known color uniform computes its output in GLSL, so its authored color is unknowable here.
        if (shaded === null) {
          meshHadShader = true;
          continue;
        }
        meshHadShaderUniform = true;
        baseColor = shaded.base;
        addColor = shaded.emission;
      }
      meshHadAssessed = true;
      const matR = baseColor ? baseColor.r : 1;
      const matG = baseColor ? baseColor.g : 1;
      const matB = baseColor ? baseColor.b : 1;
      const sample = (r: number, g: number, b: number) => evalLinearColor(meshName,
        THREE.MathUtils.clamp(r + (addColor?.r ?? 0), 0, 1),
        THREE.MathUtils.clamp(g + (addColor?.g ?? 0), 0, 1),
        THREE.MathUtils.clamp(b + (addColor?.b ?? 0), 0, 1),
      );
      const useVertexColors = Boolean(mat.vertexColors) && Boolean(colorAttr);
      const hasInstColor = isThree(mesh, 'InstancedMesh') && mesh.instanceColor;

      for (let inst = 0; inst < instances; inst += 1) {
        let ir = 1, ig = 1, ib = 1;
        if (hasInstColor) {
          mesh.getColorAt(inst, instColor);
          ir = instColor.r;
          ig = instColor.g;
          ib = instColor.b;
        }
        if (useVertexColors) {
          const seen = new Set<number>();
          for (let i = span.start; i < span.end; i += 1) {
            const vi = idx ? idx.getX(i) : i;
            if (seen.has(vi)) continue;
            seen.add(vi);
            sample(
              matR * ir * colorAttr.getX(vi),
              matG * ig * colorAttr.getY(vi),
              matB * ib * colorAttr.getZ(vi),
            );
          }
        } else {
          sample(matR * ir, matG * ig, matB * ib);
        }
      }
    }

    if (meshHadTextured) texturedMeshes += 1;
    if (meshHadShader) shaderMeshes += 1;
    if (meshHadShaderUniform) shaderUniformMeshes += 1;
    if (meshHadAssessed) assessedMeshes += 1;
  }

  const unassessed = texturedMeshes + shaderMeshes;
  const colors = [...colorSamples.values()]
    .map(({ hexSrgb, samples, meshes, match }) => ({
      hexSrgb, samples, meshes, nearestRole: match?.nearestRole ?? null,
      nearestHex: match?.nearestHex ?? null, deltaE76: match?.deltaE76 ?? null,
    }))
    .sort((a, b) => b.samples - a.samples || (b.deltaE76 ?? 0) - (a.deltaE76 ?? 0) || a.hexSrgb.localeCompare(b.hexSrgb))
    .slice(0, MAX_REPORTED_COLORS)
    .map((c) => ({ ...c, meshes: [...c.meshes].sort().slice(0, 4) }));
  const palette: PaletteAssessment = {
    status: !hasPalette
      ? 'skipped_no_palette'
      : unassessed > 0 && assessedMeshes > 0
        ? 'partial_textured'
        : unassessed > 0
          ? 'unassessed_textured'
          : 'assessed',
    assessedMeshes,
    texturedMeshes,
    shaderMeshes,
    shaderUniformMeshes,
    sampledCorners,
    distinctColors: colorSamples.size,
    maxDeltaE76: hasPalette && sampledCorners > 0 ? maxDelta : null,
    worstViolation: worst,
    colors,
  };

  return {
    metrics: {
      inputKind,
      glbSource,
      integrity,
      trianglesByOccurrence,
      trianglesUnique,
      positionVerticesUnique,
      lineSegmentsCount,
      lineVerticesCount,
      effectiveMaterials: effectiveMaterials.size,
      effectiveTextures: effectiveTextures.size,
      degenerateTriangles,
      visibleMeshCount: activeMeshEntries.length,
      hiddenMeshCount,
      worldBounds: hasBounds
        ? {
            min: { x: worldBox.min.x, y: worldBox.min.y, z: worldBox.min.z },
            max: { x: worldBox.max.x, y: worldBox.max.y, z: worldBox.max.z },
            size: { x: size.x, y: size.y, z: size.z },
            center: { x: center.x, y: center.y, z: center.z },
            maxExtent,
            boundingRadius,
          }
        : null,
      palette,
      shape: hasBounds ? measureShape(worldPoints, worldBox, card) : null,
    },
    worldBox: hasBounds ? worldBox : null,
    center,
    boundingRadius,
  };
}

function measureShape(points: number[], box: THREE.Box3, card: StyleCard | null): ShapeMetrics {
  const geometry = card?.geometry ?? {};
  const front = axisVec(card?.frontAxis, new THREE.Vector3(0, 0, 1));
  const lengthAxis = front.x ? 'x' : front.y ? 'y' : 'z';
  const heightAxis = lengthAxis === 'y' ? 'z' : 'y';
  const widthAxis = lengthAxis === 'x' ? 'z' : 'x';
  const size = box.getSize(new THREE.Vector3());
  const maxExtent = Math.max(size.x, size.y, size.z);
  const length = size[lengthAxis];
  const width = size[widthAxis];
  const height = size[heightAxis];
  const ratio = (a: number, b: number) => (b > 0 ? a / b : null);

  const n = points.length / 3;
  const stride = Math.max(1, Math.ceil(n / MAX_SHAPE_POINTS));

  const symFraction = geometry.symmetryToleranceFraction ?? 0.01;
  const symTol = Math.max(symFraction * maxExtent, 1e-12);
  const planeCoord = (box.min[widthAxis] + box.max[widthAxis]) * 0.5;
  const cellKey = (x: number, y: number, z: number) => Math.floor(x / symTol) + ',' + Math.floor(y / symTol) + ',' + Math.floor(z / symTol);
  // Index every point; only the queries are strided, so a sampled vertex can always find its mirror.
  const grid = new Map<string, number[]>();
  const point = new THREE.Vector3();
  for (let i = 0; i < n; i += 1) {
    const o = i * 3;
    point.fromArray(points, o);
    const key = cellKey(point.x, point.y, point.z);
    let cell = grid.get(key);
    if (!cell) {
      cell = [];
      grid.set(key, cell);
    }
    cell.push(o);
  }
  let sampled = 0;
  let matched = 0;
  const q = new THREE.Vector3();
  for (let i = 0; i < n; i += stride) {
    const o = i * 3;
    q.fromArray(points, o);
    q[widthAxis] = 2 * planeCoord - q[widthAxis];
    sampled += 1;
    const cx = Math.floor(q.x / symTol);
    const cy = Math.floor(q.y / symTol);
    const cz = Math.floor(q.z / symTol);
    let found = false;
    for (let dx = -1; dx <= 1 && !found; dx += 1) {
      for (let dy = -1; dy <= 1 && !found; dy += 1) {
        for (let dz = -1; dz <= 1 && !found; dz += 1) {
          const cell = grid.get((cx + dx) + ',' + (cy + dy) + ',' + (cz + dz));
          if (!cell) continue;
          for (const c of cell) {
            point.fromArray(points, c);
            if (Math.hypot(point.x - q.x, point.y - q.y, point.z - q.z) <= symTol) {
              found = true;
              break;
            }
          }
        }
      }
    }
    if (found) matched += 1;
  }

  const groundFraction = geometry.groundToleranceFraction ?? 0.01;
  const groundTol = groundFraction * maxExtent;
  let fx0 = Infinity, fx1 = -Infinity, fz0 = Infinity, fz1 = -Infinity;
  for (let i = 0; i < n; i += 1) {
    const o = i * 3;
    point.fromArray(points, o);
    if (point.y > box.min.y + groundTol) continue;
    fx0 = Math.min(fx0, point.x);
    fx1 = Math.max(fx1, point.x);
    fz0 = Math.min(fz0, point.z);
    fz1 = Math.max(fz1, point.z);
  }
  const groundArea = size.x * size.z;
  const footprint = groundArea > 0 && fx1 >= fx0 ? ((fx1 - fx0) * (fz1 - fz0)) / groundArea : null;

  return {
    lengthAxis,
    widthAxis,
    heightAxis,
    length,
    width,
    height,
    lengthToWidth: ratio(length, width),
    heightToLength: ratio(height, length),
    groundOffset: box.min.y,
    groundFootprintRatio: footprint,
    groundToleranceFraction: groundFraction,
    mirror: {
      planeAxis: widthAxis,
      planeCoord,
      planeOffsetFraction: maxExtent > 0 ? Math.abs(planeCoord) / maxExtent : 0,
      matchRatio: sampled > 0 ? matched / sampled : 1,
      sampledPoints: sampled,
      toleranceFraction: symFraction,
    },
  };
}

function boxCorners(box: THREE.Box3) {
  const { min, max } = box;
  return [
    new THREE.Vector3(min.x, min.y, min.z),
    new THREE.Vector3(min.x, min.y, max.z),
    new THREE.Vector3(min.x, max.y, min.z),
    new THREE.Vector3(min.x, max.y, max.z),
    new THREE.Vector3(max.x, min.y, min.z),
    new THREE.Vector3(max.x, min.y, max.z),
    new THREE.Vector3(max.x, max.y, min.z),
    new THREE.Vector3(max.x, max.y, max.z),
  ];
}

// Presets change lights and tone mapping only, so cameras, background, and gates stay comparable.
function addLightingRig(scene: THREE.Scene, preset: LightingPreset, radius: number, renderer: THREE.WebGLRenderer) {
  const at = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).multiplyScalar(radius * 4);
  const directional = (color: number, intensity: number, pos: THREE.Vector3) => {
    const light = new THREE.DirectionalLight(color, intensity);
    light.position.copy(pos);
    scene.add(light);
  };
  if (preset === 'cel') {
    renderer.toneMapping = THREE.NoToneMapping;
    directional(0xffdfbd, 2.4, at(0.9, 1.2, 1.1));
    directional(0x6b88ff, 1.05, at(-1.1, 0.5, -1.4));
    scene.add(new THREE.HemisphereLight(0x7c88b8, 0x1b172c, 0.78));
    return;
  }
  if (preset === 'dramatic') {
    // Low raking key from one side and a faint opposite rim leave deep form shadows.
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;
    directional(0xffd2a0, 3.4, at(1.6, 0.35, 0.2));
    directional(0x5a78ff, 0.9, at(-1.2, 0.9, -1.0));
    scene.add(new THREE.HemisphereLight(0x5a6488, 0x0a0812, 0.25));
    return;
  }
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  directional(0xfff1dc, 2.2, at(1.2, 1.5, 1.0));
  directional(0x7ca2ff, 1.0, at(-1.3, 0.7, -1.1));
  scene.add(new THREE.HemisphereLight(0xaab8e0, 0x242038, 0.85));
}

const SILHOUETTE_VIEWS = ['ortho-top', 'ortho-front'];

function silhouetteSheet(silhouettes: Map<string, ImageData>, tileW: number, tileH: number, labelH: number) {
  const canvas = document.createElement('canvas');
  canvas.width = SILHOUETTE_VIEWS.length * tileW;
  canvas.height = labelH + tileH;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  ctx.fillStyle = '#d0d0d0';
  ctx.fillRect(0, 0, canvas.width, labelH);
  ctx.font = 'bold 13px monospace';
  ctx.fillStyle = '#000000';
  ctx.textAlign = 'left';
  SILHOUETTE_VIEWS.forEach((id, i) => {
    const image = silhouettes.get(id);
    if (!image) throw new Error(`Missing silhouette for ${id}`);
    ctx.putImageData(image, i * tileW, labelH);
    ctx.fillText(id, i * tileW + 10, 17);
  });
  return canvas.toDataURL('image/png');
}

function renderContactSheet(root: THREE.Object3D, worldBox: THREE.Box3 | null, center: THREE.Vector3, radius: number,
  card: StyleCard | null, capture: BrowserCapture): RenderedViews {
  const tileW = capture.tileWidth;
  const tileH = capture.tileHeight;
  const cols = 3;
  const rows = 3;
  const labelH = 26;

  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(tileW, tileH, false);
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const safeRadius = Math.max(radius, 1e-6);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x161926);
  scene.add(root);
  addLightingRig(scene, capture.lighting, safeRadius, renderer);

  const front = axisVec(card && card.frontAxis, new THREE.Vector3(0, 0, 1)).normalize();
  const worldUp = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(worldUp, front).normalize();
  if (right.lengthSq() < 0.01) right.set(1, 0, 0);
  const topUp = axisVec(card && card.topUpAxis, front.clone().negate()).normalize();
  if (Math.abs(topUp.dot(worldUp)) > 0.999) {
    throw new Error('topUpAxis cannot be parallel to +Y/-Y for ortho-top view');
  }

  const dirFromAzEl = (azDeg: number, elDeg: number) => {
    const az = (azDeg * Math.PI) / 180;
    const el = (elDeg * Math.PI) / 180;
    const horiz = front.clone().multiplyScalar(Math.cos(az)).addScaledVector(right, Math.sin(az));
    return horiz.multiplyScalar(Math.cos(el)).addScaledVector(worldUp, Math.sin(el)).normalize();
  };

  const viewDefs = [
    { id: 'persp-front', dir: dirFromAzEl(0, 10), up: worldUp, ortho: false },
    { id: 'persp-three-quarter', dir: dirFromAzEl(38, 22), up: worldUp, ortho: false },
    { id: 'persp-right', dir: dirFromAzEl(90, 10), up: worldUp, ortho: false },
    { id: 'persp-back', dir: dirFromAzEl(180, 10), up: worldUp, ortho: false },
    { id: 'persp-left', dir: dirFromAzEl(270, 10), up: worldUp, ortho: false },
    { id: 'persp-hero-low', dir: dirFromAzEl(-36, -12), up: worldUp, ortho: false },
    { id: 'ortho-front', dir: dirFromAzEl(0, 0), up: worldUp, ortho: true },
    { id: 'ortho-right', dir: dirFromAzEl(90, 0), up: worldUp, ortho: true },
    { id: 'ortho-top', dir: new THREE.Vector3(0, 1, 0), up: topUp, ortho: true },
  ];

  const sheetCanvas = document.createElement('canvas');
  sheetCanvas.width = cols * tileW;
  sheetCanvas.height = rows * (tileH + labelH);
  const ctx = sheetCanvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  ctx.fillStyle = '#0d101a';
  ctx.fillRect(0, 0, sheetCanvas.width, sheetCanvas.height);

  const mask = (color: number, side: THREE.Side) => new THREE.MeshBasicMaterial({ color, side, toneMapped: false });
  const doubleMask = mask(0xff0000, THREE.DoubleSide);
  const frontMask = mask(0xffff00, THREE.FrontSide);
  const exemptMask = mask(0xffffff, THREE.DoubleSide);
  const gl = renderer.getContext();
  const pixelBuf = new Uint8Array(tileW * tileH * 4);
  const pixels = new DataView(pixelBuf.buffer);
  const aspect = tileW / tileH;
  const vFovDeg = 40;
  const tanHalfV = Math.tan(((vFovDeg * Math.PI) / 180) * 0.5);
  const tanHalfH = tanHalfV * aspect;
  const corners = worldBox ? boxCorners(worldBox) : [];

  const maskObjects: {
    obj: Drawable;
    original: Drawable['material'];
    double: Drawable['material'];
    front: Drawable['material'];
    instanceColor: THREE.InstancedBufferAttribute | null;
  }[] = [];
  root.traverseVisible((obj) => {
    if (!hasMaterial(obj)) return;
    const maskFor = (material: THREE.Material, frontPass: boolean) => {
      if (!material?.visible) return material;
      if (!isThree(obj, 'Mesh') || material.side !== THREE.FrontSide) return exemptMask;
      return frontPass ? frontMask : doubleMask;
    };
    const materialsFor = (frontPass: boolean) => Array.isArray(obj.material)
      ? obj.material.map(mat => maskFor(mat, frontPass))
      : maskFor(obj.material, frontPass);
    maskObjects.push({
      obj, original: obj.material, double: materialsFor(false), front: materialsFor(true),
      instanceColor: isThree(obj, 'InstancedMesh') ? obj.instanceColor : null,
    });
  });

  const views = [];
  const viewImages = [];
  const silhouettes = new Map<string, ImageData>();

  for (const [idx, def] of viewDefs.entries()) {
    const camZ = def.dir.clone().normalize();
    const camX = new THREE.Vector3().crossVectors(def.up, camZ).normalize();
    const camY = new THREE.Vector3().crossVectors(camZ, camX).normalize();

    let maxX = safeRadius;
    let maxY = safeRadius;
    let maxZ = safeRadius;
    if (corners.length > 0) {
      maxX = 0;
      maxY = 0;
      maxZ = 0;
      for (const c of corners) {
        const rel = c.clone().sub(center);
        maxX = Math.max(maxX, Math.abs(rel.dot(camX)));
        maxY = Math.max(maxY, Math.abs(rel.dot(camY)));
        maxZ = Math.max(maxZ, Math.abs(rel.dot(camZ)));
      }
      maxX = Math.max(maxX, safeRadius * 0.05);
      maxY = Math.max(maxY, safeRadius * 0.05);
      maxZ = Math.max(maxZ, safeRadius * 0.05);
    }

    const pad = 1.24;
    let cam;
    if (def.ortho) {
      const halfH = Math.max(maxY, maxX / aspect) * pad;
      const halfW = halfH * aspect;
      const dist = maxZ * 3 + safeRadius;
      cam = new THREE.OrthographicCamera(
        -halfW,
        halfW,
        halfH,
        -halfH,
        Math.max(dist - maxZ * 2.5, safeRadius * 1e-4),
        dist + maxZ * 3,
      );
      cam.position.copy(center).addScaledVector(camZ, dist);
    } else {
      const distH = (maxX * pad) / tanHalfH;
      const distV = (maxY * pad) / tanHalfV;
      const dist = Math.max(distH, distV) + maxZ * 1.15;
      const near = Math.max((dist - maxZ * 1.4) * 0.25, safeRadius * 1e-4);
      const far = dist + maxZ * 3 + safeRadius;
      cam = new THREE.PerspectiveCamera(vFovDeg, aspect, near, far);
      cam.position.copy(center).addScaledVector(camZ, dist);
    }

    const viewZoom = def.ortho && !capture.zoomOrtho ? 1 : capture.zoom;
    cam.zoom = viewZoom;
    cam.updateProjectionMatrix();
    cam.up.copy(def.up);
    cam.lookAt(center);
    cam.updateMatrixWorld();

    scene.background = new THREE.Color(0x161926);
    renderer.render(scene, cam);
    gl.readPixels(0, 0, tileW, tileH, gl.RGBA, gl.UNSIGNED_BYTE, pixelBuf);
    const beautyBuckets = new Set();
    for (let p = 0; p < pixelBuf.length; p += 16) {
      beautyBuckets.add(((pixels.getUint8(p) >> 4) << 8) | ((pixels.getUint8(p + 1) >> 4) << 4) | (pixels.getUint8(p + 2) >> 4));
    }

    const col = idx % cols;
    const row = Math.floor(idx / cols);
    const dx = col * tileW;
    const dy = row * (tileH + labelH);
    ctx.drawImage(renderer.domElement, dx, dy + labelH);
    if (capture.saveViews) viewImages.push({ id: def.id, dataUrl: renderer.domElement.toDataURL('image/png') });

    ctx.fillStyle = '#0b0e18';
    ctx.fillRect(dx, dy, tileW, labelH);
    ctx.strokeStyle = '#2d354f';
    ctx.lineWidth = 1;
    ctx.strokeRect(dx + 0.5, dy + 0.5, tileW - 1, tileH + labelH - 1);
    ctx.font = 'bold 13px monospace';
    ctx.fillStyle = '#f4b459';
    ctx.textAlign = 'left';
    ctx.fillText(def.id, dx + 10, dy + 17);

    try {
      for (const item of maskObjects) {
        item.obj.material = item.double;
        if (item.instanceColor && isThree(item.obj, 'InstancedMesh')) item.obj.instanceColor = null;
      }
      scene.background = new THREE.Color(0x000000);
      renderer.render(scene, cam);

      // Preserve nearest-surface depth so an inside-out shell cannot fill its mask with far faces.
      scene.background = null;
      renderer.autoClear = false;
      for (const item of maskObjects) item.obj.material = item.front;
      renderer.render(scene, cam);
    } finally {
      renderer.autoClear = true;
      for (const item of maskObjects) {
        item.obj.material = item.original;
        if (item.instanceColor && isThree(item.obj, 'InstancedMesh')) item.obj.instanceColor = item.instanceColor;
      }
    }

    gl.readPixels(0, 0, tileW, tileH, gl.RGBA, gl.UNSIGNED_BYTE, pixelBuf);
    let covered = 0;
    let frontSidePixels = 0;
    let culledPixels = 0;
    let edgeClipped = false;
    for (let y = 0; y < tileH; y += 1) {
      for (let x = 0; x < tileW; x += 1) {
        const off = (y * tileW + x) * 4;
        if (pixels.getUint8(off) > 128) {
          covered += 1;
          if (pixels.getUint8(off + 2) <= 128) {
            frontSidePixels += 1;
            if (pixels.getUint8(off + 1) <= 128) culledPixels += 1;
          }
          if (x === 0 || x === tileW - 1 || y === 0 || y === tileH - 1) {
            edgeClipped = true;
          }
        }
      }
    }

    if (capture.blackFill && SILHOUETTE_VIEWS.includes(def.id)) {
      // readPixels rows run bottom-up.
      const image = new ImageData(tileW, tileH);
      for (let y = 0; y < tileH; y += 1) {
        for (let x = 0; x < tileW; x += 1) {
          const src = ((tileH - 1 - y) * tileW + x) * 4;
          const dst = (y * tileW + x) * 4;
          const v = pixels.getUint8(src) > 128 ? 0 : 255;
          image.data[dst] = v;
          image.data[dst + 1] = v;
          image.data[dst + 2] = v;
          image.data[dst + 3] = 255;
        }
      }
      silhouettes.set(def.id, image);
    }

    views.push({
      id: def.id,
      ortho: def.ortho,
      zoom: viewZoom,
      coverageRatio: covered / (tileW * tileH),
      culledFrontSideRatio: frontSidePixels ? culledPixels / frontSidePixels : 0,
      edgeClipped,
      beautyUniqueColors: beautyBuckets.size,
    });
  }

  doubleMask.dispose();
  frontMask.dispose();
  exemptMask.dispose();
  renderer.dispose();
  return {
    views,
    viewImages,
    sheetDataUrl: sheetCanvas.toDataURL('image/png'),
    silhouetteDataUrl: capture.blackFill ? silhouetteSheet(silhouettes, tileW, tileH, labelH) : null,
  };
}

export async function run({ inputKind, glbUrl, glbSource, card, renderSheet, capture }: AssetBrowserInput, factory?: FactoryModule): Promise<AssetBrowserResult> {
  let root;
  let primitiveOwners;
  if (inputKind === 'glb') {
    const resp = await fetch(glbUrl);
    if (!resp.ok) throw new Error('Failed to fetch GLB payload');
    const arrayBuf = await resp.arrayBuffer();
    const loader = new GLTFLoader();
    const gltf = await loader.parseAsync(arrayBuf, '');
    root = gltf.scene;
    primitiveOwners = await gltfPrimitiveOwners(gltf);
  } else {
    const fn = factory?.buildAsset || factory?.default;
    if (typeof fn !== 'function') {
      throw new Error('Factory module must export buildAsset(THREE) or default function');
    }
    root = await fn(THREE);
  }
  if (!isThree(root, 'Object3D')) {
    throw new Error('Loaded asset did not return a THREE.Object3D');
  }

  const inspected = inspectRoot(root, inputKind, glbSource, card, primitiveOwners);
  const rendered = renderSheet
    ? renderContactSheet(root, inspected.worldBox, inspected.center, inspected.boundingRadius, card, capture)
    : { views: [], viewImages: [], sheetDataUrl: null, silhouetteDataUrl: null };
  return { metrics: inspected.metrics, ...rendered };
}
