import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
  /** Preserve non-canonical installed files while still materializing missing canonical files. */
  skipDiffering?: boolean;
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

export interface FleetUninstallReport {
  targetDir: string;
  dryRun: boolean;
  removed: string[];
  preserved: string[];
  /** Anomalies that blocked removal (a symlinked ancestor/target, or a non-regular file at a
   * canonical path): surfaced for operator attention, never deleted. Distinct from `preserved`,
   * which is specifically a user-MODIFIED regular file. */
  warnings: string[];
}

export type FleetLauncherOptions = FleetHookOptions;
export type FleetLauncherInstallReport = FleetHookInstallReport;
export type FleetLauncherDiffReport = FleetHookDiffReport;
export type FleetBinOptions = FleetHookOptions;
export type FleetBinInstallReport = FleetHookInstallReport;
export type FleetBinDiffReport = FleetHookDiffReport;

interface FleetAssetSet {
  kind: 'hook' | 'launcher' | 'bin';
  canonicalDir: string;
  targetDir(homeDir: string): string;
  files(canonicalDir: string): string[];
}

const FLEET_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'fleet');
const filesByExtensions = (extensions: string[]) => (canonicalDir: string): string[] => {
  const entries = readdirSync(canonicalDir, { withFileTypes: true }).filter((entry) => extensions.some((extension) => entry.name.endsWith(extension)));
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
    files: filesByExtensions(['.py']),
  },
  launcher: {
    kind: 'launcher',
    canonicalDir: join(FLEET_ROOT, 'launchers'),
    targetDir: (homeDir) => join(homeDir, '.heddle', 'fleet', 'launchers'),
    files: filesByExtensions(['.sh']),
  },
  bin: {
    kind: 'bin',
    canonicalDir: join(FLEET_ROOT, 'bin'),
    targetDir: (homeDir) => join(homeDir, '.heddle', 'fleet', 'bin'),
    files: filesByExtensions(['.sh', '.py', '.mjs']),
  },
};

function paths(assetSet: FleetAssetSet, options: FleetHookOptions): { canonicalDir: string; targetDir: string } {
  const canonicalDir = options.canonicalDir ?? assetSet.canonicalDir;
  return { canonicalDir, targetDir: options.targetDir ?? assetSet.targetDir(options.homeDir ?? homedir()) };
}

function canonicalFiles(assetSet: FleetAssetSet, canonicalDir: string): string[] {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(canonicalDir);
  } catch (error) {
    // A non-ENOENT stat error (permission, I/O) is a broken environment, not absence: surface it.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // The kind-dir is genuinely absent. For the default canon, dirname(canonicalDir) is FLEET_ROOT — the
    // fleet container. If that container is ALSO absent, this pack ships no fleet/ at all (the standalone
    // ship-set excludes it): a fleetless pack, nothing of any kind to install/diff/uninstall → no-op
    // (HED-561). If the container IS present, the pack shipped fleet assets and just this kind-dir is
    // missing: a CORRUPT checkout, not fleetlessness → throw, so uninstall's all-or-nothing preflight
    // (verifyFleetCanon) and `heddle upgrade` abort rather than silently skipping the missing kind.
    if (!existsSync(dirname(canonicalDir))) return [];
    throw new Error(`fleet ${assetSet.kind} canon not found: ${canonicalDir}`);
  }
  // A canon path that exists but is not a real directory (a symlink — possibly dangling — or a file) is a
  // broken checkout, never a fleetless pack: refuse rather than follow it or silently no-op.
  if (!stat.isDirectory()) throw new Error(`fleet ${assetSet.kind} canon is not a directory: ${canonicalDir}`);
  const names = assetSet.files(canonicalDir);
  // A present-but-empty canon is a broken checkout, never a vacuously clean install/diff.
  if (names.length === 0) throw new Error(`fleet ${assetSet.kind} canon is empty: ${canonicalDir}`);
  return names;
}

