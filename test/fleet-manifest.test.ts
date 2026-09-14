import { cpSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROJECT_ROOT } from './helpers/cli.js';

function filesUnder(root: string, current = root): string[] {
  return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const path = join(current, entry.name);
    if (entry.isDirectory()) return filesUnder(root, path);
    return entry.isFile() ? [relative(root, path)] : [];
  }).sort();
}

function renderedManifest(fleetRoot: string): string {
  return filesUnder(fleetRoot)
    .filter((path) => path !== 'MANIFEST.sha256')
    .map((path) => `${createHash('sha256').update(readFileSync(join(fleetRoot, path))).digest('hex')}  ${path}`)
    .join('\n') + '\n';
}

function expectManifestMatches(fleetRoot: string): void {
  expect(statSync(fleetRoot).isDirectory()).toBe(true);
  expect(readFileSync(join(fleetRoot, 'MANIFEST.sha256'), 'utf8')).toBe(renderedManifest(fleetRoot));
}

describe('fleet parity manifest', () => {
  it('matches every regular asset in the real fleet tree', () => {
    expectManifestMatches(join(PROJECT_ROOT, 'fleet'));
  });

  it('rejects a tampered byte in a copied fleet tree', () => {
    const copiedFleet = join(mkdtempSync(join(tmpdir(), 'heddle-fleet-manifest-test-')), 'fleet');
    cpSync(join(PROJECT_ROOT, 'fleet'), copiedFleet, { recursive: true });
    writeFileSync(join(copiedFleet, 'bin', 'lin.sh'), 'tampered\n');
    expect(() => expectManifestMatches(copiedFleet)).toThrow();
  });
});
