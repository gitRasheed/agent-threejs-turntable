import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { nearestPaletteMatch } from '../src/color.js';
import { evaluateAssetGates, type CheckReport, type TurntableReport } from '../src/index.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const dir = fs.mkdtempSync(path.join(root, 'dist-test', 'assets-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

function fixture(name: string, contents: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, contents);
  return file;
}

function cli(...args: string[]) {
  const result = spawnSync(process.execPath, [path.join(root, 'dist/cli.js'), ...args], {
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.ifError(result.error);
  return result;
}

function turntable(body: string, expectedExit: number): TurntableReport {
  const asset = fixture('model.mjs', 'export function buildAsset(THREE) {\n' + body + '\n}');
  const result = cli('turntable', asset, '--out', dir);
  assert.equal(result.status, expectedExit, result.stderr || result.stdout);
  return JSON.parse(result.stdout) as TurntableReport;
}

describe('turntable gates', () => {
  it('accepts a single-material lit box, including its flat orthographic faces', () => {
    const report = turntable(`return new THREE.Mesh(new THREE.BoxGeometry(),
      new THREE.MeshStandardMaterial({ color: 0xcc8844 }));`, 0);
    assert.equal(report.views.length, 9);
    assert.ok(report.views.some(view => view.ortho && view.beautyUniqueColors <= 3));
  });

  it('still rejects a one-color beauty tile with a measurable silhouette', () => {
    const report = turntable(`return new THREE.Mesh(new THREE.BoxGeometry(),
      new THREE.MeshStandardMaterial({ colorWrite: false }));`, 1);
    assert.ok(report.views.every(view => view.beautyUniqueColors === 1 && view.coverageRatio > 0.01));
    assert.ok(report.findings.some(f => f.id === 'VIEW_BEAUTY_FLAT'));
  });

  const insideOut = `const geometry = new THREE.BoxGeometry();
    geometry.index.array.reverse();`;
  it('detects reversed winding even when the far faces fill the outline', () => {
    const report = turntable(insideOut + `
      return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());`, 1);
    assert.ok(report.views.every(view => view.coverageRatio > 0.01));
    assert.ok(report.findings.some(f => f.id === 'INVERTED_WINDING' && f.severity === 'fail'));
  });

  it('respects intentionally double- and back-sided material groups', () => {
    const report = turntable(insideOut + `
      const materials = geometry.groups.map((_, i) => new THREE.MeshStandardMaterial({
        side: i % 2 ? THREE.BackSide : THREE.DoubleSide
      }));
      return new THREE.Mesh(geometry, materials);`, 0);
    assert.equal(report.findings.length, 0);
  });
});

describe('CLI inputs and palette gates', () => {
  it('exits 2 when a factory never resolves', () => {
    const factory = fixture('pending.mjs', 'export function buildAsset() { return new Promise(() => {}); }');
    const result = cli('check', factory, '--timeout', '500');
    assert.equal(result.status, 2);
    assert.match(result.stderr, /timed out.*500 ms/i);
  });

  it('also bounds module loading during a turntable', () => {
    const factory = fixture('pending-import.mjs', 'await new Promise(() => {}); export default () => {};');
    const result = cli('turntable', factory, '--out', dir, '--timeout', '500');
    assert.equal(result.status, 2);
    assert.match(result.stderr, /timed out.*500 ms/i);
  });

  it('rejects JSON glTF with a single CLI diagnostic', () => {
    const result = cli('check', fixture('external.gltf', '{"asset":{"version":"2.0"}}'));
    assert.equal(result.status, 2);
    assert.match(JSON.parse(result.stderr).message, /unsupported.*\.gltf.*\.glb/i);
  });

  it('includes emissive intensity in the shared browser and Node palette calculation', () => {
    const asset = fixture('emissive.mjs', `export function buildAsset(THREE) {
      return new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({
        color: 0x000000, emissive: new THREE.Color().setRGB(0.25, 0, 0.25), emissiveIntensity: 3
      }));
    }`);
    const card = fixture('ink.json', JSON.stringify({
      id: 'ink', palette: { ink: '#000000' }, paletteDeltaE76Max: 1
    }));
    const result = cli('check', asset, '--card', card);
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout) as CheckReport;
    const expected = nearestPaletteMatch([0.75, 0, 0.75], { ink: '#000000' });
    assert.equal(report.metrics.palette.maxDeltaE76, expected.deltaE76);
    assert.ok(report.findings.some(f => f.id === 'PALETTE_DELTA_E_EXCEEDED'));
  });

  it('names each GLB-only budget skipped on a factory and enforces GLB bytes on a GLB', () => {
    const asset = fixture('budget.mjs', `export function buildAsset(THREE) {
      return new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    }`);
    const factory = cli('check', asset);
    const glb = cli('check', path.join(root, 'examples/BoxVertexColors.glb'));
    assert.equal(factory.status, 0);
    assert.equal(glb.status, 0);
    const { metrics } = JSON.parse(factory.stdout) as CheckReport;
    for (const budgets of [{ bytesMax: 0 }, { requireTriangleLists: true }]) {
      const result = evaluateAssetGates(metrics, { id: 'budget', budgets });
      assert.equal(result.ok, true);
      const [key] = Object.keys(budgets);
      assert.ok(key);
      assert.ok(result.findings.some(f => f.severity === 'info' && f.message.includes(key)));
    }
    const result = evaluateAssetGates(JSON.parse(glb.stdout).metrics, { id: 'budget', budgets: { bytesMax: 0 } });
    assert.deepEqual(result.findings.map(f => f.id), ['GLB_BYTES_OVER_BUDGET']);
  });
});

it('packages the CLI, browser color module, and guides with Three.js as a peer', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(manifest.peerDependencies.three);
  assert.equal(manifest.peerDependencies.three, manifest.devDependencies.three);
  assert.equal(manifest.dependencies.three, undefined);
  const pack = spawnSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], { cwd: root, encoding: 'utf8' });
  assert.equal(pack.status, 0, pack.stderr);
  const files = JSON.parse(pack.stdout)[0].files.map((file: { path: string }) => file.path);
  for (const name of ['dist/cli.js', 'dist/color.js', 'dist/evaluate.js', 'dist/harness.js', 'dist/gpuProbe.js', 'dist/index.d.ts', 'README.md', 'skills/agent-threejs-turntable/SKILL.md', 'examples/BoxVertexColors.glb',
    'examples/BoxVertexColors.LICENSE.txt', 'examples/pass-card.json', 'examples/fail-card.json', 'LICENSE']) {
    assert.ok(files.includes(name), `Missing ${name} from tarball`);
  }
});

