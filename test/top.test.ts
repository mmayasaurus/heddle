import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assembleTop, renderTopText } from '../src/top.js';
import { useTempResources } from './helpers.js';
import { runCli } from './helpers/cli.js';

const { tempDir } = useTempResources('heddle-top-test-');

function fixture(opts: { stale?: boolean; accounts?: number } = {}): { usageDir: string; accountsPath: string } {
  const usageDir = tempDir();
  const accountsPath = join(usageDir, 'accounts.json');
  const nowS = Math.floor(Date.now() / 1_000);
  const accounts = Array.from({ length: opts.accounts ?? 2 }, (_, index) => ({
    id: `acct-${index + 1}`,
    configDir: null,
    loggedIn: index !== 1,
    tier: 'T1',
    billingClass: 'subscription-quota',
  }));
  writeFileSync(accountsPath, JSON.stringify({ claude: accounts }));
  writeFileSync(join(usageDir, 'limits.json'), JSON.stringify({
    writtenAt: nowS,
    limits: [{
      provider: 'claude',
      capturedAt: nowS - (opts.stale ? 1_200 : 120),
      staleAfterSecs: 900,
      accounts: accounts.map((account, index) => ({
        id: account.id,
        fiveHour: { usedPercentage: 20 + index, resetsAt: nowS + 3_600 },
        sevenDay: { usedPercentage: 30 + index, resetsAt: nowS + 86_400 },
      })),
    }],
  }));
  writeFileSync(join(usageDir, 'claude-acct-1.json'), JSON.stringify({
    rate_limits: {
      five_hour: { used_percentage: 20, resets_at: nowS + 3_600 },
      seven_day: { used_percentage: 30, resets_at: nowS + 86_400 },
    },
    capturedAt: nowS - (opts.stale ? 1_200 : 120),
  }));
  writeFileSync(join(usageDir, 'claude-acct-1.dispatch.json'), JSON.stringify({
    schemaVersion: 1, account: 'acct-1', dispatchable: true, reason: 'ok', checkedAt: nowS - 30,
  }));
  return { usageDir, accountsPath };
}

function snapshot(dir: string): Map<string, number> {
  return new Map(readdirSync(dir).sort().map((name) => [name, statSync(join(dir, name)).mtimeMs]));
}

describe('heddle top', () => {
  it('assembles registered accounts with 5h/7d meters and login state from disk', () => {
    const { usageDir, accountsPath } = fixture();
    const view = assembleTop({ usageDir, accountsPath });

    expect(view.accounts).toHaveLength(2);
    expect(view.accounts[0]).toMatchObject({ id: 'acct-1', provider: 'claude', loggedIn: true });
    expect(view.accounts[0].usage.map((row) => row.window)).toEqual(['5h', '7d']);
    expect(view.accounts[1]).toMatchObject({ id: 'acct-2', loggedIn: false });
    expect(view.accounts[0].usage[0]).toMatchObject({ ageSecs: expect.any(Number), source: 'vendor-meter' });
  });

  it('renders absent roster and ledger sources as empty panels without throwing', async () => {
    const { usageDir, accountsPath } = fixture();
    const result = await runCli(['top', '--once'], { env: { HEDDLE_USAGE_DIR: usageDir, HEDDLE_ACCOUNTS: accountsPath } });

    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(result.stdout).toContain('(no data)');
    expect(result.stdout).toContain('acct-1');
  });

  it('keeps --json and text on the same assembled account data', async () => {
    const { usageDir, accountsPath } = fixture({ accounts: 1 });
    const [text, json] = await Promise.all([
      runCli(['top', '--once'], { env: { HEDDLE_USAGE_DIR: usageDir, HEDDLE_ACCOUNTS: accountsPath } }),
      runCli(['top', '--json'], { env: { HEDDLE_USAGE_DIR: usageDir, HEDDLE_ACCOUNTS: accountsPath } }),
    ]);
    const view = JSON.parse(json.stdout) as { accounts: Array<{ id: string }> };

    expect(text).toMatchObject({ code: 0, stderr: '' });
    expect(json).toMatchObject({ code: 0, stderr: '' });
    expect(view.accounts).toHaveLength(1);
    expect(text.stdout).toContain(view.accounts[0].id);
  });

  it('flags stale captures in text and JSON', async () => {
    const { usageDir, accountsPath } = fixture({ stale: true });
    const [text, json] = await Promise.all([
      runCli(['top'], { env: { HEDDLE_USAGE_DIR: usageDir, HEDDLE_ACCOUNTS: accountsPath } }),
      runCli(['top', '--json'], { env: { HEDDLE_USAGE_DIR: usageDir, HEDDLE_ACCOUNTS: accountsPath } }),
    ]);

    expect(text.stdout).toContain('*stale*');
    expect(JSON.parse(json.stdout).accounts[0].usage[0].stale).toBe(true);
  });

  it('rejects unknown top flags with usage and exit 2', async () => {
    const result = await runCli(['top', '--watch']);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('usage: heddle top [--once] [--json]');
  });

  it('does not create or modify usage artifacts', async () => {
    const { usageDir, accountsPath } = fixture();
    const before = snapshot(usageDir);
    const result = await runCli(['top', '--json'], { env: { HEDDLE_USAGE_DIR: usageDir, HEDDLE_ACCOUNTS: accountsPath } });

    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(snapshot(usageDir)).toEqual(before);
  });

  it('renders the supplied view without reading sources', () => {
    const text = renderTopText({ capturedAt: '2026-09-13T00:00:00.000Z', accounts: [], agents: [], workers: [] });
    expect(text).toContain('(no data)');
  });
});
