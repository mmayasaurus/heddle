import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { diffFleetLaunchers, installFleetLaunchers } from '../src/fleet.js';
import { useTempResources } from './helpers.js';
import { runCli, withTempHome } from './helpers/cli.js';

const LAUNCHERS = [
  'resume-sessions-v2.sh',
  'resume-sessions-hed.sh',
  'resume-sessions-spi.sh',
  'resume-sessions-gpt.sh',
  'fleet-relaunch.sh',
];

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
    writeFileSync(join(paths.targetDir, 'resume-sessions-hed.sh'), 'changed\n');
    expect(installFleetLaunchers(paths).files).toContainEqual({ name: 'resume-sessions-hed.sh', action: 'updated' });
    expect(readFileSync(join(paths.targetDir, 'resume-sessions-hed.sh'))).toEqual(readFileSync(join(paths.canonicalDir, 'resume-sessions-hed.sh')));
  });

  it('reports missing files and mode drift, then restores the canonical mode', () => {
    const paths = fixture(tempDir());
    installFleetLaunchers(paths);
    unlinkSync(join(paths.targetDir, 'resume-sessions-gpt.sh'));
    chmodSync(join(paths.targetDir, 'resume-sessions-hed.sh'), 0o644);
    expect(diffFleetLaunchers(paths)).toEqual({ clean: false, files: [
      { name: 'resume-sessions-gpt.sh', action: 'missing' },
      { name: 'resume-sessions-hed.sh', action: 'differing' },
    ] });
    expect(installFleetLaunchers(paths).files).toContainEqual({ name: 'resume-sessions-hed.sh', action: 'updated' });
    expect(statSync(join(paths.targetDir, 'resume-sessions-hed.sh')).mode & 0o777).toBe(0o755);
  });

  it('cleans no temporary files after a forced failure and has dry-run failure parity', () => {
    const paths = fixture(tempDir());
    mkdirSync(paths.targetDir, { recursive: true });
    mkdirSync(join(paths.targetDir, 'resume-sessions-hed.sh'));
    let error: unknown;
    try {
      installFleetLaunchers(paths);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('fleet launcher installation failed for resume-sessions-hed.sh');
    expect((error as Error).message).toContain('files written this run: fleet-relaunch.sh, resume-sessions-gpt.sh; unchanged: none');
    expect(readFileSync(join(paths.targetDir, 'fleet-relaunch.sh'))).toEqual(readFileSync(join(paths.canonicalDir, 'fleet-relaunch.sh')));
    expect(readdirSync(paths.targetDir).filter((name) => /\.tmp$/.test(name))).toEqual([]);
    expect(() => installFleetLaunchers({ ...paths, dryRun: true })).toThrow(`target exists and is not a regular file: ${join(paths.targetDir, 'resume-sessions-hed.sh')}`);
    expect(readdirSync(paths.targetDir).filter((name) => /\.tmp$/.test(name))).toEqual([]);
  });

  it('reports launcher CLI text, JSON, drift, and usage exit contracts', async () => {
    const home = withTempHome();
    const targetDir = join(home, '.heddle', 'fleet', 'launchers');
    const installed = await runCli(['fleet', 'install-launchers'], { home });
    expect(installed.code).toBe(0);
    expect(installed.stdout).toContain(`target: ${targetDir}`);
    expect(LAUNCHERS.every((name) => existsSync(join(targetDir, name)))).toBe(true);
    const installedJson = await runCli(['fleet', 'install-launchers', '--json'], { home });
    expect(JSON.parse(installedJson.stdout)).toEqual(expect.objectContaining({ dryRun: false, targetDir, files: expect.any(Array) }));
    writeFileSync(join(targetDir, 'fleet-relaunch.sh'), 'drift\n');
    const drift = await runCli(['fleet', 'launchers-diff', '--json'], { home });
    expect(drift.code).toBe(1);
    expect(JSON.parse(drift.stdout)).toEqual({ clean: false, files: expect.arrayContaining([{ name: 'fleet-relaunch.sh', action: 'differing' }]) });
    await runCli(['fleet', 'install-launchers'], { home });
    const clean = await runCli(['fleet', 'launchers-diff', '--json'], { home });
    expect(clean.code).toBe(0);
    expect(JSON.parse(clean.stdout)).toEqual({ clean: true, files: [] });
    expect((await runCli(['fleet', 'unknown-action'], { home })).code).toBe(2);

    const dryRunHome = withTempHome();
    const dryRunText = await runCli(['fleet', 'install-launchers', '--dry-run'], { home: dryRunHome });
    expect(dryRunText.stdout).toContain(`target: ${join(dryRunHome, '.heddle', 'fleet', 'launchers')}`);
    expect(dryRunText.stdout.split('\n').slice(1).filter(Boolean).every((line) => line.startsWith('would '))).toBe(true);
    const dryRun = await runCli(['fleet', 'install-launchers', '--dry-run', '--json'], { home: dryRunHome });
    expect(dryRun.code).toBe(0);
    expect(JSON.parse(dryRun.stdout)).toEqual(expect.objectContaining({
      dryRun: true,
      targetDir: join(dryRunHome, '.heddle', 'fleet', 'launchers'),
      files: expect.any(Array),
    }));
    expect(existsSync(join(dryRunHome, '.heddle', 'fleet', 'launchers'))).toBe(false);
  });
});
