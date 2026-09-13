import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
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
  return existsSync(target) && readFileSync(source).equals(readFileSync(target));
}

function installAction(source: string, target: string): Extract<FleetHookAction, 'created' | 'updated' | 'unchanged'> {
  if (!existsSync(target)) return 'created';
  return sameContent(source, target) ? 'unchanged' : 'updated';
}

function atomicCopy(source: string, target: string): void {
  const temp = join(dirname(target), `.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
  writeFileSync(temp, readFileSync(source));
  chmodSync(temp, statSync(source).mode & 0o777);
  renameSync(temp, target);
}

/** Copy the vendored Python canon into a home-scoped fleet installation. */
export function installFleetHooks(options: FleetHookOptions = {}): FleetHookInstallReport {
  const { canonicalDir, targetDir } = paths(options);
  const files = canonicalFiles(canonicalDir).map((name) => {
    const source = join(canonicalDir, name);
    const target = join(targetDir, name);
    const action = installAction(source, target);
    if (!options.dryRun && action !== 'unchanged') {
      mkdirSync(targetDir, { recursive: true });
      atomicCopy(source, target);
    }
    return { name, action };
  });
  return { targetDir, files };
}

/** Compare the installed Python hooks to the vendored canon. */
export function diffFleetHooks(options: FleetHookOptions = {}): FleetHookDiffReport {
  const { canonicalDir, targetDir } = paths(options);
  const files = canonicalFiles(canonicalDir).flatMap((name): FleetHookFileResult[] => {
    const source = join(canonicalDir, name);
    const target = join(targetDir, name);
    if (!existsSync(target)) return [{ name, action: 'missing' }];
    return sameContent(source, target) ? [] : [{ name, action: 'differing' }];
  });
  return { clean: files.length === 0, files };
}
