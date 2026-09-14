import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { diffFleetLaunchers, installFleetLaunchers } from '../src/fleet.js';
import { useTempResources } from './helpers.js';
import { runCli, withTempHome } from './helpers/cli.js';

// Fixture names are deliberately NEUTRAL (this file ships in the standalone snapshot and the
// public scrub rejects tenant fragments); the engine discovers *.sh dynamically, so unit
// behavior is name-independent. The CLI test below runs against the real vendored canon and
// asserts counts/shapes, never real launcher names.
const LAUNCHERS = [
  'launcher-alpha.sh',
  'launcher-bravo.sh',
  'launcher-charlie.sh',
  'launcher-delta.sh',
  'launcher-echo.sh',
];

// Fault injection for the atomic-rename path: the pre-copy non-regular-target guard fires
// before any temp exists, so proving the try/finally temp cleanup needs a fault AFTER the
// temp write. Scoped by suffix and reset in finally; passthrough otherwise.
const renameFault = vi.hoisted(() => ({ pathSuffix: '' }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync: (from: Parameters<typeof actual.renameSync>[0], to: Parameters<typeof actual.renameSync>[1]) => {
      if (renameFault.pathSuffix && String(to).endsWith(renameFault.pathSuffix)) {
        throw new Error(`EXDEV: forced rename fault for ${String(to)}`);
      }
      return actual.renameSync(from, to);
    },
  };
});

function fixture(base: string) {
  const canonicalDir = join(base, 'canonical-launchers');
  const homeDir = join(base, 'home');
  mkdirSync(canonicalDir, { recursive: true });
  for (const name of LAUNCHERS) {
    writeFileSync(join(canonicalDir, name), `#!/usr/bin/env bash\necho ${name}\n`);
    chmodSync(join(canonicalDir, name), 0o755);
  }
  return { canonicalDir, homeDir, targetDir: join(homeDir, '.heddle', 'fleet', 'launchers') };
}

