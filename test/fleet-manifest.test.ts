import { cpSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { PROJECT_ROOT } from './helpers/cli.js';

function filesUnder(root: string, current = root): string[] {
  return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const path = join(current, entry.name);
    if (entry.isDirectory()) return filesUnder(root, path);
    if (entry.isFile()) return [relative(root, path).split(sep).join('/')];
    throw new Error(`fleet manifest: non-regular entry at ${relative(root, path).split(sep).join('/')}`);
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

  it('rejects a non-regular entry in a copied fleet tree', () => {
    const copiedFleet = join(mkdtempSync(join(tmpdir(), 'heddle-fleet-manifest-test-')), 'fleet');
    cpSync(join(PROJECT_ROOT, 'fleet'), copiedFleet, { recursive: true });
    symlinkSync('/tmp/x', join(copiedFleet, 'bin', 'smuggle'));
    expect(() => expectManifestMatches(copiedFleet)).toThrow('fleet manifest: non-regular entry at bin/smuggle');
    const generator = spawnSync(process.execPath, [join(PROJECT_ROOT, 'scripts', 'fleet-manifest.mjs'), copiedFleet], { encoding: 'utf8' });
    expect(generator.status).toBe(1);
    expect(generator.stderr).toContain('fleet manifest: non-regular entry at bin/smuggle');
  });

  it('script no-op output matches the test renderer and committed manifest', () => {
    const copiedFleet = join(mkdtempSync(join(tmpdir(), 'heddle-fleet-manifest-test-')), 'fleet');
    cpSync(join(PROJECT_ROOT, 'fleet'), copiedFleet, { recursive: true });
    execFileSync(process.execPath, [join(PROJECT_ROOT, 'scripts', 'fleet-manifest.mjs'), copiedFleet]);
    const generated = readFileSync(join(copiedFleet, 'MANIFEST.sha256'), 'utf8');
    expect(generated).toBe(renderedManifest(copiedFleet));
    expect(generated).toBe(readFileSync(join(PROJECT_ROOT, 'fleet', 'MANIFEST.sha256'), 'utf8'));
  });
});
