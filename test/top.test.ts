import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CommsLog } from '../src/comms/log.js';
import { Ledger } from '../src/ledger.js';
import { assembleTop, renderTopText } from '../src/top.js';
import { useTempResources, writeMetersPolicy } from './helpers.js';
import { runCli } from './helpers/cli.js';

const { tempDir } = useTempResources('heddle-top-test-');

function fixture(opts: { stale?: boolean; accounts?: number; providerWindow?: boolean } = {}): { usageDir: string; accountsPath: string } {
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
      ...(opts.providerWindow ? { windows: [{ id: 'included-total', usedPercentage: 42, resetsAt: nowS + 86_400 }] } : {}),
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

const metersPolicy = (contents: string): string => writeMetersPolicy(tempDir(), contents);

function snapshot(dir: string): Map<string, number> {
  return new Map(readdirSync(dir).sort().map((name) => [name, statSync(join(dir, name)).mtimeMs]));
}

function snapshotFile(path: string): { mtimeMs: number; size: number; bytes: Buffer } {
  const stat = statSync(path);
  return { mtimeMs: stat.mtimeMs, size: stat.size, bytes: readFileSync(path) };
}

function workerLedger(): string {
  const path = join(tempDir(), 'ledger.db');
  const ledger = new Ledger(path);
  const worker = ledger.start({
    orchestrator: 'U', taskClass: 'implementation', provider: 'codex', model: 'gpt-5.6-terra',
    skills: null, issue: 'HED-430', pr: null, cwd: '/tmp/top', promptPreview: 'worker',
    sessionId: null, fellBackFrom: null,
  });
  ledger.finish(worker, { ok: true });
  for (let index = 0; index < 21; index++) {
    ledger.recordClassification({
      orchestrator: 'U', identitySource: 'test', kind: 'assess', provider: 'codex', model: 'gpt-5.6-luna',
      cwd: '/tmp/top', promptPreview: `classification ${index}`, ok: true,
    });
  }
  ledger.close();
  return path;
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

  it('preserves provider-level meters instead of dropping account:null rows', () => {
    const { usageDir, accountsPath } = fixture({ providerWindow: true });
    const view = assembleTop({ usageDir, accountsPath });

    expect(view.accounts.find((account) => account.id === 'acct-1')?.usage)
      .toEqual(expect.arrayContaining([expect.objectContaining({ account: null, window: 'included-total', usedPercentage: 42 })]));
  });

  it('keeps opted-out accounts visible but with no meters', () => {
    const { usageDir, accountsPath } = fixture();
    const view = assembleTop({
      usageDir, accountsPath,
      metersPolicyPath: metersPolicy(JSON.stringify({ accounts: { 'acct-1': { meters: false } } })),
    });

    expect(view.accounts.find((account) => account.id === 'acct-1')).toMatchObject({ usage: [] });
    expect(view.accounts.find((account) => account.id === 'acct-2')?.usage).not.toHaveLength(0);
  });

  it('fails open for absent, corrupt, and directory policy paths', () => {
    const { usageDir, accountsPath } = fixture({ providerWindow: true });
    const absent = join(tempDir(), 'absent-meters.json');
    const corrupt = metersPolicy('{ not json');
    const directory = join(tempDir(), 'meters-directory');
    mkdirSync(directory);

    for (const metersPolicyPath of [absent, corrupt, directory]) {
      expect(() => assembleTop({ usageDir, accountsPath, metersPolicyPath })).not.toThrow();
      const view = assembleTop({ usageDir, accountsPath, metersPolicyPath });
      expect(view.accounts.find((account) => account.id === 'acct-1')?.usage).not.toHaveLength(0);
      expect(view.accounts.find((account) => account.id === 'acct-1')?.usage)
        .toEqual(expect.arrayContaining([expect.objectContaining({ account: null, window: 'included-total' })]));
    }
  });

  it('shows opted-in and unlisted accounts', () => {
    const { usageDir, accountsPath } = fixture();
    const view = assembleTop({
      usageDir, accountsPath,
      metersPolicyPath: metersPolicy(JSON.stringify({ accounts: { 'acct-1': { meters: true } } })),
    });

    expect(view.accounts.find((account) => account.id === 'acct-1')?.usage).not.toHaveLength(0);
    expect(view.accounts.find((account) => account.id === 'acct-2')?.usage).not.toHaveLength(0);
  });

  it('does not attach provider-level meters to an opted-out first account', () => {
    const { usageDir, accountsPath } = fixture({ providerWindow: true });
    const view = assembleTop({
      usageDir, accountsPath,
      metersPolicyPath: metersPolicy(JSON.stringify({ accounts: { 'acct-1': { meters: false } } })),
    });

    // acct-1 is the first account, so the provider-level row previously attached to it; opting it out must
    // suppress BOTH its per-account meters AND the provider-level row — the latter moves to acct-2.
    expect(view.accounts.find((account) => account.id === 'acct-1')?.usage).toEqual([]);
    expect(view.accounts.find((account) => account.id === 'acct-2')?.usage)
      .toEqual(expect.arrayContaining([expect.objectContaining({ account: null, window: 'included-total' })]));
  });

  it('reads HEDDLE_LEDGER_DB without changing the ledger or showing classifications as workers', async () => {
    const { usageDir, accountsPath } = fixture();
    const ledgerPath = workerLedger();
    const before = snapshotFile(ledgerPath);
    const result = await runCli(['top', '--json'], {
      env: { HEDDLE_USAGE_DIR: usageDir, HEDDLE_ACCOUNTS: accountsPath, HEDDLE_LEDGER_DB: ledgerPath },
    });
    const view = JSON.parse(result.stdout) as { workers: Array<{ dispatch: { task_class: string; execution_mode: string | null } }> };

    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(view.workers.map((worker) => worker.dispatch.task_class)).toEqual(['implementation']);
    expect(view.workers.every((worker) => worker.dispatch.execution_mode !== 'classification')).toBe(true);
    expect(snapshotFile(ledgerPath)).toEqual(before);
  });

  it('uses nowS for session liveness as well as meter freshness', () => {
    const { usageDir, accountsPath } = fixture();
    const commsPath = join(tempDir(), 'comms.db');
    const nowS = 1_000_000_000;
    const log = new CommsLog(commsPath, { now: () => new Date((nowS - 10) * 1_000).toISOString() });
    log.registerSession({ address: 'U', sessionId: 'session-u' });
    log.close();
    const before = snapshotFile(commsPath);

    const view = assembleTop({ usageDir, accountsPath, commsPath, nowS });
    expect(view.agents).toMatchObject([{ session: { address: 'U', sessionId: 'session-u' } }]);
    expect(snapshotFile(commsPath)).toEqual(before);
  });

  it('renders the supplied view without reading sources', () => {
    const text = renderTopText({ capturedAt: '2026-09-13T00:00:00.000Z', accounts: [], agents: [], workers: [] });
    expect(text).toContain('(no data)');
  });
});