function manifestHashes(): Map<string, string> {
  const path = join(FLEET_ROOT, 'MANIFEST.sha256');
  if (!existsSync(path)) throw new Error(`fleet manifest not found: ${path}`);
  const hashes = new Map<string, string>();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (match) hashes.set(match[2], match[1]);
  }
  return hashes;
}

function verifyDefaultCanon(assetSet: FleetAssetSet, canonicalDir: string, names: string[]): void {
  if (canonicalDir !== assetSet.canonicalDir) return;
  // Genuinely fleetless default canon: canonicalFiles returns no names only when FLEET_ROOT (the parent
  // of the default kind-dir) is absent — the pack ships no fleet/ at all, so there is no MANIFEST.sha256
  // to verify and manifestHashes() below would throw. No-op (HED-561). A present FLEET_ROOT with a
  // missing kind-dir never reaches here: canonicalFiles throws (corrupt checkout) first.
  if (names.length === 0) return;
  const hashes = manifestHashes();
  for (const name of names) {
    const directory = assetSet.kind === 'bin' ? 'bin' : `${assetSet.kind}s`;
    const path = `${directory}/${name}`;
    const expected = hashes.get(path);
    const actual = createHash('sha256').update(readFileSync(join(canonicalDir, name))).digest('hex');
    if (!expected || actual !== expected) throw new Error(`fleet manifest mismatch for ${path}`);
  }
}

function sameContent(source: string, target: string): boolean {
  return existsSync(target) && statSync(target).isFile() && readFileSync(source).equals(readFileSync(target));
}

function sameMode(source: string, target: string): boolean {
  return (statSync(source).mode & 0o777) === (statSync(target).mode & 0o777);
}

/**
 * lstat a path, returning undefined when it does not exist (ENOENT). Unlike existsSync it does NOT
 * follow symlinks, so a DANGLING symlink is reported present (its Stats has isSymbolicLink() true).
 */
