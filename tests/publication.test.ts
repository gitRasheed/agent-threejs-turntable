import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { it, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const skill = 'skills/agent-3d/SKILL.md';

function sandbox(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-3d-install-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  const project = path.join(dir, 'project');
  fs.mkdirSync(home);
  fs.mkdirSync(project);
  function cli(...args: string[]) {
    const run = spawnSync(process.execPath, [path.join(root, 'dist/cli.js'), ...args], {
      cwd: project, env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8',
    });
    assert.ifError(run.error);
    return run;
  }
  return { project, home, cli };
}

for (const projectOnly of [true, false]) {
  it(`installs both skills in the ${projectOnly ? 'project' : 'home'} and accepts a repeat install`, (t) => {
    const { project, home, cli } = sandbox(t);
    const args = projectOnly ? ['--project'] : [];
    const target = projectOnly ? project : home;
    const other = projectOnly ? home : project;
    const first = cli('skill', 'install', ...args);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(cli('skill', 'install', ...args).status, 0);
    for (const host of ['.agents', '.claude']) {
      assert.deepEqual(fs.readFileSync(path.join(target, host, skill)), fs.readFileSync(path.join(root, skill)));
      assert.equal(fs.existsSync(path.join(other, host)), false);
    }
  });
}

it('preserves a conflicting skill and checks both destinations before installing', (t) => {
  const { project, cli } = sandbox(t);
  const existing = path.join(project, '.claude', skill);
  fs.mkdirSync(path.dirname(existing), { recursive: true });
  fs.writeFileSync(existing, 'local instructions');
  const result = cli('skill', 'install', '--project');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /existing.*SKILL\.md/i);
  assert.equal(fs.readFileSync(existing, 'utf8'), 'local instructions');
  assert.equal(fs.existsSync(path.join(project, '.agents', skill)), false);
});

function boxWithExtensions(file: string, used: string[], required: string[]) {
  const box = fs.readFileSync(path.join(root, 'examples/BoxVertexColors.glb'));
  const binStart = 20 + box.readUInt32LE(12);
  const original: Record<string, unknown> = JSON.parse(box.toString('utf8', 20, binStart));
  const json = Buffer.from(JSON.stringify({ ...original, extensionsUsed: used, extensionsRequired: required }));
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20);
  json.copy(padded);
  const glb = Buffer.concat([box.subarray(0, 20), padded, box.subarray(binStart)]);
  glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(padded.length, 12);
  fs.writeFileSync(file, glb);
}

for (const [extension, remedy] of [
  ['KHR_draco_mesh_compression', /without Draco/i],
  ['EXT_meshopt_compression', /without Meshopt/i],
  ['KHR_texture_basisu', /PNG or JPEG/i],
] as const) {
  it(`returns an actionable exit 2 for required ${extension}`, (t) => {
    const { project, cli } = sandbox(t);
    const file = path.join(project, 'required.glb');
    boxWithExtensions(file, [extension], [extension]);
    const result = cli('check', file);
    assert.equal(result.status, 2);
    const { message } = JSON.parse(result.stderr) as { message: string };
    assert.ok(message.includes(extension), message);
    assert.match(message, remedy);
  });
}

it('loads the uncompressed fallback for optional Meshopt', (t) => {
  const { project, cli } = sandbox(t);
  const file = path.join(project, 'optional.glb');
  boxWithExtensions(file, ['EXT_meshopt_compression'], []);
  const result = cli('check', file);
  assert.equal(result.status, 0, result.stderr);
});

for (const summary of ['summary.json', 'summary.txt']) {
  it(`rejects a card at the batch output ${summary} before rendering`, (t) => {
    const { project, cli } = sandbox(t);
    const card = path.join(project, summary);
    const contents = '{"id":"keep"}';
    fs.writeFileSync(card, contents);
    const result = cli('batch', path.join(root, 'examples'), '--card', card, '--out', project);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /overwrite input/);
    assert.equal(fs.readFileSync(card, 'utf8'), contents);
    assert.equal(fs.existsSync(path.join(project, 'BoxVertexColors')), false);
  });
}
