import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../skills/agent-threejs-turntable/SKILL.md', import.meta.url));

export function installSkill(root: string): string[] {
  const destinations = ['.agents', '.claude'].map(host => path.join(root, host, 'skills', 'agent-threejs-turntable', 'SKILL.md'));
  const contents = fs.readFileSync(source);
  const missing = destinations.filter(file => {
    if (fs.lstatSync(file, { throwIfNoEntry: false }) === undefined) return true;
    if (fs.readFileSync(file).equals(contents)) return false;
    throw new Error(`Refusing to overwrite existing skill at ${file}. Move it aside to install the packaged version.`);
  });
  for (const file of missing) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(source, file, fs.constants.COPYFILE_EXCL);
  }
  return destinations;
}
