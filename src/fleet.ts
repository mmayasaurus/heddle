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

const DEFAULT_CANONICAL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fleet', 'hooks');

function paths(options: FleetHookOptions): { canonicalDir: string; targetDir: string } {
  const canonicalDir = options.canonicalDir ?? DEFAULT_CANONICAL_DIR;
  return { canonicalDir, targetDir: options.targetDir ?? join(options.homeDir ?? homedir(), '.heddle', 'fleet', 'hooks') };
}

function canonicalFiles(canonicalDir: string): string[] {
  if (!existsSync(canonicalDir)) throw new Error(`fleet hook canon not found: ${canonicalDir}`);
  return readdirSync(canonicalDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.py'))
    .map((entry) => entry.name)
    .sort();
}

function sameContent(source: string, target: string): boolean {
  return existsSync(target) && statSync(target).isFile() && readFileSync(source).equals(readFileSync(target));
}

function sameMode(source: string, target: string): boolean {
  return (statSync(source).mode & 0o777) === (statSync(target).mode & 0o777);
}

function installAction(source: string, target: string): Extract<FleetHookAction, 'created' | 'updated' | 'unchanged'> {
  if (!existsSync(target)) return 'created';
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

/** Copy the vendored Python canon into a home-scoped fleet installation. */
export function installFleetHooks(options: FleetHookOptions = {}): FleetHookInstallReport {
  const { canonicalDir, targetDir } = paths(options);
  const files: FleetHookFileResult[] = [];
  for (const name of canonicalFiles(canonicalDir)) {
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
      const installed = files.filter((file) => file.action === 'created' || file.action === 'updated').map((file) => file.name);
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`fleet hook installation failed for ${name}; files already installed this run: ${installed.length ? installed.join(', ') : 'none'}; ${detail}`, { cause: error });
    }
  }
  return { targetDir, dryRun: options.dryRun === true, files };
}

/** Compare the installed Python hooks to the vendored canon. */
export function diffFleetHooks(options: FleetHookOptions = {}): FleetHookDiffReport {
  const { canonicalDir, targetDir } = paths(options);
  const files = canonicalFiles(canonicalDir).flatMap((name): FleetHookFileResult[] => {
    const source = join(canonicalDir, name);
    const target = join(targetDir, name);
    if (!existsSync(target)) return [{ name, action: 'missing' }];
    return sameContent(source, target) && sameMode(source, target) ? [] : [{ name, action: 'differing' }];
  });
  return { clean: files.length === 0, files };
}
