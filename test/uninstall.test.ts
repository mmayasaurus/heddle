import { chmodSync, existsSync, lstatSync, mkdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { installFleetHooks, uninstallFleetBin, uninstallFleetHooks } from '../src/fleet.js';
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
    expect(JSON.parse(second.stdout)).toEqual({ removed: [], preserved: [modified], warnings: [], dryRun: false });
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

  it('refuses to remove through a symlinked ~/.heddle/fleet ancestor, preserving the canon', () => {
    const home = tempDir();
    mkdirSync(join(home, '.heddle'), { recursive: true });
    // A dev might symlink ~/.heddle/fleet at the repo's own fleet/ dir; byte+mode checks would then
    // match the canon against ITSELF. Uninstall must refuse rather than unlink the source canon.
    symlinkSync(tempDir(), join(home, '.heddle', 'fleet'));

    const report = uninstallFleetBin({ homeDir: home });

    expect(report.removed).toEqual([]);
    expect(report.preserved).toEqual([]);
    expect(report.warnings.join('\n')).toMatch(/symlink/i);
    expect(lstatSync(join(home, '.heddle', 'fleet')).isSymbolicLink()).toBe(true);
  });

  it('preserves a byte-identical file whose special mode bits an operator changed', () => {
    const base = tempDir();
    const canonicalDir = join(base, 'canon');
    const targetDir = join(base, 'home', '.heddle', 'fleet', 'hooks');
    mkdirSync(canonicalDir, { recursive: true });
    writeFileSync(join(canonicalDir, 'one.py'), 'one\n');
    chmodSync(join(canonicalDir, 'one.py'), 0o755);
    installFleetHooks({ canonicalDir, targetDir });
    const installed = join(targetDir, 'one.py');
    // Same bytes, but add the setuid bit — the full 0o7777 permission set now differs from canon.
    chmodSync(installed, 0o4755);
    expect(statSync(installed).mode & 0o7777).toBe(0o4755); // premise: platform kept the special bit

    const report = uninstallFleetHooks({ canonicalDir, targetDir });

    expect(report.removed).toEqual([]);
    expect(report.preserved).toContain(installed);
    expect(existsSync(installed)).toBe(true);
  });

  it('preserves and warns about a dangling symlink at a canonical path instead of treating it as absent', () => {
    const base = tempDir();
    const canonicalDir = join(base, 'canon');
    const targetDir = join(base, 'home', '.heddle', 'fleet', 'hooks');
    mkdirSync(canonicalDir, { recursive: true });
    writeFileSync(join(canonicalDir, 'one.py'), 'one\n');
    writeFileSync(join(canonicalDir, 'two.py'), 'two\n');
    installFleetHooks({ canonicalDir, targetDir });
    // Replace an installed canon file with a DANGLING symlink: existsSync() reports it absent.
    const link = join(targetDir, 'one.py');
    unlinkSync(link);
    symlinkSync(join(base, 'does-not-exist'), link);

    const report = uninstallFleetHooks({ canonicalDir, targetDir });

    expect(existsSync(link)).toBe(false);                // follows the link → target missing
    expect(lstatSync(link).isSymbolicLink()).toBe(true); // the link itself is preserved
    expect(report.removed).not.toContain(link);
    expect(report.warnings.join('\n')).toContain(link);
    expect(report.removed).toContain(join(targetDir, 'two.py')); // the untouched identical file is still removed
  });
});
