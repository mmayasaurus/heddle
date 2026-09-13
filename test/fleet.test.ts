import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { diffFleetHooks, installFleetHooks } from '../src/fleet.js';
import { useTempResources } from './helpers.js';

function fixture(base: string) {
  const canonicalDir = join(base, 'canonical-hooks');
  const homeDir = join(base, 'home');
  mkdirSync(canonicalDir, { recursive: true });
  writeFileSync(join(canonicalDir, 'first.py'), '#!/usr/bin/env python3\nprint("first")\n');
  writeFileSync(join(canonicalDir, 'second.py'), 'print("second")\n');
  chmodSync(join(canonicalDir, 'first.py'), 0o755);
  return { canonicalDir, homeDir, targetDir: join(homeDir, '.heddle', 'fleet', 'hooks') };
}

describe('fleet hooks', () => {
  const { tempDir } = useTempResources('heddle-fleet-hooks-test-');

  it('installs canonical hooks atomically with executable modes and reports content actions', () => {
    const paths = fixture(tempDir());
    expect(installFleetHooks(paths).files).toEqual([
      { name: 'first.py', action: 'created' },
      { name: 'second.py', action: 'created' },
    ]);
    expect(readFileSync(join(paths.targetDir, 'first.py'), 'utf8')).toContain('print("first")');
    expect(readFileSync(join(paths.targetDir, 'second.py'), 'utf8')).toContain('print("second")');
    expect(statSync(join(paths.targetDir, 'first.py')).mode & 0o111).toBe(0o111);
    expect(statSync(join(paths.targetDir, 'second.py')).mode & 0o111).toBe(0);
    expect(existsSync(join(paths.targetDir, '.first.py.tmp'))).toBe(false);
    expect((readFileSync(join(paths.targetDir, 'first.py')).length > 0)).toBe(true);
    expect(installFleetHooks(paths).files.every((file) => file.action === 'unchanged')).toBe(true);
    writeFileSync(join(paths.targetDir, 'second.py'), 'changed\n');
    expect(installFleetHooks(paths).files).toContainEqual({ name: 'second.py', action: 'updated' });
  });

  it('reports dry-run actions without creating an installation directory', () => {
    const paths = fixture(tempDir());
    expect(installFleetHooks({ ...paths, dryRun: true }).files.every((file) => file.action === 'created')).toBe(true);
    expect(existsSync(paths.targetDir)).toBe(false);
  });

  it('reports missing and differing installed hooks as drift', () => {
    const paths = fixture(tempDir());
    installFleetHooks(paths);
    writeFileSync(join(paths.targetDir, 'second.py'), 'different\n');
    writeFileSync(join(paths.targetDir, 'extra.py'), 'ignored\n');
    expect(diffFleetHooks(paths)).toEqual({ clean: false, files: [
      { name: 'second.py', action: 'differing' },
    ] });
  });
});