for (const order of [[0, 0.0001], [0.0001, 0]]) {
  it(`scores both linear colors that round to black, in mesh order ${order}`, () => {
    const asset = fixture('rounded.mjs', `export default THREE => {
      const root = new THREE.Group();
      for (const r of ${JSON.stringify(order)}) {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial({
          color: new THREE.Color(r, 0, 0)
        }));
        mesh.name = String(r);
        root.add(mesh);
      }
      return root;
    };`);
    const palette = { ink: '#000000' };
    const expected = nearestPaletteMatch([0.0001, 0, 0], palette).deltaE76;
    const card = fixture('rounded.json', JSON.stringify({ id: 'rounded', palette, paletteDeltaE76Max: expected / 2 }));
    const result = cli('check', asset, '--card', card);
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(result.stdout) as CheckReport;
    assert.equal(report.metrics.palette.maxDeltaE76, expected);
    assert.equal(report.metrics.palette.worstViolation?.meshName, '0.0001');
    assert.deepEqual(report.metrics.palette.colors, [{
      hexSrgb: '#000000', samples: 2, meshes: ['0', '0.0001'], nearestRole: 'ink', nearestHex: '#000000', deltaE76: expected,
    }]);
  });
}

it('keeps the sheet and independent findings for an empty asset', () => {
  const asset = fixture('empty.mjs', `export default THREE => {
    console.error('empty factory');
    return new THREE.Group();
  };`);
  const card = fixture('empty.json', JSON.stringify({
    id: 'empty', palette: { a: '#000000', b: '#000000' }, paletteDeltaE76Max: 1,
    separationRoles: [['a', 'b']], separationMinDeltaE76: 1,
  }));
  const result = cli('turntable', asset, '--card', card, '--out', dir);
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout) as TurntableReport;
  assert.deepEqual(report.findings.map(f => f.id).sort(), ['CONSOLE_ERROR', 'EMPTY_GEOMETRY', 'ROLE_SEPARATION_LOW']);
  assert.deepEqual(report.consoleErrors, ['empty factory']);
  assert.equal(report.views.length, 9);
  assert.equal(fs.readFileSync(report.contactSheetPath).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
});
