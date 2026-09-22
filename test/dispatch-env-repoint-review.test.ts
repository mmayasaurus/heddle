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
  async function loadDispatch(routingText?: string) {
    const home = tempDir();
    mkdirSync(join(home, '.heddle'));
    writeFileSync(join(home, '.heddle', 'secrets.env'), 'GLM_REVIEW_TEST_KEY=synthetic-glm-review-token\n');
    chmodSync(join(home, '.heddle', 'secrets.env'), 0o600);
    process.env.HOME = home;
    process.env.HEDDLE_ACCOUNTS = join(home, '.heddle', 'accounts.json');
    const routing = join(tempDir(), 'routing.yaml');
    writeFileSync(routing, routingText ?? readFileSync(join(process.cwd(), 'routing', 'routing.v0.yaml'), 'utf8').replaceAll('auto_assess: true', 'auto_assess: false'));
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

  it('the dry-run preview names the identity that runs (runs_as) beside the route (would_run)', async () => {
    await loadDispatch();
    const { planDispatch, summarizePlan } = await import('../src/dispatcher/plan.js');
    expect(summarizePlan(planDispatch(request('glm')))).toMatchObject({ would_run: 'claude/sonnet', runs_as: 'glm/glm-5.3' });
    expect(summarizePlan(planDispatch({ ...request('acct2'), authorProvider: 'codex' }))).toMatchObject({ would_run: 'claude/sonnet', runs_as: 'claude/sonnet' });
    // A refused plan previews neither.
    expect(summarizePlan(planDispatch(request('acct2')))).toMatchObject({ would_run: null, runs_as: null });
  });

  it('runs_as keeps would_run\'s HED-275 preview boundary: a capability-fit rebind previews the PRIMARY, the fallback in remaining_fallback', async () => {
    await loadDispatch();
    const { planDispatch, summarizePlan } = await import('../src/dispatcher/plan.js');
    // claude cannot enforce `net`; research-summarize's codex fallback can — the run rebinds to it.
    const plan = planDispatch({ taskClass: 'research-summarize', capabilities: ['net'], accounts: [native], caps: { claude: caps }, prompt: 'x', cwd: tempDir(), identity: IDENTITIES.unbound });
    expect(plan.capabilityFitRebinds).toBe(true);
    expect(summarizePlan(plan)).toMatchObject({ would_run: 'claude/haiku', runs_as: 'claude/haiku', remaining_fallback: 'codex/gpt-5.6-luna' });
  });

  it('an in-session dispatch cannot borrow an env-repoint pin to pass the family guard (it runs on the orchestrator login)', async () => {
    await loadDispatch();
    const { planDispatch } = await import('../src/dispatcher/plan.js');
    const plan = planDispatch({ ...request('glm'), inSession: true });
    expect(plan.sameProviderReview).toContain('DIFFERENT model family');
  });

  it('HED-519 judges what RUNS: a GLM pin runs the pool\'s claude/opus seat as glm-5.3; a native opus pin is still refused', async () => {
    const dispatch = await loadDispatch();
    const fake = fakeAdapter(undefined, { readAgents: false }); const ledger = tempLedger();
    const ran = await dispatch({ ...request('glm'), model: 'opus' }, ledger, () => fake.adapter);
    expect(ran.refusal).toBeUndefined();
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].opts.envRepoint).toMatchObject({ service: 'glm', model: 'glm-5.3' });
    expect(ledger.getReview(ran.ledgerId)).toMatchObject({ author_provider: 'claude', reviewer_provider: 'glm', reviewer_model: 'glm-5.3' });
    // A codex-authored review pinned to a NATIVE account really would run headless opus: still refused.
    const refused = await dispatch({ ...request('acct2'), model: 'opus', authorProvider: 'codex' }, ledger, () => fake.adapter);
    expect(refused.refusal?.code).toBe('headless-claude-review-unreliable');
    expect(fake.calls).toHaveLength(1);
  });

  it('a class fallback that re-binds to the author\'s family is refused at spawn, never run (runtime HED-3)', async () => {
    // Synthetic review class: codex primary, claude fallback. The plan judges the codex primary (a
    // different family from the glm author); the fallback re-picks with the same glm pin, so only the
    // spawn-time guard can see that it would run as glm.
    const dispatch = await loadDispatch([
      'version: 0', 'providers:',
      '  codex: { auth: chatgpt-subscription, models: [gpt-5.6-sol] }',
      '  claude: { auth: anthropic-subscription, execution: headless, models: [sonnet] }',
      '  glm: { auth: zai-coding-plan-subscription, billing_class: subscription-quota, execution: headless, base_url: https://api.z.ai/api/coding/paas/v4, key_env: ZAI_API_KEY, models: [glm-5.3] }',
      'task_classes:', '  review-fb:',
      '    provider: codex', '    model: gpt-5.6-sol',
      '    fallback: { provider: claude, model: sonnet }',
      '    reviewer_pool:', '      - { provider: codex, model: gpt-5.6-sol }',
      '    skills: [worker-role]', '    edits_code: false', '    read_only: true', '',
    ].join('\n'));
    const fake = fakeAdapter(undefined, { readAgents: false }); const ledger = tempLedger();
    const failingPrimary = { ...fake.adapter, dispatch: async (prompt: string, opts: Parameters<typeof fake.adapter.dispatch>[1]) => {
      await fake.adapter.dispatch(prompt, opts);
      return fake.calls.length === 1 ? { ok: false, output: '', exitCode: 1, error: 'primary boom' } : { ok: true, output: 'done', exitCode: 0 };
    } };
    const outcome = await dispatch({
      taskClass: 'review-fb', authorProvider: 'glm', accountPin: 'glm', accounts: [native, glm], caps: { claude: caps },
      mcp: [], prompt: 'review', cwd: tempDir(), identity: IDENTITIES.unbound,
    }, ledger, () => failingPrimary);
    expect(outcome.refusal?.code).toBe('same-provider-review');
    expect(outcome.refusal?.reason).toContain('runs as glm/glm-5.3');
    expect(outcome.usedFallback).toBe(true);
    expect(fake.calls).toHaveLength(1); // only the failed codex primary ever spawned
    expect(ledger.get(outcome.ledgerId)).toMatchObject({ provider: 'claude', refusal: 'same-provider-review', fell_back_from: 'codex/gpt-5.6-sol' });
  });

  it('a null bind reports the REAL refusal, never "the author\'s own family"', async () => {
    const dispatch = await loadDispatch();
    const fake = fakeAdapter(undefined, { readAgents: false }); const ledger = tempLedger();
    // Every native account is out and GLM is pin-only beside it: no dispatchable account, and the reason
    // says how to use GLM instead of calling it logged out.
    const deadNatives = await dispatch({ ...request('glm'), accountPin: undefined, accounts: [{ ...native, loggedIn: false }, glm] }, ledger, () => fake.adapter);
    expect(deadNatives.refusal?.code).toBe('no-dispatchable-account');
    expect(deadNatives.refusal?.reason).toContain('the 1 native account is logged-out');
    expect(deadNatives.refusal?.reason).toContain('1 env-repoint account is pin-only beside them');
    // A GLM pin that the keeper has marked non-dispatchable is refused as exactly that.
    const excludedCaps: ProviderCaps = { ...caps, accounts: [...caps.accounts, {
      id: 'glm', fiveHour: { usedPercentage: 1, resetsAt: null }, sevenDay: { usedPercentage: null, resetsAt: null }, windows: {}, noteCodes: [],
      limitReached: false, stale: false, dispatch: { account: 'glm', dispatchable: false, reason: 'billing', checkedAt: Math.floor(Date.now() / 1000) - 1 },
    }] };
    const excludedPin = await dispatch({ ...request('glm'), caps: { claude: excludedCaps } }, ledger, () => fake.adapter);
    expect(excludedPin.refusal?.code).toBe('no-dispatchable-account');
    expect(excludedPin.refusal?.reason).toContain('NOT dispatchable');
    expect(fake.calls).toHaveLength(0);
  });

  it('still refuses the same review pinned to a NATIVE Claude account (the author family)', async () => {
    const dispatch = await loadDispatch();
    const fake = fakeAdapter(undefined, { readAgents: false }); const ledger = tempLedger();
    const outcome = await dispatch(request('acct2'), ledger, () => fake.adapter);
    expect(outcome.refusal?.code).toBe('same-provider-review');
    expect(fake.calls).toHaveLength(0);
  });
});