describe('fleet launchers', () => {
  const { tempDir } = useTempResources('heddle-fleet-launchers-test-');

  it('installs all launchers atomically with executable modes and rewrites changed bytes', () => {
    const paths = fixture(tempDir());
    expect(installFleetLaunchers(paths).files).toEqual([...LAUNCHERS].sort().map((name) => ({ name, action: 'created' })));
    for (const name of LAUNCHERS) {
      expect(statSync(join(paths.targetDir, name)).mode & 0o777).toBe(0o755);
    }
    expect(readdirSync(paths.targetDir).filter((name) => /\.tmp$/.test(name))).toEqual([]);
    writeFileSync(join(paths.targetDir, 'launcher-bravo.sh'), 'changed\n');
    expect(installFleetLaunchers(paths).files).toContainEqual({ name: 'launcher-bravo.sh', action: 'updated' });
    expect(readFileSync(join(paths.targetDir, 'launcher-bravo.sh'))).toEqual(readFileSync(join(paths.canonicalDir, 'launcher-bravo.sh')));
  });

  it('reports missing files and mode drift, then restores the canonical mode', () => {
    const paths = fixture(tempDir());
    installFleetLaunchers(paths);
    unlinkSync(join(paths.targetDir, 'launcher-delta.sh'));
    chmodSync(join(paths.targetDir, 'launcher-bravo.sh'), 0o644);
    expect(diffFleetLaunchers(paths)).toEqual({ clean: false, files: [
      { name: 'launcher-bravo.sh', action: 'differing' },
      { name: 'launcher-delta.sh', action: 'missing' },
    ] });
    expect(installFleetLaunchers(paths).files).toContainEqual({ name: 'launcher-bravo.sh', action: 'updated' });
    expect(statSync(join(paths.targetDir, 'launcher-bravo.sh')).mode & 0o777).toBe(0o755);
  });

  it('cleans no temporary files after a forced failure and has dry-run failure parity', () => {
    const paths = fixture(tempDir());
    mkdirSync(paths.targetDir, { recursive: true });
    mkdirSync(join(paths.targetDir, 'launcher-charlie.sh'));
    let error: unknown;
    try {
      installFleetLaunchers(paths);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('fleet launcher installation failed for launcher-charlie.sh');
    expect((error as Error).message).toContain('files written this run: launcher-alpha.sh, launcher-bravo.sh; unchanged: none');
    expect(readFileSync(join(paths.targetDir, 'launcher-alpha.sh'))).toEqual(readFileSync(join(paths.canonicalDir, 'launcher-alpha.sh')));
    expect(readdirSync(paths.targetDir).filter((name) => /\.tmp$/.test(name))).toEqual([]);
    let dryRunError: unknown;
    try {
      installFleetLaunchers({ ...paths, dryRun: true });
    } catch (caught) {
      dryRunError = caught;
    }
    expect(dryRunError).toBeInstanceOf(Error);
    expect((dryRunError as Error).message).toContain(`target exists and is not a regular file: ${join(paths.targetDir, 'launcher-charlie.sh')}`);
    expect((dryRunError as Error).message).toContain('files written this run: none (dry run — planned: none); unchanged: launcher-alpha.sh, launcher-bravo.sh');
    expect(readdirSync(paths.targetDir).filter((name) => /\.tmp$/.test(name))).toEqual([]);
  });

  it('reports planned files honestly when a fresh dry run fails partway', () => {
    const paths = fixture(tempDir());
    mkdirSync(paths.targetDir, { recursive: true });
    mkdirSync(join(paths.targetDir, 'launcher-charlie.sh'));
    let error: unknown;
    try {
      installFleetLaunchers({ ...paths, dryRun: true });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(`target exists and is not a regular file: ${join(paths.targetDir, 'launcher-charlie.sh')}`);
    expect((error as Error).message).toContain('files written this run: none (dry run — planned: launcher-alpha.sh, launcher-bravo.sh); unchanged: none');
    expect(readdirSync(paths.targetDir).filter((name) => name !== 'launcher-charlie.sh')).toEqual([]);
  });

  it('cleans the temp file when the atomic rename itself fails mid-install', () => {
    const paths = fixture(tempDir());
    renameFault.pathSuffix = 'launcher-bravo.sh';
    try {
      let error: unknown;
      try {
        installFleetLaunchers(paths);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('fleet launcher installation failed for launcher-bravo.sh');
      expect((error as Error).message).toContain('files written this run: launcher-alpha.sh; unchanged: none');
      expect(readdirSync(paths.targetDir).filter((name) => /\.tmp$/.test(name))).toEqual([]);
      expect(existsSync(join(paths.targetDir, 'launcher-bravo.sh'))).toBe(false);
    } finally {
      renameFault.pathSuffix = '';
    }
  });

  it('refuses an empty canon and a canon holding non-regular .sh entries', () => {
    const base = tempDir();
    const homeDir = join(base, 'home');
    const emptyCanon = join(base, 'empty-canon');
    mkdirSync(emptyCanon, { recursive: true });
    expect(() => installFleetLaunchers({ canonicalDir: emptyCanon, homeDir })).toThrow(`fleet launcher canon is empty: ${emptyCanon}`);
    expect(() => diffFleetLaunchers({ canonicalDir: emptyCanon, homeDir })).toThrow(`fleet launcher canon is empty: ${emptyCanon}`);
    const irregularCanon = join(base, 'irregular-canon');
    mkdirSync(join(irregularCanon, 'not-a-file.sh'), { recursive: true });
    writeFileSync(join(irregularCanon, 'real.sh'), '#!/usr/bin/env bash\n');
    expect(() => diffFleetLaunchers({ canonicalDir: irregularCanon, homeDir })).toThrow(`fleet canon entries at ${irregularCanon} are not regular files: not-a-file.sh`);
  });

  it('reports launcher CLI text, JSON, drift, and usage exit contracts', async () => {
    const home = withTempHome();
    const targetDir = join(home, '.heddle', 'fleet', 'launchers');
    const installed = await runCli(['fleet', 'install-launchers'], { home });
    expect(installed.code).toBe(0);
    expect(installed.stdout).toContain(`target: ${targetDir}`);
    const installedNames = readdirSync(targetDir).filter((name) => name.endsWith('.sh')).sort();
    expect(installedNames).toHaveLength(5);
    const installedJson = await runCli(['fleet', 'install-launchers', '--json'], { home });
    expect(JSON.parse(installedJson.stdout)).toEqual(expect.objectContaining({ dryRun: false, targetDir, files: expect.any(Array) }));
    expect(JSON.parse(installedJson.stdout).files).toHaveLength(5);
    const [firstName] = installedNames;
    writeFileSync(join(targetDir, firstName), 'drift\n');
    const drift = await runCli(['fleet', 'launchers-diff', '--json'], { home });
    expect(drift.code).toBe(1);
    expect(JSON.parse(drift.stdout)).toEqual({ clean: false, files: expect.arrayContaining([{ name: firstName, action: 'differing' }]) });
    await runCli(['fleet', 'install-launchers'], { home });
    const clean = await runCli(['fleet', 'launchers-diff', '--json'], { home });
    expect(clean.code).toBe(0);
    expect(JSON.parse(clean.stdout)).toEqual({ clean: true, files: [] });
    expect((await runCli(['fleet', 'unknown-action'], { home })).code).toBe(2);

    const dryRunHome = withTempHome();
    const dryRunText = await runCli(['fleet', 'install-launchers', '--dry-run'], { home: dryRunHome });
    expect(dryRunText.code).toBe(0);
    expect(dryRunText.stdout).toContain(`target: ${join(dryRunHome, '.heddle', 'fleet', 'launchers')}`);
    const dryRunLines = dryRunText.stdout.split('\n').slice(1).filter(Boolean);
    expect(dryRunLines).toHaveLength(5);
    expect(dryRunLines.every((line) => line.startsWith('would create '))).toBe(true);
    const dryRun = await runCli(['fleet', 'install-launchers', '--dry-run', '--json'], { home: dryRunHome });
    expect(dryRun.code).toBe(0);
    expect(JSON.parse(dryRun.stdout)).toEqual(expect.objectContaining({
      dryRun: true,
      targetDir: join(dryRunHome, '.heddle', 'fleet', 'launchers'),
      files: expect.any(Array),
    }));
    expect(JSON.parse(dryRun.stdout).files).toHaveLength(5);
    expect(existsSync(join(dryRunHome, '.heddle', 'fleet', 'launchers'))).toBe(false);
  });
});
