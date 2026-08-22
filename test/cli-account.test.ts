import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { useTempResources } from './helpers.js';
import { ensureBuilt, runCli } from './helpers/cli.js';

const { tempDir } = useTempResources('heddle-cli-account-test-');

function fixture(accounts: Array<{ id: string; configDir: string | null; loggedIn?: boolean }>, used: Record<string, number>) {
  const dir = tempDir();
  const accountsPath = join(dir, 'accounts.json');
  writeFileSync(accountsPath, JSON.stringify({ claude: accounts }));
  const nowS = Math.floor(Date.now() / 1000);
  writeFileSync(join(dir, 'limits.json'), JSON.stringify({
    writtenAt: nowS,
    limits: [{
      provider: 'claude', capturedAt: nowS, staleAfterSecs: 900,
      accounts: accounts.map((account) => ({
        id: account.id,
        fiveHour: { usedPercentage: used[account.id] },
        sevenDay: {},
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
      account: 'default', configDir: null, usedPct: 40,
      reason: expect.any(String), unsetConfigDir: true, for: 'U',
    });
  }, 30_000);
});
