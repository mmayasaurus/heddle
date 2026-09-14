import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderCaps } from '../src/usage.js';
import { fakeAdapter, IDENTITIES, useTempResources } from './helpers.js';

const savedHome = process.env.HOME;
const savedAccounts = process.env.HEDDLE_ACCOUNTS;

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedAccounts === undefined) delete process.env.HEDDLE_ACCOUNTS;
  else process.env.HEDDLE_ACCOUNTS = savedAccounts;
  vi.resetModules();
});

describe('dispatch — env-repoint credentials (HED-531)', () => {
  const { tempDir, tempLedger } = useTempResources('heddle-dispatch-env-repoint-test-');

  it('refuses and ledgers a missing env-repoint token without spawning or writing Claude settings', async () => {
    const home = tempDir();
    const heddleDir = join(home, '.heddle');
    mkdirSync(heddleDir);
    writeFileSync(join(heddleDir, 'secrets.env'), 'OTHER_KEY=SYNTHETIC_VALUE_THAT_MUST_NOT_LEAK\n');
    const accountsPath = join(heddleDir, 'accounts.json');
    writeFileSync(accountsPath, JSON.stringify({ schemaVersion: 2, claude: [{
      id: 'kimi-free', configDir: null, billingClass: 'free-tier',
      envRepoint: { baseUrl: 'https://kimi.example.test/anthropic', authTokenRef: 'MISSING_REPOINT_KEY', service: 'kimi' },
    }] }));
    process.env.HOME = home;
    process.env.HEDDLE_ACCOUNTS = accountsPath;
    vi.resetModules();
    const { dispatch } = await import('../src/dispatch.js');
    const fake = fakeAdapter(undefined, { readAgents: false });
    const caps: ProviderCaps = {
      provider: 'claude', source: 'fixture', stale: false, capturedAt: 1,
      fiveHour: { usedPercentage: 1, resetsAt: null }, sevenDay: { usedPercentage: null, resetsAt: null },
      windows: {}, noteCodes: [], activeAccount: 'kimi-free',
      accounts: [{ id: 'kimi-free', fiveHour: { usedPercentage: 1, resetsAt: null }, sevenDay: { usedPercentage: null, resetsAt: null }, windows: {}, noteCodes: [], limitReached: false, stale: false }],
    };

    const ledger = tempLedger();
    const outcome = await dispatch({
      taskClass: 'research-summarize', prompt: 'x', cwd: tempDir(), identity: IDENTITIES.unbound,
      accounts: [{ id: 'kimi-free', configDir: null, envRepoint: { baseUrl: 'https://kimi.example.test/anthropic', authTokenRef: 'MISSING_REPOINT_KEY', service: 'kimi' } }],
      caps: { claude: caps },
    }, ledger, () => fake.adapter);

    expect(outcome.refusal?.code).toBe('env-repoint.missing-token');
    expect(outcome.error).toContain('kimi: MISSING_REPOINT_KEY not found in ~/.heddle/secrets.env');
    expect(outcome.error).not.toContain('SYNTHETIC_VALUE_THAT_MUST_NOT_LEAK');
    expect(fake.calls).toHaveLength(0);
    expect(ledger.recent(1)[0]).toMatchObject({ refusal: 'env-repoint.missing-token' });
    expect(existsSync(join(home, '.claude', 'settings.json'))).toBe(false);
  });

  it('resolves a synthetic secrets.env token into the selected Kimi worker environment only', async () => {
    const home = tempDir();
    const heddleDir = join(home, '.heddle');
    mkdirSync(heddleDir);
    writeFileSync(join(heddleDir, 'secrets.env'), 'KIMI_FREE_TEST_KEY=synthetic-kimi-free-token\n');
    const accountsPath = join(heddleDir, 'accounts.json');
    writeFileSync(accountsPath, JSON.stringify({ schemaVersion: 2, claude: [{
      id: 'kimi-free', configDir: null, billingClass: 'free-tier',
      envRepoint: { baseUrl: 'https://kimi.example.test/anthropic', authTokenRef: 'KIMI_FREE_TEST_KEY', service: 'kimi' },
    }] }));
    process.env.HOME = home;
    process.env.HEDDLE_ACCOUNTS = accountsPath;
    vi.resetModules();
    const [{ dispatch }, { buildWorkerEnv }] = await Promise.all([
      import('../src/dispatch.js'), import('../src/env.js'),
    ]);
    const fake = fakeAdapter(undefined, { readAgents: false });
    const caps: ProviderCaps = {
      provider: 'claude', source: 'fixture', stale: false, capturedAt: 1,
      fiveHour: { usedPercentage: 1, resetsAt: null }, sevenDay: { usedPercentage: null, resetsAt: null },
      windows: {}, noteCodes: [], activeAccount: 'kimi-free',
      accounts: [{ id: 'kimi-free', fiveHour: { usedPercentage: 1, resetsAt: null }, sevenDay: { usedPercentage: null, resetsAt: null }, windows: {}, noteCodes: [], limitReached: false, stale: false }],
    };
    const outcome = await dispatch({
      taskClass: 'research-summarize', prompt: 'x', cwd: tempDir(), identity: IDENTITIES.unbound,
      accounts: [{ id: 'kimi-free', configDir: null, envRepoint: { baseUrl: 'https://kimi.example.test/anthropic', authTokenRef: 'KIMI_FREE_TEST_KEY', service: 'kimi' } }],
      caps: { claude: caps },
    }, tempLedger(), () => fake.adapter);

    expect(outcome.ok).toBe(true);
    const childEnv = buildWorkerEnv({ envRepoint: fake.calls[0].opts.envRepoint }).env;
    expect(childEnv).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://kimi.example.test/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'synthetic-kimi-free-token',
      ANTHROPIC_MODEL: 'kimi-k3-high',
    });
    expect(existsSync(join(home, '.claude', 'settings.json'))).toBe(false);
  });
});
