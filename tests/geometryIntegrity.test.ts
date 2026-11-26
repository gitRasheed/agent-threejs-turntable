import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateGeometryIntegrity, inspectGeometryIntegrity } from '../src/geometryIntegrity.js';

function attribute(values: ArrayLike<number>, itemSize: number) {
  return {
    count: values.length / itemSize,
    itemSize,
    getX: (i: number) => values[i * itemSize] ?? NaN,
    getY: (i: number) => values[i * itemSize + 1] ?? NaN,
    getZ: (i: number) => values[i * itemSize + 2] ?? NaN,
  };
}

const points = [
  -1,-1,-1,  1,-1,-1,  1,1,-1,  -1,1,-1,
  -1,-1, 1,  1,-1, 1,  1,1, 1,  -1,1, 1,
];
const triangles = [
  0,2,1, 0,3,2,  4,5,6, 4,6,7,
  0,1,5, 0,5,4,  3,7,6, 3,6,2,
  0,4,7, 0,7,3,  1,2,6, 1,6,5,
];

function cube(indices = triangles) {
  return {
    position: attribute(new Float32Array(points), 3),
    index: attribute(new Uint16Array(indices), 1),
    normal: attribute(new Float32Array(points.map(n => n / Math.sqrt(3))), 3),
  };
}

const strictCard = {
  requireWatertight: true, maxOpenBoundaryEdges: 0, maxNonManifoldEdges: 0,
  requireValidNormals: true, requireUvsOnTextured: true, requireConsistentWinding: true,
};
const clean = {
  openBoundaryEdges: 0, nonManifoldEdges: 0, windingInconsistencies: 0,
  missingNormals: 0, zeroLengthNormals: 0, unnormalizedNormals: 0, missingUvs: 0,
};
const textured = [{ start: 0, end: 36, requiredUvs: [attribute(new Float32Array(16), 2)] }];

test('closed textured cube passes every gate', () => {
  const metrics = inspectGeometryIntegrity([{ ...cube(), spans: textured }]);
  assert.deepEqual(metrics, clean);
  assert.deepEqual(evaluateGeometryIntegrity(metrics, strictCard), []);
});

test('the non-indexed cube stays closed across split attributes and material groups', () => {
  const positions = triangles.flatMap(i => points.slice(3 * i, 3 * i + 3));
  const metrics = inspectGeometryIntegrity([{
    position: attribute(positions, 3),
    normal: attribute(positions.map(n => n / Math.sqrt(3)), 3),
    spans: [{ start: 0, end: 18, requiredUvs: [] }, { start: 18, end: 36, requiredUvs: [attribute(triangles.flatMap((_, i) => [i % 2, i % 3]), 2)] }],
  }]);
  assert.deepEqual(metrics, clean);
});

test('removing a quad exposes four boundary edges at an inclusive budget', () => {
  const metrics = inspectGeometryIntegrity([cube(triangles.slice(6))]);
  assert.deepEqual(metrics, { ...clean, openBoundaryEdges: 4 });
  assert.deepEqual(evaluateGeometryIntegrity(metrics, { maxOpenBoundaryEdges: 4 }), []);
  const [finding] = evaluateGeometryIntegrity(metrics, { maxOpenBoundaryEdges: 3 });
  assert.equal(finding?.limit, 3);
  assert.equal(finding?.actual, 4);
  assert.deepEqual(evaluateGeometryIntegrity(metrics, { requireWatertight: true, maxOpenBoundaryEdges: 4 })
    .map(f => f.id), ['OPEN_BOUNDARY_EDGES']);
});

test('stripping normals fails once and counts all eight referenced vertices', () => {
  const metrics = inspectGeometryIntegrity([{ ...cube(), normal: null }]);
  assert.deepEqual(metrics, { ...clean, missingNormals: 8 });
  assert.deepEqual(evaluateGeometryIntegrity(metrics, strictCard).map(f => f.id), ['MISSING_NORMALS']);
});

test('flipping a quad disagrees with its four neighbors', () => {
  const metrics = inspectGeometryIntegrity([cube([0,1,2, 0,2,3, ...triangles.slice(6)])]);
  assert.deepEqual(metrics, { ...clean, windingInconsistencies: 4 });
  assert.deepEqual(evaluateGeometryIntegrity(metrics, strictCard).map(f => f.id), ['INCONSISTENT_WINDING']);
});

test('three triangles sharing one edge exceed a zero non-manifold budget', () => {
  const metrics = inspectGeometryIntegrity([cube([0,1,2, 1,0,3, 0,1,4])]);
  assert.equal(metrics.nonManifoldEdges, 1);
  assert.equal(metrics.openBoundaryEdges, 6);
  assert.deepEqual(evaluateGeometryIntegrity(metrics, { maxNonManifoldEdges: 0 }).map(f => f.id), ['NON_MANIFOLD_EDGES']);
  assert.deepEqual(evaluateGeometryIntegrity(metrics, { maxNonManifoldEdges: 1 }), []);
  assert.deepEqual(evaluateGeometryIntegrity(metrics), []);
});

test('short, zero, nonfinite and non-unit normals give separate counts', () => {
  const normal = attribute([0,0,0, 0,0,2, NaN,0,1, 0,0,1.00001], 3);
  const metrics = inspectGeometryIntegrity([{ ...cube(), normal }]);
  assert.deepEqual(metrics, { ...clean, missingNormals: 4, zeroLengthNormals: 1, unnormalizedNormals: 2 });
  assert.deepEqual(evaluateGeometryIntegrity(metrics, strictCard).map(f => f.id),
    ['MISSING_NORMALS', 'ZERO_LENGTH_NORMALS', 'UNNORMALIZED_NORMALS']);
});

test('UV checks cover only the vertices used by textured spans, even after untextured use', () => {
  const spans = [{ start: 0, end: 6, requiredUvs: [] }, { start: 6, end: 12, requiredUvs: [attribute([0,0], 2)] }];
  const mesh = cube([0,1,2, 0,2,3, 0,4,7, 0,7,3]);
  const metrics = inspectGeometryIntegrity([{ ...mesh, spans }]);
  assert.equal(metrics.missingUvs, 3);
  assert.deepEqual(evaluateGeometryIntegrity(metrics, { requireUvsOnTextured: true }).map(f => f.id), ['MISSING_UVS']);
  assert.equal(inspectGeometryIntegrity([mesh]).missingUvs, 0);
});
