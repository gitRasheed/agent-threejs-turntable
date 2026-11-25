import type { GeometryIntegrity, GeometryIntegrityGates } from './types.js';

// Component readers preserve interleaved layouts and decode normalized integer attributes.
interface ScalarAttribute {
  readonly count: number;
  getX(index: number): number;
}
interface Vec2Attribute extends ScalarAttribute {
  readonly itemSize: number;
  getY(index: number): number;
}
interface Vec3Attribute extends Vec2Attribute {
  getZ(index: number): number;
}

export interface TriangleBuffers {
  readonly position: Vec3Attribute;
  readonly index?: ScalarAttribute | null;
  readonly normal?: Vec3Attribute | null;
  readonly uv?: Vec2Attribute | null;
}

type UvAttributes = readonly (Vec2Attribute | null | undefined)[];

export type TriangleSpan = {
  readonly start: number;
  readonly end: number;
} & ({ readonly usesTextureMap: boolean } | { readonly requiredUvs: UvAttributes });

export const EMPTY_INTEGRITY: GeometryIntegrity = {
  openBoundaryEdges: 0, nonManifoldEdges: 0, windingInconsistencies: 0,
  missingNormals: 0, zeroLengthNormals: 0, unnormalizedNormals: 0, missingUvs: 0,
};

/** Inspect one mesh across its active material spans. The default covers the full untextured mesh. */
export function inspectGeometryIntegrity(
  { position, index, normal, uv }: TriangleBuffers,
  spans?: readonly TriangleSpan[],
): GeometryIntegrity {
  const count = index?.count ?? position.count;
  const vertices = new Map<number, number>();
  const positions = new Map<string, number>();
  const missingUvVertices = new Set<number>();
  const edges = new Map<string, { forward: number; reverse: number }>();
  const metrics = { ...EMPTY_INTEGRITY };

  function vertexAt(corner: number, requiredUvs: UvAttributes): number {
    const i = index ? index.getX(corner) : corner;
    if (!Number.isInteger(i) || i < 0 || i >= position.count) {
      throw new RangeError(`Triangle corner ${corner} references invalid vertex ${i}`);
    }
    if (!missingUvVertices.has(i) && requiredUvs.some(uv => !uv || uv.itemSize < 2 || i >= uv.count ||
      !Number.isFinite(uv.getX(i)) || !Number.isFinite(uv.getY(i)))) {
      missingUvVertices.add(i);
      metrics.missingUvs++;
    }
    const cached = vertices.get(i);
    if (cached !== undefined) return cached;

    if (!normal || normal.itemSize < 3 || i >= normal.count) {
      metrics.missingNormals++;
    } else {
      const length = Math.hypot(normal.getX(i), normal.getY(i), normal.getZ(i));
      if (length === 0) metrics.zeroLengthNormals++;
      else if (!Number.isFinite(length) || Math.abs(length - 1) > 1e-3) metrics.unnormalizedNormals++;
    }

    const x = position.getX(i), y = position.getY(i), z = position.getZ(i);
    if (position.itemSize < 3 || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      throw new RangeError(`Invalid position at vertex ${i}`);
    }
    // Exact coordinates join vertices split at shading seams without closing small cracks.
    const key = `${x},${y},${z}`;
    let id = positions.get(key);
    if (id === undefined) {
      id = positions.size;
      positions.set(key, id);
    }
    vertices.set(i, id);
    return id;
  }

  function recordEdge(from: number, to: number) {
    const forward = from < to;
    const key = forward ? `${from},${to}` : `${to},${from}`;
    let edge = edges.get(key);
    if (!edge) {
      edge = { forward: 0, reverse: 0 };
      edges.set(key, edge);
    }
    if (forward) edge.forward++;
    else edge.reverse++;
  }

  for (const span of spans ?? [{ start: 0, end: count, usesTextureMap: false }]) {
    const { start, end } = span;
    const requiredUvs = 'requiredUvs' in span ? span.requiredUvs : span.usesTextureMap ? [uv] : [];
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > count ||
        (end - start) % 3 !== 0) {
      throw new RangeError(`Invalid triangle span [${start}, ${end}) for ${count} corners`);
    }
    for (let i = start; i < end; i += 3) {
      const a = vertexAt(i, requiredUvs);
      const b = vertexAt(i + 1, requiredUvs);
      const c = vertexAt(i + 2, requiredUvs);
      // A collapsed triangle must not count twice against its surviving edge.
      if (a === b || b === c || c === a) continue;
      recordEdge(a, b);
      recordEdge(b, c);
      recordEdge(c, a);
    }
  }

  for (const { forward, reverse } of edges.values()) {
    const uses = forward + reverse;
    if (uses === 1) metrics.openBoundaryEdges++;
    if (uses > 2) metrics.nonManifoldEdges++;
    if (forward > 1 || reverse > 1) metrics.windingInconsistencies++;
  }
  return metrics;
}

export function evaluateGeometryIntegrity(metrics: GeometryIntegrity, gates: GeometryIntegrityGates = {}) {
  const limits = [
    ['OPEN_BOUNDARY_EDGES', 'Open boundary edges', 'openBoundaryEdges',
      gates.requireWatertight ? 0 : gates.maxOpenBoundaryEdges],
    ['NON_MANIFOLD_EDGES', 'Non-manifold edges', 'nonManifoldEdges',
      gates.requireWatertight ? 0 : gates.maxNonManifoldEdges],
    ['MISSING_NORMALS', 'Vertices missing normals', 'missingNormals', gates.requireValidNormals ? 0 : undefined],
    ['ZERO_LENGTH_NORMALS', 'Zero-length normals', 'zeroLengthNormals', gates.requireValidNormals ? 0 : undefined],
    ['UNNORMALIZED_NORMALS', 'Non-unit normals', 'unnormalizedNormals', gates.requireValidNormals ? 0 : undefined],
    ['MISSING_UVS', 'Textured vertices missing UVs', 'missingUvs', gates.requireUvsOnTextured ? 0 : undefined],
    ['INCONSISTENT_WINDING', 'Edges with inconsistent winding', 'windingInconsistencies',
      gates.requireConsistentWinding ? 0 : undefined],
  ] as const;
  return limits.flatMap(([id, label, metric, limit]) => {
    if (limit === undefined) return [];
    const actual = metrics[metric];
    if (actual <= limit) return [];
    return [{ id, severity: 'fail' as const, message: `${label}: ${actual} (limit ${limit})`, actual, limit }];
  });
}
