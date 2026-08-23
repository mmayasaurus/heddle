import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { useTempResources } from './helpers.js';
import { ensureBuilt, runCli } from './helpers/cli.js';

const { tempDir } = useTempResources('heddle-cli-account-test-');

function fixture(
  accounts: Array<{ id: string; configDir: string | null; loggedIn?: boolean }>,
  used: Record<string, number>,
  options: {
    used7d?: Record<string, number | null>;
    stale?: boolean;
    capturedAt?: number;
    resetsAt?: Record<string, { fiveHour?: number; sevenDay?: number }>;
    includedAccountIds?: string[];
  } = {},
) {
  const dir = tempDir();
  const accountsPath = join(dir, 'accounts.json');
  writeFileSync(accountsPath, JSON.stringify({ claude: accounts }));
  const nowS = Math.floor(Date.now() / 1000);
  writeFileSync(join(dir, 'limits.json'), JSON.stringify({
    writtenAt: nowS,
    limits: [{
      provider: 'claude', capturedAt: options.capturedAt ?? nowS, staleAfterSecs: 900, stale: options.stale,
      accounts: accounts.filter((account) => options.includedAccountIds?.includes(account.id) ?? true).map((account) => ({
        id: account.id,
        fiveHour: { usedPercentage: used[account.id], resetsAt: options.resetsAt?.[account.id]?.fiveHour },
        sevenDay: options.used7d?.[account.id] === null ? {} : { usedPercentage: options.used7d?.[account.id], resetsAt: options.resetsAt?.[account.id]?.sevenDay },
      })),
    }],
  }));
  return { accountsPath, usageDir: dir };
}

