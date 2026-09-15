import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { filterByMetersPolicy, readOptedOutAccounts } from '../src/meters-policy.js';
import { useTempResources, writeMetersPolicy } from './helpers.js';

const { tempDir } = useTempResources('heddle-meters-policy-test-');

describe('meters policy', () => {
  it('collects only accounts explicitly opted out (lower-cased) and ignores the rest', () => {
    const optedOut = readOptedOutAccounts(writeMetersPolicy(tempDir(), JSON.stringify({ accounts: {
      Alpha: { meters: false }, beta: { meters: true }, gamma: {},
    } })));
    // opted-in (beta) and unspecified (gamma) are not collected; the id is lower-cased
    expect(optedOut).toEqual(new Set(['alpha']));
  });

  it('fails open for absent, corrupt, directory, array-shaped, or partially-malformed policies', () => {
    const corrupt = writeMetersPolicy(tempDir(), '{ not json');
    const directory = join(tempDir(), 'directory');
    mkdirSync(directory);
    // typeof [] === 'object', so an array map must be rejected — its numeric index must NOT become id "0"
    const arrayShaped = writeMetersPolicy(tempDir(), JSON.stringify({ accounts: [{ meters: false }] }));
    // a single malformed entry taints the whole policy (mirrors the wizard writer's validator) → show all
    const badEntry = writeMetersPolicy(tempDir(), JSON.stringify({ accounts: { a: { meters: false }, b: null } }));
    const badType = writeMetersPolicy(tempDir(), JSON.stringify({ accounts: { a: { meters: 'no' } } }));

    expect(readOptedOutAccounts(join(tempDir(), 'absent.json'))).toEqual(new Set());
    expect(readOptedOutAccounts(corrupt)).toEqual(new Set());
    expect(readOptedOutAccounts(directory)).toEqual(new Set());
    expect(readOptedOutAccounts(arrayShaped)).toEqual(new Set());
    expect(readOptedOutAccounts(badEntry)).toEqual(new Set());
    expect(readOptedOutAccounts(badType)).toEqual(new Set());
  });

  it('filters opted-out rows case-insensitively, preserves provider rows, and is identity for an empty set', () => {
    const rows = [
      { account: 'Alpha', value: 1 },
      { account: 'beta', value: 2 },
      { account: null, value: 3 },
    ];
    // the opted-out set is lower-cased (as readOptedOutAccounts produces it); a mixed-case row still matches
    expect(filterByMetersPolicy(rows, new Set(['alpha']))).toEqual([
      { account: 'beta', value: 2 },
      { account: null, value: 3 },
    ]);
    expect(filterByMetersPolicy(rows, new Set())).toBe(rows);
  });
});
