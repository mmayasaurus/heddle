import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { diffFleetBin, installFleetBin } from '../src/fleet.js';
import { useTempResources } from './helpers.js';
import { runCli, withTempHome } from './helpers/cli.js';

const BIN_FILES = [
  { name: 'tool-alpha.sh', mode: 0o755 },
  { name: 'helper-bravo.py', mode: 0o644 },
  { name: 'tool-charlie.mjs', mode: 0o755 },
];

// The real canon fleet/bin currently ships this many installable files (see fleet/MANIFEST.sha256). This
// exact-count contract re-breaks on every file-adding re-vendor (HED-664 added _linear_token_cache.py);
// HED-666 tracks enumerating the canon dynamically — as `heddle upgrade` already does — instead of a hardcode.
const CANON_BIN_FILE_COUNT = 22;

function fixture(base: string) {
  const canonicalDir = join(base, 'canonical-bin');
  const homeDir = join(base, 'home');
  mkdirSync(canonicalDir, { recursive: true });
  for (const file of BIN_FILES) {
    writeFileSync(join(canonicalDir, file.name), `content for ${file.name}\n`);
    chmodSync(join(canonicalDir, file.name), file.mode);
  }
  return { canonicalDir, homeDir, targetDir: join(homeDir, '.heddle', 'fleet', 'bin') };
}

describe('fleet bin', () => {
  const { tempDir } = useTempResources('heddle-fleet-bin-test-');

  it('discovers each supported extension and preserves the source mode', () => {
    const paths = fixture(tempDir());
    expect(installFleetBin(paths).files).toEqual(BIN_FILES.map(({ name }) => ({ name, action: 'created' })).sort((a, b) => a.name.localeCompare(b.name)));
    for (const file of BIN_FILES) {
      expect(statSync(join(paths.targetDir, file.name)).mode & 0o777).toBe(file.mode);
    }
  });

  it('reports byte and mode drift and restores the source file', () => {
    const paths = fixture(tempDir());
    installFleetBin(paths);
    writeFileSync(join(paths.targetDir, 'tool-alpha.sh'), 'drift\n');
    chmodSync(join(paths.targetDir, 'helper-bravo.py'), 0o755);
    unlinkSync(join(paths.targetDir, 'tool-charlie.mjs'));
    expect(diffFleetBin(paths)).toEqual({ clean: false, files: [
      { name: 'helper-bravo.py', action: 'differing' },
      { name: 'tool-alpha.sh', action: 'differing' },
      { name: 'tool-charlie.mjs', action: 'missing' },
    ] });
    installFleetBin(paths);
    expect(readFileSync(join(paths.targetDir, 'tool-alpha.sh'))).toEqual(readFileSync(join(paths.canonicalDir, 'tool-alpha.sh')));
    expect(statSync(join(paths.targetDir, 'helper-bravo.py')).mode & 0o777).toBe(0o644);
  });

  it('reports bin CLI text, JSON, dry-run, drift, and usage contracts', async () => {
    const home = withTempHome();
    const targetDir = join(home, '.heddle', 'fleet', 'bin');
    const installed = await runCli(['fleet', 'install-bin'], { home });
    expect(installed.code).toBe(0);
    expect(installed.stdout).toContain(`target: ${targetDir}`);
    expect(readdirSync(targetDir)).toHaveLength(CANON_BIN_FILE_COUNT);
    const installedJson = await runCli(['fleet', 'install-bin', '--json'], { home });
    expect(JSON.parse(installedJson.stdout)).toEqual(expect.objectContaining({ dryRun: false, targetDir, files: expect.any(Array) }));
    expect(JSON.parse(installedJson.stdout).files).toHaveLength(CANON_BIN_FILE_COUNT);
    writeFileSync(join(targetDir, 'lin.sh'), 'drift\n');
    const drift = await runCli(['fleet', 'bin-diff', '--json'], { home });
    expect(drift.code).toBe(1);
    expect(JSON.parse(drift.stdout)).toEqual({ clean: false, files: expect.arrayContaining([{ name: 'lin.sh', action: 'differing' }]) });
    await runCli(['fleet', 'install-bin'], { home });
    expect((await runCli(['fleet', 'bin-diff'], { home })).code).toBe(0);
    expect((await runCli(['fleet', 'unknown-action'], { home })).code).toBe(2);

    const dryRunHome = withTempHome();
    const dryRun = await runCli(['fleet', 'install-bin', '--dry-run'], { home: dryRunHome });
    expect(dryRun.code).toBe(0);
    expect(dryRun.stdout).toContain(`target: ${join(dryRunHome, '.heddle', 'fleet', 'bin')}`);
    const dryRunLines = dryRun.stdout.split('\n').slice(1).filter(Boolean);
    expect(dryRunLines).toHaveLength(CANON_BIN_FILE_COUNT);
    expect(dryRunLines.every((line) => line.startsWith('would create '))).toBe(true);
    const dryRunJson = await runCli(['fleet', 'install-bin', '--dry-run', '--json'], { home: dryRunHome });
    expect(dryRunJson.code).toBe(0);
    expect(JSON.parse(dryRunJson.stdout)).toEqual(expect.objectContaining({
      dryRun: true,
      targetDir: join(dryRunHome, '.heddle', 'fleet', 'bin'),
      files: expect.any(Array),
    }));
    expect(existsSync(join(dryRunHome, '.heddle', 'fleet', 'bin'))).toBe(false);
  });
});
