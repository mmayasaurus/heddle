import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { filterByMetersPolicy, readOptedOutAccounts } from '../src/meters-policy.js';
import { useTempResources } from './helpers.js';

const { tempDir } = useTempResources('heddle-meters-policy-test-');

describe('meters policy', () => {
  it('collects only accounts explicitly opted out and fails open for bad paths', () => {
    const policyPath = join(tempDir(), 'meters.json');
    writeFileSync(policyPath, JSON.stringify({ accounts: {
      optedOut: { meters: false }, optedIn: { meters: true }, unspecified: {}, malformed: null,
    } }));
    const corruptPath = join(tempDir(), 'corrupt.json');
    writeFileSync(corruptPath, '{ not json');
    const directoryPath = join(tempDir(), 'directory');
    mkdirSync(directoryPath);

    expect(readOptedOutAccounts(policyPath)).toEqual(new Set(['optedOut']));
    expect(readOptedOutAccounts(join(tempDir(), 'absent.json'))).toEqual(new Set());
    expect(readOptedOutAccounts(corruptPath)).toEqual(new Set());
    expect(readOptedOutAccounts(directoryPath)).toEqual(new Set());
  });

  it('filters opted-out account rows while preserving provider rows and identity for an empty set', () => {
    const rows = [
      { account: 'optedOut', value: 1 },
      { account: 'optedIn', value: 2 },
      { account: null, value: 3 },
    ];

    expect(filterByMetersPolicy(rows, new Set(['optedOut']))).toEqual([
      { account: 'optedIn', value: 2 },
      { account: null, value: 3 },
    ]);
    expect(filterByMetersPolicy(rows, new Set())).toBe(rows);
  });
});
