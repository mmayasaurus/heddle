import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'fleet');
const manifestPath = join(root, 'MANIFEST.sha256');

function filesUnder(current = root) {
  return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const path = join(current, entry.name);
    if (entry.isDirectory()) return filesUnder(path);
    return entry.isFile() && path !== manifestPath ? [relative(root, path)] : [];
  }).sort();
}

const manifest = filesUnder()
  .map((path) => `${createHash('sha256').update(readFileSync(join(root, path))).digest('hex')}  ${path}`)
  .join('\n') + '\n';
writeFileSync(manifestPath, manifest);
