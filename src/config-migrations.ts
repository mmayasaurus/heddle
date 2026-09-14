import { constants, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { ACCOUNTS_SCHEMA_VERSION, atomicWriteFile } from './accounts.js';
import { PROJECTS_SCHEMA_VERSION } from './projects.js';

export interface ConfigMigrationStep {
  from: number;
  to: number;
  migrate: (raw: unknown) => unknown;
}

export interface ConfigMigrationDefinition {
  currentVersion: number;
  storedVersion: (raw: Record<string, unknown>) => unknown;
  steps: readonly ConfigMigrationStep[];
}

export type ConfigMigrationRegistry = Record<string, ConfigMigrationDefinition>;

export interface MigrateConfigFileOptions {
  registry?: ConfigMigrationRegistry;
  /** Validate and describe the complete migration chain without creating a backup or writing. */
  dryRun?: boolean;
}

export interface ConfigMigrationResult {
  migrated: boolean;
  from: number;
  to: number;
  backupPath?: string;
}

// Accounts predate schemaVersion. Its conceptual v1 baseline represents that unversioned shape;
// no persisted accounts.json ever carried schemaVersion: 1.
const ACCOUNTS_LEGACY_BASELINE = 1;

export const CONFIG_MIGRATIONS: ConfigMigrationRegistry = {
  accounts: {
    currentVersion: ACCOUNTS_SCHEMA_VERSION,
    storedVersion: (raw) => raw.schemaVersion ?? ACCOUNTS_LEGACY_BASELINE,
    steps: [
      { from: ACCOUNTS_LEGACY_BASELINE, to: ACCOUNTS_SCHEMA_VERSION, migrate: (raw) => raw },
    ],
  },
  // projects is presently schema v1 and has no earlier released schema to migrate from.
  projects: {
    currentVersion: PROJECTS_SCHEMA_VERSION,
    storedVersion: (raw) => raw.schemaVersion,
    steps: [],
  },
};

function asConfigObject(raw: unknown, path: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`config at ${path} must be a JSON object (got ${JSON.stringify(raw)})`);
  }
  return raw as Record<string, unknown>;
}

function schemaVersion(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`config at ${path} has invalid schemaVersion ${JSON.stringify(value)}`);
  }
  return value;
}

function migrationChain(
  definition: ConfigMigrationDefinition,
  storedVersion: number,
  path: string,
): readonly ConfigMigrationStep[] {
  const stepsByFrom = new Map<number, ConfigMigrationStep>();
  for (const step of definition.steps) {
    if (!Number.isInteger(step.from) || !Number.isInteger(step.to) || step.to !== step.from + 1) {
      throw new Error(`config at ${path} has an invalid migration step ${step.from}→${step.to}; steps must advance exactly one schemaVersion`);
    }
    if (stepsByFrom.has(step.from)) {
      throw new Error(`config at ${path} has duplicate migration steps from schemaVersion ${step.from}`);
    }
    stepsByFrom.set(step.from, step);
  }

  const chain: ConfigMigrationStep[] = [];
  for (let version = storedVersion; version < definition.currentVersion; version += 1) {
    const step = stepsByFrom.get(version);
    if (!step) {
      throw new Error(`config at ${path} has no migration step from schemaVersion ${version} to ${version + 1}`);
    }
    chain.push(step);
  }
  return chain;
}

function backupPath(path: string, storedVersion: number): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = `${path}.bak-v${storedVersion}-${timestamp}`;
  if (!existsSync(base)) return base;
  let attempt = 1;
  while (existsSync(`${base}-${attempt}`)) attempt += 1;
  return `${base}-${attempt}`;
}

/**
 * Explicitly migrates one config file. Normal registry loaders intentionally never call this:
 * schema drift remains a loud signal to run `heddle upgrade`.
 */
export function migrateConfigFile(
  kind: string,
  path: string,
  options: MigrateConfigFileOptions = {},
): ConfigMigrationResult {
  const registry = options.registry ?? CONFIG_MIGRATIONS;
  const definition = registry[kind];
  if (!definition) throw new Error(`unknown config migration kind "${kind}"`);
  if (!Number.isInteger(definition.currentVersion) || definition.currentVersion < 0) {
    throw new Error(`config migration kind "${kind}" has invalid current schemaVersion ${definition.currentVersion}`);
  }

  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`config at ${path} exists but could not be read: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(`config at ${path} is not valid JSON: ${(error as Error).message}`);
  }
  const original = asConfigObject(parsed, path);
  const from = schemaVersion(definition.storedVersion(original), path);
  const to = definition.currentVersion;

  if (from === to) return { migrated: false, from, to };
  if (from > to) {
    throw new Error(`config at ${path} is schemaVersion ${from}, newer than this heddle's ${to} — upgrade heddle`);
  }

  const chain = migrationChain(definition, from, path);
  if (options.dryRun) return { migrated: true, from, to };
  const backup = backupPath(path, from);
  try {
    copyFileSync(path, backup, constants.COPYFILE_EXCL);
  } catch (error) {
    throw new Error(`config at ${path} could not be backed up to ${backup}: ${(error as Error).message}`);
  }

  let migrated: unknown = original;
  for (const step of chain) migrated = step.migrate(migrated);
  const output = asConfigObject(migrated, path);
  atomicWriteFile(path, JSON.stringify({ ...output, schemaVersion: to }, null, 2) + '\n');
  return { migrated: true, from, to, backupPath: backup };
}
