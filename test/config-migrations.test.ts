import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type ConfigMigrationRegistry,
  migrateConfigFile,
} from '../src/config-migrations.js';
import { useTempResources } from './helpers.js';

const syntheticRegistry: ConfigMigrationRegistry = {
  synthetic: {
    currentVersion: 3,
    storedVersion: (raw) => (raw as Record<string, unknown>).schemaVersion as number,
    steps: [
      { from: 1, to: 2, migrate: (raw) => ({ ...(raw as Record<string, unknown>), first: true }) },
      { from: 2, to: 3, migrate: (raw) => ({ ...(raw as Record<string, unknown>), second: true }) },
    ],
  },
};

describe('migrateConfigFile', () => {
  const { tempDir } = useTempResources('heddle-config-migrations-test-');

  function writeFixture(name: string, contents: string): string {
    const path = join(tempDir(), name);
    writeFileSync(path, contents);
    return path;
  }

  it('migrates a synthetic v1 chain in order and stamps the current version', () => {
    const path = writeFixture('synthetic.json', '{\n  "schemaVersion": 1,\n  "value": "fixture"\n}\n');

    expect(migrateConfigFile('synthetic', path, { registry: syntheticRegistry })).toMatchObject({
      migrated: true, from: 1, to: 3,
    });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      schemaVersion: 3, value: 'fixture', first: true, second: true,
    });
  });

  it('does not write or create a backup when already current', () => {
    const original = '{\n  "schemaVersion": 3,\n  "value": "current"\n}\n';
    const path = writeFixture('current.json', original);

    expect(migrateConfigFile('synthetic', path, { registry: syntheticRegistry })).toEqual({
      migrated: false, from: 3, to: 3,
    });
    expect(readFileSync(path, 'utf8')).toBe(original);
    expect(readdirSync(tempDir()).filter((entry) => entry.startsWith('current.json.bak-'))).toEqual([]);
  });

  it('throws for a newer config without mutation or backup', () => {
    const original = '{\n  "schemaVersion": 4\n}\n';
    const path = writeFixture('newer.json', original);

    expect(() => migrateConfigFile('synthetic', path, { registry: syntheticRegistry }))
      .toThrow(/newer than this heddle's 3.*upgrade heddle/);
    expect(readFileSync(path, 'utf8')).toBe(original);
    expect(readdirSync(tempDir()).filter((entry) => entry.startsWith('newer.json.bak-'))).toEqual([]);
  });

  it('backs up the verbatim original before migrating', () => {
    const original = '{\n  "schemaVersion": 1,\n  "value": "preserve whitespace"\n}\n';
    const path = writeFixture('backup.json', original);

    const result = migrateConfigFile('synthetic', path, { registry: syntheticRegistry });

    expect(result.backupPath).toBeDefined();
    expect(readFileSync(result.backupPath!, 'utf8')).toBe(original);
  });

  it('leaves no atomic-write temporary file after a successful migration', () => {
    const path = writeFixture('atomic.json', '{"schemaVersion":1}\n');

    migrateConfigFile('synthetic', path, { registry: syntheticRegistry });

    expect(readdirSync(tempDir()).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
  });

  it('migrates an unversioned accounts registry to schema v2', () => {
    const path = writeFixture('accounts.json', '{\n  "claude": []\n}\n');

    expect(migrateConfigFile('accounts', path)).toMatchObject({ migrated: true, from: 1, to: 2 });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ schemaVersion: 2, claude: [] });
  });

  it('plans a migration without writing a backup or changing the file in dry-run mode', () => {
    const original = '{\n  "schemaVersion": 1,\n  "value": "dry"\n}\n';
    const path = writeFixture('dry-run.json', original);

    expect(migrateConfigFile('synthetic', path, { registry: syntheticRegistry, dryRun: true })).toEqual({
      migrated: true, from: 1, to: 3,
    });
    expect(readFileSync(path, 'utf8')).toBe(original);
    expect(readdirSync(tempDir()).filter((entry) => entry.startsWith('dry-run.json.bak-'))).toEqual([]);
  });

  it('throws before touching a file when the migration chain has a gap', () => {
    const original = '{"schemaVersion":1}\n';
    const path = writeFixture('gap.json', original);
    const registry: ConfigMigrationRegistry = {
      gap: {
        currentVersion: 3,
        storedVersion: (raw) => (raw as Record<string, unknown>).schemaVersion as number,
        steps: [{ from: 1, to: 2, migrate: (raw) => raw }],
      },
    };

    expect(() => migrateConfigFile('gap', path, { registry })).toThrow(/no migration step from schemaVersion 2 to 3/);
    expect(readFileSync(path, 'utf8')).toBe(original);
    expect(existsSync(path)).toBe(true);
  });
});
