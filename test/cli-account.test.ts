import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { useTempResources } from './helpers.js';
import { ensureBuilt, runCli } from './helpers/cli.js';

const { tempDir } = useTempResources('heddle-cli-account-test-');

function fixture(
  accounts: Array<{ id: string; configDir: string | null; loggedIn?: boolean }>,
  used: Record<string, number>,
  options: { used7d?: Record<string, number | null>; stale?: boolean; capturedAt?: number; resetsAt?: Record<string, { fiveHour?: number; sevenDay?: number }> } = {},
) {
  const dir = tempDir();
  const accountsPath = join(dir, 'accounts.json');
  writeFileSync(accountsPath, JSON.stringify({ claude: accounts }));
  const nowS = Math.floor(Date.now() / 1000);
  writeFileSync(join(dir, 'limits.json'), JSON.stringify({
    writtenAt: nowS,
    limits: [{
      provider: 'claude', capturedAt: options.capturedAt ?? nowS, staleAfterSecs: 900, stale: options.stale,
      accounts: accounts.map((account) => ({
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

  it('regression PR#87 — excludes an account floored only by 7d and explains the binding meter', async () => {
    const { accountsPath, usageDir } = fixture([
      { id: 'incident', configDir: '/tmp/incident' },
      { id: 'healthy', configDir: '/tmp/healthy' },
    ], { incident: 50, healthy: 40 }, { used7d: { incident: 98, healthy: 50 } });

    const result = await runCli(['account', 'pick', '--explain'], {
      env: { HEDDLE_ACCOUNTS: accountsPath, HEDDLE_USAGE_DIR: usageDir },
    });

    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(result.stdout).toMatch(/incident:.*7d 98%.*7d binds.*floored/);
    expect(result.stdout).toContain('healthy');
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

  it('emits the documented JSON shape', async () => {
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
      reason: expect.any(String),
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
});