describe('heddle account pick CLI', () => {
  beforeAll(async () => {
    await ensureBuilt();
  }, 120_000);

  it('excludes a floored account and chooses the healthy account', async () => {
    const { accountsPath, usageDir } = fixture([
      { id: 'floored', configDir: '/tmp/floored' },
      { id: 'healthy', configDir: '/tmp/healthy' },
    ], { floored: 98, healthy: 40 });

    const result = await runCli(['account', 'pick', '--explain'], {
      env: { HEDDLE_ACCOUNTS: accountsPath, HEDDLE_USAGE_DIR: usageDir },
    });

    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(result.stdout).toContain('healthy');
    expect(result.stdout).toContain('CLAUDE_CONFIG_DIR=/tmp/healthy');
    expect(result.stdout).toMatch(/floored.*floored/);
  }, 30_000);

  it('regression PR#87 — a 7d-floored account with the BEST 5h headroom is still excluded from the pick', async () => {
    // incident has the LOWEST 5h used% (a 5h-only ranking would select it) but is 7d-exhausted; the
    // pre-fix 5h-only floor would relaunch onto it. The two-meter floor must exclude it and pick the
    // 7d-healthy account — asserted via which CLAUDE_CONFIG_DIR the selected line emits, so the test
    // fails on the pre-fix behavior (grok adversarial review, HED-261).
    const { accountsPath, usageDir } = fixture([
      { id: 'incident', configDir: '/tmp/incident' },
      { id: 'healthy', configDir: '/tmp/healthy' },
    ], { incident: 10, healthy: 40 }, { used7d: { incident: 98, healthy: 50 } });

    const result = await runCli(['account', 'pick', '--explain'], {
      env: { HEDDLE_ACCOUNTS: accountsPath, HEDDLE_USAGE_DIR: usageDir },
    });

    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(result.stdout).toContain('CLAUDE_CONFIG_DIR=/tmp/healthy');      // healthy is the PICK
    expect(result.stdout).not.toContain('CLAUDE_CONFIG_DIR=/tmp/incident'); // incident excluded, not picked
    expect(result.stdout).toMatch(/incident:.*7d 98%.*7d binds.*floored/);  // explain shows why
  }, 30_000);

  it('refuses when all registered accounts are floored', async () => {
    const { accountsPath, usageDir } = fixture([
      { id: 'almost-full', configDir: '/tmp/almost-full' },
      { id: 'full', configDir: null },
    ], { 'almost-full': 98, full: 100 });

    const result = await runCli(['account', 'pick'], {
      env: { HEDDLE_ACCOUNTS: accountsPath, HEDDLE_USAGE_DIR: usageDir },
    });

    expect(result.code).toBe(1);
    expect(result.stdout).toBe(''); // a refusal must NEVER print a (floored) account as the pick
    expect(result.stderr).toMatch(/2 floored/);
    expect(result.stderr).toMatch(/headroom ≤ 3%/);
  }, 30_000);

  it('emits the documented JSON shape, echoes --for, and carries --explain accounts', async () => {
    const { accountsPath, usageDir } = fixture([
      { id: 'default', configDir: null },
      { id: 'other', configDir: '/tmp/other' },
    ], { default: 40, other: 80 });

    const result = await runCli(['account', 'pick', '--for', 'U', '--json'], {
      env: { HEDDLE_ACCOUNTS: accountsPath, HEDDLE_USAGE_DIR: usageDir },
    });

    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(result.stdout)).toEqual({
      account: 'default', configDir: null, unsetConfigDir: true,
      usedPct5h: 40, usedPct7d: null, bindingMeter: '5h', resetsAt: null,
      reason: expect.any(String), for: 'U',
    });

    // --json --explain must still carry the per-account breakdown programmatically (parity with text
    // mode; the JSON rewrite had dropped it — grok adversarial review, HED-261).
    const explained = await runCli(['account', 'pick', '--for', 'U', '--json', '--explain'], {
      env: { HEDDLE_ACCOUNTS: accountsPath, HEDDLE_USAGE_DIR: usageDir },
    });
    const parsed = JSON.parse(explained.stdout);
    expect(parsed.for).toBe('U');
    expect(parsed.accounts).toHaveLength(2);
    expect(parsed.accounts.map((a: { account: string }) => a.account).sort()).toEqual(['default', 'other']);
  }, 30_000);

  it('keeps a singleton --for payload byte-stable instead of wrapping it as a batch map', async () => {
    const { accountsPath, usageDir } = fixture([
      { id: 'default', configDir: null },
      { id: 'other', configDir: '/tmp/other' },
    ], { default: 40, other: 80 });

    const result = await runCli(['account', 'pick', '--for', 'U', '--json'], {
      env: { HEDDLE_ACCOUNTS: accountsPath, HEDDLE_USAGE_DIR: usageDir },
    });

    expect(result).toEqual({
      code: 0,
      stderr: '',
      stdout: '{\n' +
        '  "account": "default",\n' +
        '  "configDir": null,\n' +
        '  "unsetConfigDir": true,\n' +
        '  "usedPct5h": 40,\n' +
        '  "usedPct7d": null,\n' +
        '  "bindingMeter": "5h",\n' +
        '  "resetsAt": null,\n' +
        '  "reason": "account:default (5h 40%, most headroom of 2 fresh)",\n' +
        '  "for": "U"\n' +
        '}\n',
    });
  }, 30_000);

  it('does not crash when limits.json has no Claude provider data', async () => {
    const dir = tempDir();
    const accountsPath = join(dir, 'accounts.json');
    writeFileSync(accountsPath, JSON.stringify({ claude: [{ id: 'default', configDir: null }] }));

    const result = await runCli(['account', 'pick'], {
      env: { HEDDLE_ACCOUNTS: accountsPath, HEDDLE_USAGE_DIR: dir },
    });

    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/caps are missing or stale.*data age unknown/);
    expect(result.stderr).not.toMatch(/TypeError|\.find\(/);
  }, 30_000);

  it('exits 2 with the capture age when Claude caps are stale', async () => {
    const { accountsPath, usageDir } = fixture(
      [{ id: 'default', configDir: null }], { default: 40 }, { stale: true, capturedAt: 1 },
    );

    const result = await runCli(['account', 'pick'], {
      env: { HEDDLE_ACCOUNTS: accountsPath, HEDDLE_USAGE_DIR: usageDir },
    });

    expect(result).toMatchObject({ code: 2, stdout: '' });
    expect(result.stderr).toMatch(/caps are missing or stale.*data age \d+s \(capturedAt 1, budget \d+s\)/);
  }, 30_000);

  it('regression HED-348 — exits 2 on an old capture even when the stale flag reads false', async () => {
    // The keeper can leave limits.json's writtenAt fresh (rewritten ~every 5 min) while a Claude
    // provider entry's capturedAt lags and its own stale flag reads false (no staleAfterSecs → the
    // per-provider pastOwnWindow check can't fire). Picking on that hours-old, 45–50%-wrong data is
    // the exact rollover risk; age-keyed exit-2 must catch it regardless of the flag.
    const dir = tempDir();
    const accountsPath = join(dir, 'accounts.json');
    writeFileSync(accountsPath, JSON.stringify({ claude: [{ id: 'default', configDir: null }] }));
    const nowS = Math.floor(Date.now() / 1000);
    writeFileSync(join(dir, 'limits.json'), JSON.stringify({
      writtenAt: nowS, // file freshly rewritten by the keeper
      limits: [{
        provider: 'claude', capturedAt: nowS - 4 * 60 * 60, stale: false, // 4h old, but the flag lies
        accounts: [{ id: 'default', fiveHour: { usedPercentage: 40 }, sevenDay: { usedPercentage: 50 } }],
      }],
    }));

    const result = await runCli(['account', 'pick'], {
      env: { HEDDLE_ACCOUNTS: accountsPath, HEDDLE_USAGE_DIR: dir },
    });

    expect(result).toMatchObject({ code: 2, stdout: '' });
    expect(result.stderr).toMatch(/caps are missing or stale.*data age \d+s.*budget \d+s/);
  }, 30_000);

  it('keeps --json self-contained on stdout and returns the binding reset time', async () => {
    const reset7d = Math.floor(Date.now() / 1000) + 200;
    const { accountsPath, usageDir } = fixture(
      [{ id: 'default', configDir: null }], { default: 40 },
      { used7d: { default: 80 }, resetsAt: { default: { fiveHour: reset7d - 100, sevenDay: reset7d } } },
    );

    const result = await runCli(['account', 'pick', '--json'], {
      env: { HEDDLE_ACCOUNTS: accountsPath, HEDDLE_USAGE_DIR: usageDir },
    });

    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(result.stdout)).toMatchObject({
      account: 'default', usedPct5h: 40, usedPct7d: 80, bindingMeter: '7d', resetsAt: reset7d,
    });
  }, 30_000);

  it('rejects a missing --for value instead of consuming --json', async () => {
    const { accountsPath, usageDir } = fixture([{ id: 'default', configDir: null }], { default: 40 });

    const result = await runCli(['account', 'pick', '--for', '--json'], {
      env: { HEDDLE_ACCOUNTS: accountsPath, HEDDLE_USAGE_DIR: usageDir },
    });

    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/usage: heddle account pick/);
  }, 30_000);

  it('balances six batch placements across three healthy accounts instead of stacking them', async () => {
    const { accountsPath, usageDir } = fixture([
      { id: 'a', configDir: '/tmp/a' }, { id: 'b', configDir: '/tmp/b' }, { id: 'c', configDir: '/tmp/c' },
    ], { a: 30, b: 20, c: 10 });

    const result = await runCli(['account', 'pick', '--for', 'R,S,T,U,V,W', '--json'], {
      env: { HEDDLE_ACCOUNTS: accountsPath, HEDDLE_USAGE_DIR: usageDir },
    });

    expect(result).toMatchObject({ code: 0, stderr: '' });
    const assignments = JSON.parse(result.stdout).assignments as Record<string, { account: string }>;
    expect(Object.values(assignments).reduce<Record<string, number>>((counts, { account }) => {
      counts[account] = (counts[account] ?? 0) + 1;
      return counts;
    }, {})).toEqual({ a: 2, b: 2, c: 2 });
    expect(Object.values(assignments).map(({ account }) => account)).toEqual(['c', 'b', 'a', 'c', 'b', 'a']);
  }, 30_000);

  it('uses higher headroom before account id when batch residents are tied', async () => {
    const { accountsPath, usageDir } = fixture([
      { id: 'a-first', configDir: '/tmp/a-first' }, { id: 'z-healthier', configDir: '/tmp/z-healthier' },
    ], { 'a-first': 30, 'z-healthier': 10 });

    const result = await runCli(['account', 'pick', '--for', 'R,S', '--json'], {
      env: { HEDDLE_ACCOUNTS: accountsPath, HEDDLE_USAGE_DIR: usageDir },
    });

    expect(result).toMatchObject({ code: 0, stderr: '' });
    const assignments = JSON.parse(result.stdout).assignments as Record<string, { account: string }>;
    expect(assignments.R.account).toBe('z-healthier');
  }, 30_000);

  it('counts its own batch placements before choosing the next account', async () => {
    const { accountsPath, usageDir } = fixture([
      { id: 'freshest', configDir: '/tmp/freshest' }, { id: 'other', configDir: '/tmp/other' },
    ], { freshest: 10, other: 30 });

    const result = await runCli(['account', 'pick', '--for', 'R,S', '--json'], {
      env: { HEDDLE_ACCOUNTS: accountsPath, HEDDLE_USAGE_DIR: usageDir },
    });

    expect(result).toMatchObject({ code: 0, stderr: '' });
    const assignments = JSON.parse(result.stdout).assignments as Record<string, { account: string }>;
    expect(assignments.R.account).toBe('freshest');
    expect(assignments.S.account).toBe('other');
  }, 30_000);

  it('caps low-headroom residency and refuses overflow when no other healthy account remains', async () => {
    const { accountsPath, usageDir } = fixture([
      { id: 'near-cap', configDir: '/tmp/near-cap' }, { id: 'floored', configDir: '/tmp/floored' },
    ], { 'near-cap': 95, floored: 98 });

    const result = await runCli(['account', 'pick', '--for', 'R,S,U', '--json', '--explain'], {
      env: { HEDDLE_ACCOUNTS: accountsPath, HEDDLE_USAGE_DIR: usageDir },
    });

    expect(result.code).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.assignments.R.account).toBe('near-cap');
    expect(parsed.assignments.S.account).toBe('near-cap');
    expect(parsed.assignments.U).toMatchObject({ refused: true, reason: expect.stringMatching(/1 floored.*1 at residency cap/) });
    expect(parsed.accounts).toEqual(expect.arrayContaining([
      expect.objectContaining({ account: 'near-cap', residents: 2 }),
      expect.objectContaining({ account: 'floored', floored: true }),
    ]));
  }, 30_000);

  it('applies the residency cap INCLUSIVELY at exactly residency_cap_below_pct headroom', async () => {
    // headroom EXACTLY 10 (used 90, = residency_cap_below_pct) must trigger the cap — the ratified
    // "≤10%" + the inclusive floor precedent. A strict `< 10` would wrongly place all three.
    const { accountsPath, usageDir } = fixture([{ id: 'edge', configDir: '/tmp/edge' }], { edge: 90 });

    const result = await runCli(['account', 'pick', '--for', 'R,S,U', '--json'], {
      env: { HEDDLE_ACCOUNTS: accountsPath, HEDDLE_USAGE_DIR: usageDir },
    });

    expect(result.code).toBe(1);
    const a = JSON.parse(result.stdout).assignments;
    expect(a.R.account).toBe('edge');
    expect(a.S.account).toBe('edge');
    expect(a.U).toMatchObject({ refused: true, reason: expect.stringMatching(/residency cap/) });
  }, 30_000);

  it('applies the residency cap when the 7d meter, not 5h, reaches the boundary', async () => {
    const { accountsPath, usageDir } = fixture(
      [{ id: 'weekly-edge', configDir: '/tmp/weekly-edge' }], { 'weekly-edge': 50 }, { used7d: { 'weekly-edge': 90 } },
    );

    const result = await runCli(['account', 'pick', '--for', 'R,S,U', '--json'], {
      env: { HEDDLE_ACCOUNTS: accountsPath, HEDDLE_USAGE_DIR: usageDir },
    });

    expect(result.code).toBe(1);
    const assignments = JSON.parse(result.stdout).assignments;
    expect(assignments.R.account).toBe('weekly-edge');
    expect(assignments.S.account).toBe('weekly-edge');
    expect(assignments.U).toMatchObject({ refused: true, reason: expect.stringMatching(/residency cap/) });
  }, 30_000);

  it('never assigns a 7d-floored account in batch mode', async () => {
    const { accountsPath, usageDir } = fixture([
      { id: 'weekly-wall', configDir: '/tmp/weekly-wall' }, { id: 'healthy', configDir: '/tmp/healthy' },
    ], { 'weekly-wall': 10, healthy: 40 }, { used7d: { 'weekly-wall': 98, healthy: 40 } });

    const result = await runCli(['account', 'pick', '--for', 'R,S', '--json'], {
      env: { HEDDLE_ACCOUNTS: accountsPath, HEDDLE_USAGE_DIR: usageDir },
    });

    const assignments = JSON.parse(result.stdout).assignments as Record<string, { account: string }>;
    expect(assignments.R.account).toBe('healthy');
    expect(assignments.S.account).toBe('healthy');
  }, 30_000);

  it('regression PR#88 — never places a batch agent on an unmetered registered account', async () => {
    const { accountsPath, usageDir } = fixture([
      { id: 'healthy', configDir: '/tmp/healthy' }, { id: 'ghost', configDir: '/tmp/ghost' },
    ], { healthy: 60, ghost: 0 }, { includedAccountIds: ['healthy'] });

    const result = await runCli(['account', 'pick', '--for', 'R,S', '--json'], {
      env: { HEDDLE_ACCOUNTS: accountsPath, HEDDLE_USAGE_DIR: usageDir },
    });

    expect(result).toMatchObject({ code: 0, stderr: '' });
    const assignments = JSON.parse(result.stdout).assignments as Record<string, { account: string }>;
    expect(assignments.R.account).toBe('healthy');
    expect(assignments.S.account).toBe('healthy');
    expect(Object.values(assignments).map(({ account }) => account)).not.toContain('ghost');
  }, 30_000);

  it('refuses an all-unmetered batch and identifies its exclusive refusal bucket', async () => {
    const { accountsPath, usageDir } = fixture(
      [{ id: 'ghost', configDir: '/tmp/ghost' }], { ghost: 0 }, { includedAccountIds: [] },
    );

    const result = await runCli(['account', 'pick', '--for', 'R,S', '--json'], {
      env: { HEDDLE_ACCOUNTS: accountsPath, HEDDLE_USAGE_DIR: usageDir },
    });

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).assignments.R).toMatchObject({
      refused: true, reason: expect.stringMatching(/1 unmetered/),
    });
  }, 30_000);

  it('counts an account once in batch refusal reasons by priority', async () => {
    const { accountsPath, usageDir } = fixture(
      [{ id: 'logged-out-and-floored', configDir: null, loggedIn: false }], { 'logged-out-and-floored': 98 },
    );

    const result = await runCli(['account', 'pick', '--for', 'R,S', '--json'], {
      env: { HEDDLE_ACCOUNTS: accountsPath, HEDDLE_USAGE_DIR: usageDir },
    });

    expect(result.code).toBe(1);
    const refusal = JSON.parse(result.stdout).assignments.R;
    expect(refusal).toMatchObject({ refused: true, reason: expect.stringMatching(/1 logged-out/) });
    expect(refusal.reason).toMatch(/0 floored/);
  }, 30_000);

  it('uses the same stale-caps gate for the whole batch', async () => {
    const { accountsPath, usageDir } = fixture(
      [{ id: 'default', configDir: null }], { default: 40 }, { stale: true, capturedAt: 1 },
    );

    const result = await runCli(['account', 'pick', '--for', 'R,S', '--json'], {
      env: { HEDDLE_ACCOUNTS: accountsPath, HEDDLE_USAGE_DIR: usageDir },
    });

    expect(result).toMatchObject({ code: 2, stdout: '' });
    expect(result.stderr).toMatch(/caps are missing or stale.*data age/);
  }, 30_000);

  it('regression HED-348 — exits 2 for a batch when capturedAt is old but stale is false', async () => {
    const dir = tempDir();
    const accountsPath = join(dir, 'accounts.json');
    writeFileSync(accountsPath, JSON.stringify({ claude: [{ id: 'default', configDir: null }] }));
    const nowS = Math.floor(Date.now() / 1000);
    writeFileSync(join(dir, 'limits.json'), JSON.stringify({
      writtenAt: nowS,
      limits: [{
        provider: 'claude', capturedAt: nowS - 4 * 60 * 60, stale: false,
        accounts: [{ id: 'default', fiveHour: { usedPercentage: 40 }, sevenDay: { usedPercentage: 50 } }],
      }],
    }));

    const result = await runCli(['account', 'pick', '--for', 'R,S', '--json'], {
      env: { HEDDLE_ACCOUNTS: accountsPath, HEDDLE_USAGE_DIR: dir },
    });

    expect(result).toMatchObject({ code: 2, stdout: '' });
    expect(result.stderr).toMatch(/caps are missing or stale.*data age \d+s.*budget \d+s/);
  }, 30_000);

  it('treats duplicate singleton --for identities exactly like a singleton pick', async () => {
    const { accountsPath, usageDir } = fixture([
      { id: 'default', configDir: null }, { id: 'other', configDir: '/tmp/other' },
    ], { default: 40, other: 80 });
    const env = { HEDDLE_ACCOUNTS: accountsPath, HEDDLE_USAGE_DIR: usageDir };

    const singleton = await runCli(['account', 'pick', '--for', 'R', '--json'], { env });
    const duplicates = await runCli(['account', 'pick', '--for', 'R,R', '--json'], { env });

    expect(duplicates).toEqual(singleton);
    expect(JSON.parse(duplicates.stdout)).toMatchObject({ account: 'default', configDir: null, for: 'R' });
    expect(JSON.parse(duplicates.stdout)).not.toHaveProperty('assignments');
  }, 30_000);
});
