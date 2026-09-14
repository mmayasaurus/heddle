import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runCli, withTempHome } from './helpers/cli.js';
import { PROJECTS_SCHEMA_VERSION } from '../src/projects.js';

const fleetBin = (home: string) => join(home, '.heddle', 'fleet', 'bin');
const canonBinDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fleet', 'bin');
// The canonical bin set `heddle upgrade` installs from, enumerated the SAME way installFleetBin does
// (fleet/bin, filtered to the shipped extensions). Deriving the expectation from the canon keeps this
// test from re-staling whenever a bin tool is vendored — it hardcoded 10 and broke when HED-549 shipped 21.
// Read lazily (inside the test), never at import: the standalone ship set includes this test file but
// omits fleet/, so a module-top-level readdirSync would throw ENOENT at collection time there.
const canonBinFiles = (): string[] =>
  readdirSync(canonBinDir).filter((name) => /\.(sh|py|mjs)$/.test(name)).sort();

describe('heddle upgrade', () => {
  it('migrates a legacy accounts registry, reports an absent projects registry, and creates missing fleet assets', async () => {
    const home = withTempHome();
    const accounts = join(home, 'legacy-accounts.json');
    writeFileSync(accounts, '{\n  "claude": []\n}\n');

    const result = await runCli(['upgrade', '--json'], { home, env: { HEDDLE_ACCOUNTS: accounts } });

    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({ dryRun: false, forced: false });
    expect(report.migrations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'projects', action: 'absent' }),
      expect.objectContaining({ kind: 'accounts', action: 'migrated', from: 1, to: 2, backupPath: expect.any(String) }),
    ]));
    expect(JSON.parse(readFileSync(accounts, 'utf8'))).toMatchObject({ schemaVersion: 2 });
    expect(readdirSync(home).some((name) => name.startsWith('legacy-accounts.json.bak-v1-'))).toBe(true);
    expect(readdirSync(fleetBin(home)).sort()).toEqual(canonBinFiles());
    expect(report.assets).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'bin', action: 'created' })]));
  });

  it('preserves differing fleet assets unless forced, then refreshes them', async () => {
    const home = withTempHome();
    await runCli(['upgrade'], { home });
    const target = join(fleetBin(home), 'lin.sh');
    writeFileSync(target, 'user edit\n');

    const preserved = await runCli(['upgrade', '--json'], { home });
    expect(preserved.code).toBe(0);
    expect(readFileSync(target, 'utf8')).toBe('user edit\n');
    expect(JSON.parse(preserved.stdout).assets).toContainEqual(expect.objectContaining({ kind: 'bin', name: 'lin.sh', action: 'preserved' }));

    const forced = await runCli(['upgrade', '--force', '--json'], { home });
    expect(forced.code).toBe(0);
    expect(readFileSync(target, 'utf8')).not.toBe('user edit\n');
    expect(JSON.parse(forced.stdout).assets).toContainEqual(expect.objectContaining({ kind: 'bin', name: 'lin.sh', action: 'updated' }));
  });

  it('is idempotent after installation', async () => {
    const home = withTempHome();
    await runCli(['upgrade'], { home });
    const target = join(fleetBin(home), 'lin.sh');
    const before = statSync(target).mtimeMs;

    const result = await runCli(['upgrade', '--json'], { home });

    expect(result.code).toBe(0);
    expect(statSync(target).mtimeMs).toBe(before);
    const report = JSON.parse(result.stdout);
    expect(report.migrations.every((migration: { action: string }) => migration.action === 'absent' || migration.action === 'current')).toBe(true);
    expect(report.assets.every((asset: { action: string }) => asset.action === 'unchanged')).toBe(true);
  });

  it('plans migrations and missing assets without writing in dry-run mode', async () => {
    const home = withTempHome();
    const accounts = join(home, 'accounts.json');
    writeFileSync(accounts, '{"claude":[]}\n');

    const result = await runCli(['upgrade', '--dry-run', '--json'], { home, env: { HEDDLE_ACCOUNTS: accounts } });

    expect(result.code).toBe(0);
    expect(JSON.parse(readFileSync(accounts, 'utf8'))).toEqual({ claude: [] });
    expect(existsSync(fleetBin(home))).toBe(false);
    expect(JSON.parse(result.stdout)).toMatchObject({ dryRun: true, migrations: expect.arrayContaining([
      expect.objectContaining({ kind: 'accounts', action: 'would-migrate', from: 1, to: 2 }),
    ]), assets: expect.arrayContaining([expect.objectContaining({ action: 'would-create' })]) });
  });

  it('honors HEDDLE_PROJECTS for the projects registry, not just the default path', async () => {
    const home = withTempHome();
    const projects = join(home, 'custom-projects.json');
    // A valid CURRENT-version projects registry at a custom path: upgrade must report IT (current),
    // proving it resolved HEDDLE_PROJECTS rather than the (absent) default path.
    writeFileSync(projects, JSON.stringify({ schemaVersion: PROJECTS_SCHEMA_VERSION, projects: [] }) + '\n');

    const result = await runCli(['upgrade', '--json'], { home, env: { HEDDLE_PROJECTS: projects } });

    expect(result.code).toBe(0);
    const projectsEntry = JSON.parse(result.stdout).migrations.find((m: { kind: string }) => m.kind === 'projects');
    expect(projectsEntry.path).toBe(projects);
    expect(projectsEntry.action).not.toBe('absent');
  });

  it('rejects an unknown/mistyped flag instead of performing real writes', async () => {
    const home = withTempHome();
    const accounts = join(home, 'accounts.json');
    writeFileSync(accounts, '{"claude":[]}\n');

    // A typo'd --dry-run (here --dryrun) must NOT silently mutate the filesystem.
    const result = await runCli(['upgrade', '--dryrun'], { home, env: { HEDDLE_ACCOUNTS: accounts } });

    expect(result.code).not.toBe(0);
    expect(JSON.parse(readFileSync(accounts, 'utf8'))).toEqual({ claude: [] });
    expect(existsSync(fleetBin(home))).toBe(false);
  });
});
