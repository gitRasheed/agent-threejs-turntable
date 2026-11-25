import assert from 'node:assert/strict';
import { it } from 'node:test';
import { evaluateAssetGates } from '../src/evaluate.js';
import { EMPTY_INTEGRITY } from '../src/geometryIntegrity.js';
import type { AssetMetrics, StyleCard } from '../src/types.js';

const metrics: AssetMetrics = {
  inputKind: 'glb',
  glbSource: { bytes: 1924, scenes: 1, declaredMaterials: 2, declaredTextures: 0, nonTrianglePrimitives: 1 },
  integrity: EMPTY_INTEGRITY,
  trianglesByOccurrence: 12, trianglesUnique: 12, positionVerticesUnique: 24,
  lineSegmentsCount: 1, lineVerticesCount: 2, effectiveMaterials: 2, effectiveTextures: 0,
  degenerateTriangles: 0, visibleMeshCount: 1, hiddenMeshCount: 0,
  worldBounds: {
    min: { x: -1, y: 1, z: -1 }, max: { x: 1, y: 3, z: 1 },
    center: { x: 0, y: 2, z: 0 }, size: { x: 2, y: 2, z: 2 }, maxExtent: 2, boundingRadius: Math.sqrt(3),
  },
  palette: {
    status: 'assessed', assessedMeshes: 1, texturedMeshes: 0, shaderMeshes: 0, shaderUniformMeshes: 0,
    sampledCorners: 36, distinctColors: 1, maxDeltaE76: 0, worstViolation: null,
    colors: [{ hexSrgb: '#ffffff', samples: 36, meshes: ['box'], nearestRole: 'hull', nearestHex: '#ffffff', deltaE76: 0 }],
  },
  shape: {
    lengthAxis: 'z', widthAxis: 'x', heightAxis: 'y', length: 2, width: 2, height: 2,
    lengthToWidth: 1, heightToLength: 1, groundOffset: 1, groundFootprintRatio: 1, groundToleranceFraction: 0.01,
    mirror: { planeAxis: 'x', planeCoord: 0, planeOffsetFraction: 0, matchRatio: 1, sampledPoints: 24, toleranceFraction: 0.01 },
  },
};

const cases = [
  ['PIVOT_GROUND_MISMATCH', { pivot: 'ground' }, 1],
  ['PIVOT_CENTER_MISMATCH', { pivot: 'center' }, 2],
  ['ROLE_SEPARATION_LOW', {
    palette: { hull: '#ffffff', trim: '#ffffff' }, paletteDeltaE76Max: 0,
    separationRoles: [['hull', 'trim']], separationMinDeltaE76: 1,
  }, 0],
  ['MATERIALS_OVER_BUDGET', { budgets: { materialsMax: 1 } }, 2],
  ['NON_TRIANGLE_PRIMITIVES', { budgets: { requireTriangleLists: true } }, 1],
  ['ASPECT_HEIGHT_TO_LENGTH', { geometry: { heightToLength: [0.25, 0.5] } }, 1],
  ['TRIANGLES_OVER_BUDGET', { budgets: { trisMax: 11 } }, 12],
] as const satisfies ReadonlyArray<readonly [string, Omit<StyleCard, 'id'>, number]>;

for (const [id, rule, actual] of cases) {
  it(`fails the card with ${id}`, () => {
    const result = evaluateAssetGates(metrics, { id: 'box', ...rule });
    assert.equal(result.ok, false);
    assert.equal(result.unsupportedGate, false);
    assert.deepEqual(result.findings.map(f => [f.id, f.severity, f.actual]), [[id, 'fail', actual]]);
  });
}
