import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { diffFleetHooks, installFleetHooks } from '../src/fleet.js';
import { useTempResources } from './helpers.js';
import { runCli, withTempHome } from './helpers/cli.js';

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
    expect(readdirSync(paths.targetDir).filter((name) => /\.tmp$/.test(name))).toEqual([]);
    expect((readFileSync(join(paths.targetDir, 'first.py')).length > 0)).toBe(true);
    expect(installFleetHooks(paths).files.every((file) => file.action === 'unchanged')).toBe(true);
    writeFileSync(join(paths.targetDir, 'second.py'), 'changed\n');
    expect(installFleetHooks(paths).files).toContainEqual({ name: 'second.py', action: 'updated' });
    expect(readFileSync(join(paths.targetDir, 'second.py'))).toEqual(readFileSync(join(paths.canonicalDir, 'second.py')));
  });

  it('reports dry-run actions without creating an installation directory', () => {
    const paths = fixture(tempDir());
    const report = installFleetHooks({ ...paths, dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.files.every((file) => file.action === 'created')).toBe(true);
    expect(existsSync(paths.targetDir)).toBe(false);
  });

  it('reports missing and differing installed hooks as drift', () => {
    const paths = fixture(tempDir());
    installFleetHooks(paths);
    unlinkSync(join(paths.targetDir, 'first.py'));
    writeFileSync(join(paths.targetDir, 'second.py'), 'different\n');
    writeFileSync(join(paths.targetDir, 'extra.py'), 'ignored\n');
    expect(diffFleetHooks(paths)).toEqual({ clean: false, files: [
      { name: 'first.py', action: 'missing' },
      { name: 'second.py', action: 'differing' },
    ] });
  });

  it('treats permission-bit drift as differing and restores the canonical mode', () => {
    const paths = fixture(tempDir());
    installFleetHooks(paths);
    chmodSync(join(paths.targetDir, 'first.py'), 0o644);
    expect(diffFleetHooks(paths)).toEqual({ clean: false, files: [
      { name: 'first.py', action: 'differing' },
    ] });
    expect(installFleetHooks(paths).files).toContainEqual({ name: 'first.py', action: 'updated' });
    expect(statSync(join(paths.targetDir, 'first.py')).mode & 0o777).toBe(0o755);
  });

  it('reports partial installation when a target path is not a regular file without writing during dry-run', () => {
    const paths = fixture(tempDir());
    mkdirSync(paths.targetDir, { recursive: true });
    mkdirSync(join(paths.targetDir, 'second.py'));
    let error: unknown;
    try {
      installFleetHooks(paths);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/second\.py/);
    expect((error as Error).message).toContain('files written this run: first.py; unchanged: none');
    expect((error as Error).message).toContain(`target exists and is not a regular file: ${join(paths.targetDir, 'second.py')}`);
    expect(readFileSync(join(paths.targetDir, 'first.py'))).toEqual(readFileSync(join(paths.canonicalDir, 'first.py')));
    expect(readdirSync(paths.targetDir).filter((name) => /\.tmp$/.test(name))).toEqual([]);
    expect(() => installFleetHooks({ ...paths, dryRun: true })).toThrow(`target exists and is not a regular file: ${join(paths.targetDir, 'second.py')}`);
  });

  it('reports fleet CLI text and JSON contracts for installs and drift', async () => {
    const home = withTempHome();
    const installed = await runCli(['fleet', 'install-hooks'], { home });
    expect(installed.code).toBe(0);
    const targetDir = join(home, '.heddle', 'fleet', 'hooks');
    expect(installed.stdout).toContain(`target: ${targetDir}`);
    const installedJson = await runCli(['fleet', 'install-hooks', '--json'], { home });
    expect(JSON.parse(installedJson.stdout)).toEqual(expect.objectContaining({
      dryRun: false,
      targetDir,
      files: expect.any(Array),
    }));

    writeFileSync(join(targetDir, 'agent-identity.py'), 'drift\n');
    const drift = await runCli(['fleet', 'hooks-diff', '--json'], { home });
    expect(drift.code).toBe(1);
    expect(JSON.parse(drift.stdout)).toEqual({
      clean: false,
      files: expect.arrayContaining([{ name: 'agent-identity.py', action: 'differing' }]),
    });
    await runCli(['fleet', 'install-hooks'], { home });
    const clean = await runCli(['fleet', 'hooks-diff', '--json'], { home });
    expect(clean.code).toBe(0);
    expect(JSON.parse(clean.stdout)).toEqual({ clean: true, files: [] });
    expect((await runCli(['fleet', 'unknown-action'], { home })).code).toBe(2);

    const dryRunHome = withTempHome();
    const dryRunText = await runCli(['fleet', 'install-hooks', '--dry-run'], { home: dryRunHome });
    expect(dryRunText.stdout).toContain(`target: ${join(dryRunHome, '.heddle', 'fleet', 'hooks')}`);
    expect(dryRunText.stdout.split('\n').slice(1).filter(Boolean).every((line) => line.startsWith('would '))).toBe(true);
    const dryRun = await runCli(['fleet', 'install-hooks', '--dry-run', '--json'], { home: dryRunHome });
    expect(dryRun.code).toBe(0);
    expect(JSON.parse(dryRun.stdout)).toEqual(expect.objectContaining({
      dryRun: true,
      targetDir: join(dryRunHome, '.heddle', 'fleet', 'hooks'),
      files: expect.any(Array),
    }));
    expect(existsSync(join(dryRunHome, '.heddle', 'fleet', 'hooks'))).toBe(false);
  });
});
