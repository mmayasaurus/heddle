import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

export type FleetHookAction = 'created' | 'updated' | 'unchanged' | 'missing' | 'differing';

export interface FleetHookFileResult {
  name: string;
  action: FleetHookAction;
}

export interface FleetHookOptions {
  homeDir?: string;
  canonicalDir?: string;
  targetDir?: string;
  dryRun?: boolean;
}

export interface FleetHookInstallReport {
  targetDir: string;
  dryRun: boolean;
  files: FleetHookFileResult[];
}

export interface FleetHookDiffReport {
  clean: boolean;
  files: FleetHookFileResult[];
}

export type FleetLauncherOptions = FleetHookOptions;
export type FleetLauncherInstallReport = FleetHookInstallReport;
export type FleetLauncherDiffReport = FleetHookDiffReport;

interface FleetAssetSet {
  kind: 'hook' | 'launcher';
  canonicalDir: string;
  targetDir(homeDir: string): string;
  files(canonicalDir: string): string[];
}

const FLEET_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'fleet');
const filesByExtension = (extension: string) => (canonicalDir: string): string[] => {
  const entries = readdirSync(canonicalDir, { withFileTypes: true }).filter((entry) => entry.name.endsWith(extension));
  // Canon integrity: a *.ext entry that is not a regular file (symlink, directory) must fail
  // loudly — silently skipping it would let diff report clean against an unusable canon.
  const irregular = entries.filter((entry) => !entry.isFile()).map((entry) => entry.name).sort();
  if (irregular.length) throw new Error(`fleet canon entries at ${canonicalDir} are not regular files: ${irregular.join(', ')}`);
  return entries.map((entry) => entry.name).sort();
};
const ASSET_SETS: Record<FleetAssetSet['kind'], FleetAssetSet> = {
  hook: {
    kind: 'hook',
    canonicalDir: join(FLEET_ROOT, 'hooks'),
    targetDir: (homeDir) => join(homeDir, '.heddle', 'fleet', 'hooks'),
    files: filesByExtension('.py'),
  },
  launcher: {
    kind: 'launcher',
    canonicalDir: join(FLEET_ROOT, 'launchers'),
    targetDir: (homeDir) => join(homeDir, '.heddle', 'fleet', 'launchers'),
    files: filesByExtension('.sh'),
  },
};

function paths(assetSet: FleetAssetSet, options: FleetHookOptions): { canonicalDir: string; targetDir: string } {
  const canonicalDir = options.canonicalDir ?? assetSet.canonicalDir;
  return { canonicalDir, targetDir: options.targetDir ?? assetSet.targetDir(options.homeDir ?? homedir()) };
}

function canonicalFiles(assetSet: FleetAssetSet, canonicalDir: string): string[] {
  if (!existsSync(canonicalDir)) throw new Error(`fleet ${assetSet.kind} canon not found: ${canonicalDir}`);
  const names = assetSet.files(canonicalDir);
  // An empty canon is a broken checkout, never a vacuously clean install/diff.
  if (names.length === 0) throw new Error(`fleet ${assetSet.kind} canon is empty: ${canonicalDir}`);
  return names;
}

function sameContent(source: string, target: string): boolean {
  return existsSync(target) && statSync(target).isFile() && readFileSync(source).equals(readFileSync(target));
}

function sameMode(source: string, target: string): boolean {
  return (statSync(source).mode & 0o777) === (statSync(target).mode & 0o777);
}

function installAction(source: string, target: string): Extract<FleetHookAction, 'created' | 'updated' | 'unchanged'> {
  if (!existsSync(target)) return 'created';
  if (!statSync(target).isFile()) throw new Error(`target exists and is not a regular file: ${target}`);
  return sameContent(source, target) && sameMode(source, target) ? 'unchanged' : 'updated';
}

function atomicCopy(source: string, target: string): void {
  const temp = join(dirname(target), `.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
  try {
    writeFileSync(temp, readFileSync(source));
    chmodSync(temp, statSync(source).mode & 0o777);
    renameSync(temp, target);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

function installFleetAssets(assetSet: FleetAssetSet, options: FleetHookOptions): FleetHookInstallReport {
  const { canonicalDir, targetDir } = paths(assetSet, options);
  const files: FleetHookFileResult[] = [];
  for (const name of canonicalFiles(assetSet, canonicalDir)) {
    const source = join(canonicalDir, name);
    const target = join(targetDir, name);
    try {
      const action = installAction(source, target);
      if (!options.dryRun && action !== 'unchanged') {
        mkdirSync(targetDir, { recursive: true });
        atomicCopy(source, target);
      }
      files.push({ name, action });
    } catch (error) {
      const written = files.filter((file) => file.action === 'created' || file.action === 'updated').map((file) => file.name);
      const unchanged = files.filter((file) => file.action === 'unchanged').map((file) => file.name);
      const detail = error instanceof Error ? error.message : String(error);
      // A dry run writes nothing: earlier entries are planned actions, not files on disk.
      const writtenLabel = options.dryRun === true
        ? `none (dry run — planned: ${written.length ? written.join(', ') : 'none'})`
        : (written.length ? written.join(', ') : 'none');
      throw new Error(`fleet ${assetSet.kind} installation failed for ${name}; files written this run: ${writtenLabel}; unchanged: ${unchanged.length ? unchanged.join(', ') : 'none'}; ${detail}`, { cause: error });
    }
  }
  return { targetDir, dryRun: options.dryRun === true, files };
}

function diffFleetAssets(assetSet: FleetAssetSet, options: FleetHookOptions): FleetHookDiffReport {
  const { canonicalDir, targetDir } = paths(assetSet, options);
  const files = canonicalFiles(assetSet, canonicalDir).flatMap((name): FleetHookFileResult[] => {
    const source = join(canonicalDir, name);
    const target = join(targetDir, name);
    if (!existsSync(target)) return [{ name, action: 'missing' }];
    return sameContent(source, target) && sameMode(source, target) ? [] : [{ name, action: 'differing' }];
  });
  return { clean: files.length === 0, files };
}

/** Copy the vendored Python canon into a home-scoped fleet installation. */
export function installFleetHooks(options: FleetHookOptions = {}): FleetHookInstallReport {
  return installFleetAssets(ASSET_SETS.hook, options);
}

/** Compare the installed Python hooks to the vendored canon. */
export function diffFleetHooks(options: FleetHookOptions = {}): FleetHookDiffReport {
  return diffFleetAssets(ASSET_SETS.hook, options);
}

/** Copy the vendored launcher canon into a home-scoped fleet installation. */
export function installFleetLaunchers(options: FleetLauncherOptions = {}): FleetLauncherInstallReport {
  return installFleetAssets(ASSET_SETS.launcher, options);
}

/** Compare the installed launchers to the vendored canon. */
export function diffFleetLaunchers(options: FleetLauncherOptions = {}): FleetLauncherDiffReport {
  return diffFleetAssets(ASSET_SETS.launcher, options);
}
