import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { installFleetHooks, uninstallFleetHooks } from '../src/fleet.js';
import { useTempResources } from './helpers.js';
import { runCli, withTempHome } from './helpers/cli.js';

describe('uninstall', () => {
  const { tempDir } = useTempResources('heddle-uninstall-test-');

  it('removes only unmodified fleet assets, preserves edits, and is idempotent', async () => {
    const home = withTempHome();
    expect((await runCli(['fleet', 'install-hooks'], { home })).code).toBe(0);
    expect((await runCli(['fleet', 'install-launchers'], { home })).code).toBe(0);
    expect((await runCli(['fleet', 'install-bin'], { home })).code).toBe(0);
    const hooksDir = join(home, '.heddle', 'fleet', 'hooks');
    const modified = join(hooksDir, 'agent-identity.py');
    writeFileSync(modified, 'user edit\n');

    const first = await runCli(['uninstall', '--json'], { home });
    expect(first.code).toBe(0);
    const report = JSON.parse(first.stdout);
    expect(report.removed.length).toBeGreaterThan(0);
    expect(report.preserved).toContain(modified);
    expect(existsSync(modified)).toBe(true);
    expect(existsSync(join(home, '.heddle', 'fleet', 'bin'))).toBe(false);
    expect(existsSync(join(home, '.heddle', 'fleet', 'launchers'))).toBe(false);

    const second = await runCli(['uninstall', '--json'], { home });
    expect(second.code).toBe(0);
    expect(JSON.parse(second.stdout)).toEqual({ removed: [], preserved: [modified], purged: [], dryRun: false, purge: false });
  });

  it('leaves registries by default and only purges them with --yes', async () => {
    const home = withTempHome();
    const heddleDir = join(home, '.heddle');
    mkdirSync(heddleDir, { recursive: true });
    const projects = join(heddleDir, 'projects.json');
    const accounts = join(heddleDir, 'accounts.json');
    writeFileSync(projects, '{"projects":[]}\n');
    writeFileSync(accounts, '{"accounts":[]}\n');

    expect((await runCli(['uninstall'], { home })).code).toBe(0);
    expect(existsSync(projects)).toBe(true);
    expect(existsSync(accounts)).toBe(true);
    const purged = await runCli(['uninstall', '--purge', '--yes', '--json'], { home });
    expect(purged.code).toBe(0);
    expect(JSON.parse(purged.stdout).purged).toEqual([projects, accounts]);
    expect(existsSync(projects)).toBe(false);
    expect(existsSync(accounts)).toBe(false);
    expect((await runCli(['uninstall', '--purge', '--json'], { home })).code).toBe(2);
  });

  it('reports a dry-run plan, rejects typos before writes, and cleans only empty fleet directories', async () => {
    const home = withTempHome();
    expect((await runCli(['fleet', 'install-hooks'], { home })).code).toBe(0);
    const target = join(home, '.heddle', 'fleet', 'hooks', 'agent-preflight.py');
    const dryRun = await runCli(['uninstall', '--dry-run', '--json'], { home });
    expect(dryRun.code).toBe(0);
    expect(JSON.parse(dryRun.stdout).removed).toContain(target);
    expect(existsSync(target)).toBe(true);
    const typo = await runCli(['uninstall', '--dryrun'], { home });
    expect(typo.code).toBe(2);
    expect(existsSync(target)).toBe(true);

    const base = tempDir();
    const canonicalDir = join(base, 'canon');
    const targetDir = join(base, 'home', '.heddle', 'fleet', 'hooks');
    mkdirSync(canonicalDir, { recursive: true });
    writeFileSync(join(canonicalDir, 'one.py'), 'one\n');
    chmodSync(join(canonicalDir, 'one.py'), 0o755);
    installFleetHooks({ canonicalDir, targetDir });
    uninstallFleetHooks({ canonicalDir, targetDir });
    expect(existsSync(targetDir)).toBe(false);

    installFleetHooks({ canonicalDir, targetDir });
    writeFileSync(join(targetDir, 'user-note.txt'), 'keep\n');
    uninstallFleetHooks({ canonicalDir, targetDir });
    expect(existsSync(targetDir)).toBe(true);
    expect(existsSync(join(targetDir, 'user-note.txt'))).toBe(true);
  });
});
