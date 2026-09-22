import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeAccount } from '../src/capaware.js';
import type { ProviderCaps } from '../src/usage.js';
import { fakeAdapter, IDENTITIES, useTempResources } from './helpers.js';

// HED-697: a claude route PINNED to an env-repoint account runs the SERVICE's model through the Claude
// Code harness. The HED-3 guard, the family pack and the review row must judge that family, so a GLM
// reviewer of Claude-authored work runs (and is scored claude → glm) while a native pin still refuses.
const saved = { home: process.env.HOME, accounts: process.env.HEDDLE_ACCOUNTS, routing: process.env.HEDDLE_ROUTING };

afterEach(() => {
  for (const [key, value] of [['HOME', saved.home], ['HEDDLE_ACCOUNTS', saved.accounts], ['HEDDLE_ROUTING', saved.routing]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  vi.resetModules();
});

describe('adversarial review on a pinned env-repoint account (HED-697)', () => {
  const { tempDir, tempLedger } = useTempResources('heddle-envrepoint-review-test-');

  const glm: ClaudeAccount = { id: 'glm', configDir: '/x/glm', envRepoint: { baseUrl: 'https://glm.example.test/api/anthropic', authTokenRef: 'GLM_REVIEW_TEST_KEY', service: 'glm', model: 'glm-5.3' } };
  const native: ClaudeAccount = { id: 'acct2', configDir: '/x/.claude-acct2' };
  const caps: ProviderCaps = {
    provider: 'claude', source: 'limits.json', stale: false, capturedAt: 1,
    fiveHour: { usedPercentage: 5, resetsAt: null }, sevenDay: { usedPercentage: null, resetsAt: null },
    windows: {}, noteCodes: [], activeAccount: 'acct2',
    accounts: [{ id: 'acct2', fiveHour: { usedPercentage: 5, resetsAt: null }, sevenDay: { usedPercentage: null, resetsAt: null }, windows: {}, noteCodes: [], limitReached: false, stale: false }],
  };

  // Temp HOME with the referenced token in a 0600 secrets.env, and a routing copy with auto-assess off
  // (a real classifier subprocess would otherwise run mid-test).
  async function loadDispatch() {
    const home = tempDir();
    mkdirSync(join(home, '.heddle'));
    writeFileSync(join(home, '.heddle', 'secrets.env'), 'GLM_REVIEW_TEST_KEY=synthetic-glm-review-token\n');
    chmodSync(join(home, '.heddle', 'secrets.env'), 0o600);
    process.env.HOME = home;
    process.env.HEDDLE_ACCOUNTS = join(home, '.heddle', 'accounts.json');
    const routing = join(tempDir(), 'routing.yaml');
    writeFileSync(routing, readFileSync(join(process.cwd(), 'routing', 'routing.v0.yaml'), 'utf8').replaceAll('auto_assess: true', 'auto_assess: false'));
    process.env.HEDDLE_ROUTING = routing;
    vi.resetModules();
    return (await import('../src/dispatch.js')).dispatch;
  }

  const request = (accountPin: string) => ({
    taskClass: 'adversarial-review', provider: 'claude', model: 'sonnet', authorProvider: 'claude', accountPin,
    accounts: [native, glm], caps: { claude: caps }, mcp: [], prompt: 'review', cwd: tempDir(), identity: IDENTITIES.unbound,
  });

  it('runs a Claude-authored review on the pinned GLM account and records the pair as claude → glm/glm-5.3', async () => {
    const dispatch = await loadDispatch();
    const fake = fakeAdapter(undefined, { readAgents: false }); const ledger = tempLedger();
    const outcome = await dispatch(request('glm'), ledger, () => fake.adapter);
    expect(outcome.refusal).toBeUndefined();
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].opts.envRepoint).toMatchObject({ service: 'glm', model: 'glm-5.3' });
    expect(ledger.getReview(outcome.ledgerId)).toMatchObject({ author_provider: 'claude', reviewer_provider: 'glm', reviewer_model: 'glm-5.3' });
    // The worker is GLM, so it gets no Claude-family instruction pack.
    expect(outcome.skills).not.toContain('family-claude');
  });

  it('an env-repoint-only registry (HED-531 auto-pick) is judged by the account it binds, in plan AND run', async () => {
    const dispatch = await loadDispatch();
    const fake = fakeAdapter(undefined, { readAgents: false }); const ledger = tempLedger();
    // No pin: HED-531 auto-picks the only (GLM) account. A Claude-authored review runs, scored claude → glm.
    const ran = await dispatch({ ...request('glm'), accountPin: undefined, accounts: [glm] }, ledger, () => fake.adapter);
    expect(ran.refusal).toBeUndefined();
    expect(ran.review).toMatchObject({ reviewerProvider: 'glm', reviewerModel: 'glm-5.3' });
    expect(ledger.getReview(ran.ledgerId)).toMatchObject({ reviewer_provider: 'glm' });
    // …and a GLM-authored review on the same registry is the author's own family: refused, never run.
    const refused = await dispatch({ ...request('glm'), accountPin: undefined, accounts: [glm], authorProvider: 'glm' }, ledger, () => fake.adapter);
    expect(refused.refusal?.code).toBe('same-provider-review');
    expect(fake.calls).toHaveLength(1);
  });

  it('an in-session dispatch cannot borrow an env-repoint pin to pass the family guard (it runs on the orchestrator login)', async () => {
    await loadDispatch();
    const { planDispatch } = await import('../src/dispatcher/plan.js');
    const plan = planDispatch({ ...request('glm'), inSession: true });
    expect(plan.sameProviderReview).toContain('DIFFERENT model family');
  });

  it('still refuses the same review pinned to a NATIVE Claude account (the author family)', async () => {
    const dispatch = await loadDispatch();
    const fake = fakeAdapter(undefined, { readAgents: false }); const ledger = tempLedger();
    const outcome = await dispatch(request('acct2'), ledger, () => fake.adapter);
    expect(outcome.refusal?.code).toBe('same-provider-review');
    expect(fake.calls).toHaveLength(0);
  });
});