function lstatOrUndefined(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

/**
 * Uninstall-only mode comparison over the FULL 0o7777 permission set (setuid/setgid/sticky included).
 * The shared sameMode masks 0o777 for install/diff, which never set special bits; uninstall must
 * refuse to delete a byte-identical file whose special bits an operator changed.
 */
function sameUninstallMode(source: string, target: string): boolean {
  return (statSync(source).mode & 0o7777) === (lstatSync(target).mode & 0o7777);
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
      const preserved = options.skipDiffering && action === 'updated';
      if (!options.dryRun && action !== 'unchanged' && !preserved) {
        mkdirSync(targetDir, { recursive: true });
        atomicCopy(source, target);
      }
      files.push({ name, action: preserved ? 'differing' : action });
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

function uninstallFleetAssets(assetSet: FleetAssetSet, options: FleetHookOptions): FleetUninstallReport {
  const { canonicalDir, targetDir } = paths(assetSet, options);
  const names = canonicalFiles(assetSet, canonicalDir);
  verifyDefaultCanon(assetSet, canonicalDir, names);
  const dryRun = options.dryRun === true;
  const removed: string[] = [];
  const preserved: string[] = [];
  const warnings: string[] = [];

  // Ancestor-symlink guard (default ~/.heddle/fleet layout only). The per-file checks below prove a
  // TARGET is a regular file byte+mode-identical to canon — but if an ancestor (~/.heddle or
  // ~/.heddle/fleet) is a symlink, `target` resolves THROUGH it, and a fleet symlinked onto the canon
  // itself would make every file "match" and be unlinked (deleting the source canon). Refuse
  // wholesale when an ancestor is substituted; a legitimately-symlinked ~/.heddle becomes preserve-all
  // (install still works through it — uninstall simply declines to guess what it did not provably lay down).
  if (options.targetDir === undefined) {
    const homeDir = options.homeDir ?? homedir();
    for (const ancestor of [join(homeDir, '.heddle'), join(homeDir, '.heddle', 'fleet')]) {
      if (lstatOrUndefined(ancestor)?.isSymbolicLink()) {
        warnings.push(`refused to uninstall ${assetSet.kind}: ancestor path ${ancestor} is a symlink — not removing files reached through it`);
        return { targetDir, dryRun, removed, preserved, warnings };
      }
    }
  }

  // The fleet directory itself must be a real directory. A symlink (even dangling) or a file in its
  // place was never proven to be the directory heddle installed into — do not follow or remove through it.
  const targetDirStat = lstatOrUndefined(targetDir);
  if (targetDirStat && !targetDirStat.isDirectory()) {
    warnings.push(`refused to uninstall ${assetSet.kind}: ${targetDir} is not a real directory (symlink?) — not removing files reached through it`);
    return { targetDir, dryRun, removed, preserved, warnings };
  }

  for (const name of names) {
    const source = join(canonicalDir, name);
    const target = join(targetDir, name);
    const targetStat = lstatOrUndefined(target);
    if (!targetStat) continue; // genuinely absent (ENOENT) — nothing to remove
    // A symlink (including a dangling one), directory, or other irregular target was never proven to
    // be a fleet-written file: never unlink it, and surface it so the operator can inspect.
    if (!targetStat.isFile()) {
      warnings.push(`preserved ${target}: not a regular file (symlink or directory) — heddle did not install it here`);
      continue;
    }
    // A regular file whose bytes or FULL permission set differ from canon is an operator edit: keep it.
    if (!sameContent(source, target) || !sameUninstallMode(source, target)) {
      preserved.push(target);
      continue;
    }
    if (!dryRun) unlinkSync(target);
    removed.push(target);
  }

  // Only remove the fleet directory itself when it contains nothing at all. This intentionally
  // preserves the directory beside any user file, including files outside the current canon.
  if (!dryRun && targetDirStat?.isDirectory() && readdirSync(targetDir).length === 0) {
    rmdirSync(targetDir);
  }
  return { targetDir, dryRun, removed, preserved, warnings };
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

/** Copy the vendored fleet bin canon into a home-scoped fleet installation. */
export function installFleetBin(options: FleetBinOptions = {}): FleetBinInstallReport {
  return installFleetAssets(ASSET_SETS.bin, options);
}

/** Compare the installed fleet bin tools to the vendored canon. */
export function diffFleetBin(options: FleetBinOptions = {}): FleetBinDiffReport {
  return diffFleetAssets(ASSET_SETS.bin, options);
}

/**
 * Verify a fleet asset set's canon before uninstall touches any installed target: a PRESENT canon must
 * be non-empty and (for the default canon) manifest-identical, or this aborts the whole command rather
 * than leaving one set removed and another intact. A genuinely FLEETLESS canon (the fleet container is
 * absent) is a no-op (HED-561); a present-but-empty canon, a container-present-but-kind-missing corrupt
 * checkout, and a non-directory canon path all still abort.
 */
export function verifyFleetCanon(kind: FleetAssetSet['kind'], options: FleetHookOptions = {}): void {
  const assetSet = ASSET_SETS[kind];
  const { canonicalDir } = paths(assetSet, options);
  verifyDefaultCanon(assetSet, canonicalDir, canonicalFiles(assetSet, canonicalDir));
}

/** Remove only installed fleet hooks whose bytes and mode still match the manifest-verified canon. */
export function uninstallFleetHooks(options: FleetHookOptions = {}): FleetUninstallReport {
  return uninstallFleetAssets(ASSET_SETS.hook, options);
}

/** Remove only installed fleet launchers whose bytes and mode still match the manifest-verified canon. */
export function uninstallFleetLaunchers(options: FleetLauncherOptions = {}): FleetUninstallReport {
  return uninstallFleetAssets(ASSET_SETS.launcher, options);
}

/** Remove only installed fleet bin files whose bytes and mode still match the manifest-verified canon. */
export function uninstallFleetBin(options: FleetBinOptions = {}): FleetUninstallReport {
  return uninstallFleetAssets(ASSET_SETS.bin, options);
}
