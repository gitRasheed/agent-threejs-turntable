#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
git_url=$(node -p '"git+" + require("node:url").pathToFileURL(process.cwd()).href')
consumer=$(mktemp -d)
trap 'rm -rf -- "${consumer:?}"' EXIT
archive=$(npm pack --silent --pack-destination "$consumer")
mkdir "$consumer/tarball" "$consumer/git"
cd "$consumer/tarball"
npm init --yes >/dev/null
npm install --omit=dev --no-audit --no-fund "../$archive"
./node_modules/.bin/playwright install --only-shell chromium
cli=./node_modules/.bin/agent-threejs-turntable
package=./node_modules/agent-threejs-turntable
examples="$package/examples"
skill=skills/agent-threejs-turntable/SKILL.md
"$cli" skill install --project
cmp ".agents/$skill" "$package/$skill"
cmp ".claude/$skill" "$package/$skill"

"$cli" turntable "$examples/BoxVertexColors.glb" --card "$examples/pass-card.json" --out pass > pass.json
status=0
"$cli" turntable "$examples/BoxVertexColors.glb" --card "$examples/fail-card.json" --out fail > fail.json || status=$?
test "$status" -eq 1
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import fs from 'node:fs';

for (const mode of ['pass', 'fail']) {
  const report = JSON.parse(fs.readFileSync(`${mode}/report.json`, 'utf8'));
  assert.deepEqual(report, JSON.parse(fs.readFileSync(`${mode}.json`, 'utf8')));
  assert.equal(report.schemaVersion, 'agent-threejs-turntable/turntable/v1');
  assert.equal(report.cardId, `box-${mode}`);
  assert.equal(report.ok, mode === 'pass');
  assert.equal(report.metrics.trianglesByOccurrence, 12);
  assert.deepEqual(report.consoleErrors, []);
  assert.deepEqual(report.findings.filter(f => f.severity === 'fail').map(f => f.id),
    mode === 'pass' ? [] : ['TRIANGLES_OVER_BUDGET']);
  assert.equal(report.views.length, 9);
  assert.ok(report.views.every(view => view.coverageRatio > 0 && !view.edgeClipped));
  const png = fs.readFileSync(`${mode}/contact-sheet.png`);
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  console.log(`${mode}: ${report.metrics.trianglesByOccurrence} triangles, ${report.views.length} views, ${png.length} PNG bytes`);
}
JS

check_entry_points() {
  test -f "$package/dist/cli.js"
  test -f "$package/dist/index.js"
  "$cli" --help >/dev/null
  test "$("$cli" --version)" = "$(node -p "require('agent-threejs-turntable/package.json').version")"
  cat > addon.mjs <<'JS'
import { BoxGeometry } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
export default THREE => {
  if (THREE.BoxGeometry !== BoxGeometry) throw new Error('Multiple Three.js instances');
  return new THREE.Mesh(mergeGeometries([new BoxGeometry()]));
};
JS
  node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { runAssetSession, evaluateAssetGates } from 'agent-threejs-turntable';

const { metrics, consoleErrors } = await runAssetSession({ assetPath: 'addon.mjs', card: null, renderSheet: false });
assert.equal(metrics.trianglesByOccurrence, 12);
assert.deepEqual(evaluateAssetGates(metrics, null, { consoleErrors }).findings, []);
JS
}

check_entry_points
cd "$consumer/git"
npm init --yes >/dev/null
npm install --no-audit --no-fund "$git_url"
check_entry_points
