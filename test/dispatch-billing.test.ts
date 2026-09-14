import { writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

// REV-1 (HED-395): the auto-effort classifier (classifyEffort → classify → the codex classifier
// adapter) must NEVER run for a billing-refused primary. Mock the codex adapter module — the same seam
// classify.test.ts uses — so (a) no real classifier subprocess is ever spawned by these tests and (b)
// we can assert the classifier was NOT invoked when a pay-per-token primary is refused at the plan
// level before classifyEffort. The WORKER dispatch uses the INJECTED fake adapter (dispatch()'s 3rd
// arg), never `new CodexAdapter()`, so this mock is inert for every other test in this file.
const { classifierDispatch } = vi.hoisted(() => ({
  classifierDispatch: vi.fn(async () => ({ ok: true, output: 'low', exitCode: 0 })),
}));
vi.mock('../src/adapters/codex.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/adapters/codex.js')>();
  return { ...actual, CodexAdapter: class { dispatch = classifierDispatch; } };
});

import { dispatch, planDispatch } from '../src/dispatch.js';
import type { DispatchRequest } from '../src/dispatch.js';
import { loadRouting } from '../src/routing.js';
import { accountCapState, accountAtOrOverCap } from '../src/capaware.js';
import { readLimitsMirror } from '../src/usage.js';
import type { Account } from '../src/accounts.js';
import type { CapsByProvider, ProviderCaps } from '../src/usage.js';
import { fakeAdapter, IDENTITIES, useTempResources } from './helpers.js';

const savedAccountsPath = process.env.HEDDLE_ACCOUNTS;
const savedRouting = process.env.HEDDLE_ROUTING;
afterEach(() => {
  if (savedAccountsPath === undefined) delete process.env.HEDDLE_ACCOUNTS;
  else process.env.HEDDLE_ACCOUNTS = savedAccountsPath;
  if (savedRouting === undefined) delete process.env.HEDDLE_ROUTING;
  else process.env.HEDDLE_ROUTING = savedRouting;
});

describe('dispatch billing enforcement (HED-395)', () => {
  const { tempDir, tempLedger } = useTempResources('heddle-dispatch-billing-test-');
  const { unbound } = IDENTITIES;

  function registry(account: Pick<Account, 'id' | 'billingClass' | 'overage'>): string {
    const path = `${tempDir()}/accounts.json`;
    writeFileSync(path, JSON.stringify({ schemaVersion: 2, codex: [{ ...account, codexHome: null }] }));
    process.env.HEDDLE_ACCOUNTS = path;
    return path;
  }

  function providerCaps(accountId: string, usedPercentage: number): CapsByProvider {
    const row = { id: accountId, fiveHour: { usedPercentage, resetsAt: null }, sevenDay: { usedPercentage: null, resetsAt: null }, windows: {}, noteCodes: [], limitReached: usedPercentage >= 100, stale: false };
    const codex: ProviderCaps = { provider: 'codex', source: 'limits.json', stale: false, capturedAt: 1, fiveHour: { usedPercentage, resetsAt: null }, sevenDay: { usedPercentage: null, resetsAt: null }, windows: {}, noteCodes: [], accounts: [row], activeAccount: accountId };
    return { codex };
  }

  function request(accountId: string, usedPercentage = 10): DispatchRequest {
    return {
      taskClass: 'bulk-mechanical', provider: 'codex', model: 'gpt-5.6-luna', prompt: 'x', cwd: tempDir(), identity: unbound,
      caps: providerCaps(accountId, usedPercentage),
      rotationAccounts: { codex: [{ id: accountId, codexHome: null }], cursor: [] },
    };
  }

  // A full multi-provider accounts.json (loadAccountRegistry reads it via HEDDLE_ACCOUNTS).
  function writeRegistry(obj: Record<string, unknown>): void {
    const path = `${tempDir()}/accounts.json`;
    writeFileSync(path, JSON.stringify({ schemaVersion: 2, ...obj }));
    process.env.HEDDLE_ACCOUNTS = path;
  }

  // codex ProviderCaps whose top-level window is low (never triggers route-away) but whose per-account
  // rows are supplied explicitly — for asserting the billing gate's cap-state branch without the
  // cap-aware router moving the target first.
  function codexCaps(rows: Array<{ id: string; used: number | null; stale?: boolean }>, active?: string): CapsByProvider {
    return { codex: {
      provider: 'codex', source: 'limits.json', stale: false, capturedAt: 1,
      fiveHour: { usedPercentage: 10, resetsAt: null }, sevenDay: { usedPercentage: null, resetsAt: null },
      windows: {}, noteCodes: [], activeAccount: active ?? rows[0]?.id ?? null,
      accounts: rows.map(({ id, used, stale = false }) => ({ id, fiveHour: { usedPercentage: used, resetsAt: null }, sevenDay: { usedPercentage: null, resetsAt: null }, windows: {}, noteCodes: [], limitReached: used !== null && used >= 100, stale })),
    } };
  }

  // A custom operator routing table: cursor PRIMARY → claude FALLBACK. This is the ONLY shape that can
  // reach REV-3's claude capability-fit rebind — no built-in class does (the two built-in claude
  // fallbacks are codex→claude, where codex enforces every capability claude does and so never refuses
  // 'unenforceable', and claude→claude, where the fallback is equally unable to enforce). Cursor
  // enforces NOTHING (capabilities.ts ENFORCEABLE.cursor === []), so a cursor primary asked for `browse`
  // refuses 'capability-denied'/'unenforceable' while the claude fallback CAN enforce it → capability-fit
  // fallback to claude fires. HEDDLE_ROUTING points dispatch()'s loadRouting at this table.
  function cursorClaudeRouting(): void {
    const yaml = `${tempDir()}/cursor-claude.yaml`;
    writeFileSync(yaml, [
      'version: 0', 'providers:',
      '  claude: { auth: anthropic-subscription, execution: headless, models: [haiku] }',
      '  cursor: { auth: cursor-subscription, execution: headless, models: [cursor-grok-4.6-high] }',
      'task_classes:', '  cap-fit-billing:',
      '    provider: cursor', '    model: cursor-grok-4.6-high',
      '    fallback: { provider: claude, model: haiku }', '',
    ].join('\n'));
    process.env.HEDDLE_ROUTING = yaml;
  }

  // A fresh, under-cap claude provider snapshot with one row for `id` (so pickClaudeAccount selects it).
  function claudeCapsFor(id: string): ProviderCaps {
    return {
      provider: 'claude', source: 'claude-tap', stale: false, capturedAt: 1,
      fiveHour: { usedPercentage: 10, resetsAt: null }, sevenDay: { usedPercentage: null, resetsAt: null },
      windows: {}, noteCodes: [], activeAccount: id,
      accounts: [{ id, fiveHour: { usedPercentage: 10, resetsAt: null }, sevenDay: { usedPercentage: null, resetsAt: null }, windows: {}, noteCodes: [], limitReached: false, stale: false }],
    };
  }

  it('dispatches a subscription account unchanged', async () => {
    registry({ id: 'included', billingClass: 'subscription-quota' });
    const fake = fakeAdapter();
    const outcome = await dispatch(request('included'), tempLedger(), () => fake.adapter);
    expect(outcome.ok).toBe(true);
    expect(fake.calls).toHaveLength(1);
  });

  it('refuses pay-per-token by default with account, class, and exact override lever', async () => {
    registry({ id: 'metered', billingClass: 'pay-per-token' });
    const fake = fakeAdapter();
    const outcome = await dispatch(request('metered'), tempLedger(), () => fake.adapter);
    expect(fake.calls).toHaveLength(0);
    expect(outcome.refusal?.code).toBe('billing.pay-per-token');
    expect(outcome.error).toContain('metered');
    expect(outcome.error).toContain('pay-per-token');
    expect(outcome.error).toContain('policy.cap_aware_routing.permit_pay_per_token: true');
  });

  it('allows pay-per-token only when the permit switch is on', () => {
    registry({ id: 'metered', billingClass: 'pay-per-token' });
    const table = loadRouting();
    (table.policy as any).cap_aware_routing.permit_pay_per_token = true;
    expect(planDispatch(request('metered'), table).billingRefusal).toBeUndefined();
    // Preview-only by design: permit-ON is an ALLOW, so deleting the runTarget gate cannot regress it
    // (it spawns either way), and dispatch() loads its own routing table (no permit injection). The
    // gate-deletion-sensitive direction — permit-OFF pay-per-token REFUSES with NO spawn — is proven at
    // spawn level by 'refuses pay-per-token by default' (fake.calls===0) and the REV-1 auto-effort test.
  });

  it('allows open-billing under cap and refuses it at cap (preview + spawn)', async () => {
    registry({ id: 'open', billingClass: 'subscription-quota', overage: { posture: 'open-billing' } });
    expect(planDispatch(request('open', 99)).billingRefusal).toBeUndefined();
    const plan = planDispatch(request('open', 100));
    expect(plan.billingRefusal).toMatchObject({ code: 'billing.open-billing-at-cap' });
    expect(plan.billingRefusal?.reason).toContain('open');
    expect(plan.billingRefusal?.reason).toContain('subscription-quota');
    expect(plan.billingRefusal?.reason).toContain('open-billing');
    expect(plan.billingRefusal?.instruction).toContain('policy.cap_aware_routing.permit_pay_per_token');
    // Spawn-level (REV-4, red if the runTarget gate is deleted): under cap spawns, at cap refuses with
    // NO spawn — a preview-only assertion would stay green even if enforcement stopped refusing.
    const underFake = fakeAdapter();
    expect((await dispatch(request('open', 99), tempLedger(), () => underFake.adapter)).ok).toBe(true);
    expect(underFake.calls).toHaveLength(1);
    const atCapFake = fakeAdapter();
    const atCap = await dispatch(request('open', 100), tempLedger(), () => atCapFake.adapter);
    expect(atCapFake.calls).toHaveLength(0);
    expect(atCap.refusal?.code).toBe('billing.open-billing-at-cap');
  });

  it('allows a bounded-prepaid buffer at cap with advice, then refuses zero credits (preview + spawn)', async () => {
    registry({ id: 'buffer', billingClass: 'prepaid-credit', overage: { posture: 'bounded-prepaid', creditsRemaining: 7, spendLimit: 20 } });
    const allowed = planDispatch(request('buffer', 100));
    expect(allowed.billingRefusal).toBeUndefined();
    expect(allowed.billingAdvice).toBe('burning prepaid buffer (7 of 20)');
    // Spawn-level (REV-4): a buffer with credits left at cap actually spawns.
    const bufferFake = fakeAdapter();
    expect((await dispatch(request('buffer', 100), tempLedger(), () => bufferFake.adapter)).ok).toBe(true);
    expect(bufferFake.calls).toHaveLength(1);

    registry({ id: 'buffer', billingClass: 'prepaid-credit', overage: { posture: 'bounded-prepaid', creditsRemaining: 0, spendLimit: 20 } });
    const refused = planDispatch(request('buffer', 10));
    expect(refused.billingRefusal).toMatchObject({ code: 'billing.prepaid-exhausted' });
    expect(refused.billingRefusal?.reason).toContain('credits exhausted');
    expect(refused.billingRefusal?.reason).toContain('buffer');
    expect(refused.billingRefusal?.reason).toContain('prepaid-credit');
    expect(refused.billingRefusal?.reason).toContain('bounded-prepaid');
    expect(refused.billingRefusal?.instruction).toContain('policy.cap_aware_routing.permit_pay_per_token');
    // Spawn-level (REV-4, red if the runTarget gate is deleted): zero credits refuses with NO spawn.
    const zeroFake = fakeAdapter();
    const zero = await dispatch(request('buffer', 10), tempLedger(), () => zeroFake.adapter);
    expect(zeroFake.calls).toHaveLength(0);
    expect(zero.refusal?.code).toBe('billing.prepaid-exhausted');
  });

  it('treats missing, stale, and null account caps as unknown without throwing', () => {
    const malformed = { provider: 'codex', fiveHour: { usedPercentage: 10 } } as unknown as ProviderCaps;
    expect(accountCapState(undefined, 'a')).toBe('unknown');
    expect(accountCapState(malformed, 'a')).toBe('unknown');
    expect(accountAtOrOverCap(malformed, 'a')).toBe(false);
    expect(accountCapState(codexCaps([{ id: 'a', used: null }]).codex, 'a')).toBe('unknown');
    expect(accountCapState(codexCaps([{ id: 'a', used: 100, stale: true }]).codex, 'a')).toBe('unknown');
    // REV-2 / HED-443 symmetry: accountCapState is ROW-level by design — a FRESH per-account row
    // (row.stale=false) is trusted even when the PROVIDER snapshot is stale, so detectOverageAlert can
    // see a fresh RED row through a stale provider mirror. A naive `caps.stale → unknown` here would
    // regress that AND wrongly refuse open-billing on a demonstrably-fresh under-cap reading. Pin it.
    const providerStaleFreshRow = { ...codexCaps([{ id: 'a', used: 50 }]).codex, stale: true };
    expect(accountCapState(providerStaleFreshRow, 'a')).toBe('under');
  });

  it('refuses open-billing when the bound account cap state is unknown', async () => {
    registry({ id: 'open', billingClass: 'subscription-quota', overage: { posture: 'open-billing' } });
    const req = request('open');
    req.caps = codexCaps([]);
    const preview = planDispatch(req);
    expect(preview.billingRefusal?.reason).toContain("open-billing account 'open' (billingClass subscription-quota): cap state unknown");
    expect(preview.billingRefusal?.instruction).toContain('policy.cap_aware_routing.permit_pay_per_token: true');

    const fake = fakeAdapter();
    const outcome = await dispatch(req, tempLedger(), () => fake.adapter);
    expect(fake.calls).toHaveLength(0);
    expect(outcome.refusal).toEqual(preview.billingRefusal);
  });

  it('loud-degrades an unregistered bound account onto the outcome and ledger row', async () => {
    writeRegistry({ codex: [] });
    const fake = fakeAdapter(); const ledger = tempLedger();
    const outcome = await dispatch(request('manual'), ledger, () => fake.adapter);
    expect(fake.calls).toHaveLength(1);
    expect(outcome.billingDegraded).toEqual({ reason: 'billing-degraded:account-unregistered(manual)' });
    expect(ledger.get(outcome.ledgerId)?.error).toContain('billing-degraded:account-unregistered(manual)');
  });

  it('loud-degrades an unreadable registry instead of crashing dispatch', async () => {
    const path = `${tempDir()}/accounts.json`;
    writeFileSync(path, '{broken');
    process.env.HEDDLE_ACCOUNTS = path;
    const fake = fakeAdapter(); const ledger = tempLedger();
    const outcome = await dispatch(request('included'), ledger, () => fake.adapter);
    expect(fake.calls).toHaveLength(1);
    expect(outcome.billingDegraded).toEqual({ reason: 'billing-degraded:registry-unreadable' });
    expect(ledger.get(outcome.ledgerId)?.error).toContain('billing-degraded:registry-unreadable');
  });

  it('allows bounded prepaid with unknown caps loudly, and cleanly allows no overage object', async () => {
    registry({ id: 'buffer', billingClass: 'prepaid-credit', overage: { posture: 'bounded-prepaid', creditsRemaining: 7, spendLimit: 20 } });
    const staleReq = request('buffer'); staleReq.caps = codexCaps([{ id: 'buffer', used: 100, stale: true }]);
    const fake = fakeAdapter(); const ledger = tempLedger();
    const stale = await dispatch(staleReq, ledger, () => fake.adapter);
    expect(stale.billingDegraded).toEqual({ reason: 'billing-degraded:prepaid-caps-stale' });
    expect(ledger.get(stale.ledgerId)?.error).toContain('billing-degraded:prepaid-caps-stale');

    registry({ id: 'plain', billingClass: 'prepaid-credit' });
    const clean = await dispatch(request('plain'), tempLedger(), () => fake.adapter);
    expect(clean.ok).toBe(true);
    expect(clean.billingDegraded).toBeUndefined();
  });

  it('refuses a pay-per-token account rebound by account failover before spawning it', async () => {
    writeRegistry({ codex: [
      { id: 'included', codexHome: '/included', billingClass: 'subscription-quota' },
      { id: 'metered', codexHome: '/metered', billingClass: 'pay-per-token' },
    ] });
    const cwd = tempDir(); const coolingPath = `${tempDir()}/cooling.json`;
    const fake = fakeAdapter(undefined, { readAgents: false });
    const adapter = { ...fake.adapter, dispatch: async (prompt: string, opts: Parameters<typeof fake.adapter.dispatch>[1]) => {
      await fake.adapter.dispatch(prompt, opts);
      return { ok: false, output: '', error: '429 rate limit', exitCode: 1 };
    } };
    const outcome = await dispatch({
      taskClass: 'bulk-mechanical', prompt: 'x', cwd, identity: unbound,
      caps: codexCaps([{ id: 'included', used: 10 }, { id: 'metered', used: 10 }], 'included'),
      rotationAccounts: { codex: [{ id: 'included', codexHome: '/included' }, { id: 'metered', codexHome: '/metered' }], cursor: [] },
      coolingPath, nowS: 100,
    }, tempLedger(), () => adapter);
    expect(fake.calls).toHaveLength(1);
    expect(outcome).toMatchObject({ account: 'metered', usedFallback: true, refusal: { code: 'billing.pay-per-token' } });
    expect(outcome.error).toContain('policy.cap_aware_routing.permit_pay_per_token: true');
  });

  it("preserves today's three unclassified subscription accounts across all dispatch paths", async () => {
    writeRegistry({
      claude: [{ id: 'claude-current', configDir: null }],
      codex: [{ id: 'default', codexHome: '/codex-current' }],
      cursor: [{ id: 'cursor-current', keyFile: null }],
    });
    const rotationAccounts = {
      codex: [{ id: 'default', codexHome: '/codex-current' }],
      cursor: [{ id: 'cursor-current', keyFile: null }],
    };
    const caps = codexCaps([{ id: 'default', used: 10 }]);

    const primaryFake = fakeAdapter(undefined, { readAgents: false });
    const primary = await dispatch({ ...request('default'), rotationAccounts }, tempLedger(), () => primaryFake.adapter);
    expect(primary).toMatchObject({ ok: true, account: 'default', provider: 'codex' });
    expect(primary.billingDegraded).toBeUndefined();

    const failoverFake = fakeAdapter(undefined, { readAgents: false }); let attempts = 0;
    const failoverAdapter = { ...failoverFake.adapter, dispatch: async (prompt: string, opts: Parameters<typeof failoverFake.adapter.dispatch>[1]) => {
      attempts += 1; await failoverFake.adapter.dispatch(prompt, opts);
      return attempts === 1 ? { ok: false, output: '', error: '429 rate limit', exitCode: 1 } : { ok: true, output: 'done', exitCode: 0 };
    } };
    const failover = await dispatch({ ...request('default'), rotationAccounts }, tempLedger(), () => failoverAdapter);
    // Today's one-Codex-account registry has no distinct account to rebound to; preserve that
    // pre-gate outcome exactly (one failed attempt, no billing refusal/degradation). The dedicated
    // two-account test above is the red-if-runTarget-gate-deleted rebound enforcement proof.
    expect(failover).toMatchObject({ ok: false, account: 'default', provider: 'codex', usedFallback: false });
    expect(failover.billingDegraded).toBeUndefined();

    const capabilityFake = fakeAdapter(undefined, { readAgents: false });
    const claudeCaps: ProviderCaps = {
      provider: 'claude', source: 'claude-tap', stale: false, capturedAt: 1,
      fiveHour: { usedPercentage: 10, resetsAt: null }, sevenDay: { usedPercentage: null, resetsAt: null },
      windows: {}, noteCodes: [], activeAccount: 'claude-current',
      accounts: [{ id: 'claude-current', fiveHour: { usedPercentage: 10, resetsAt: null }, sevenDay: { usedPercentage: null, resetsAt: null }, windows: {}, noteCodes: [], limitReached: false, stale: false }],
    };
    const capability = await dispatch({
      taskClass: 'research-summarize', capabilities: ['net'], prompt: 'x', cwd: tempDir(), identity: unbound,
      accounts: [{ id: 'claude-current', configDir: null, loggedIn: true }], caps: { ...caps, claude: claudeCaps }, rotationAccounts,
    }, tempLedger(), () => capabilityFake.adapter);
    expect(capability).toMatchObject({ ok: true, account: 'default', provider: 'codex', usedFallback: true });
    expect(capability.billingDegraded).toBeUndefined();

    const fallbackFake = fakeAdapter(undefined, { readAgents: false }); let fallbackCalls = 0;
    const fallbackAdapter = { ...fallbackFake.adapter, dispatch: async (prompt: string, opts: Parameters<typeof fallbackFake.adapter.dispatch>[1]) => {
      fallbackCalls += 1; await fallbackFake.adapter.dispatch(prompt, opts);
      return fallbackCalls === 1 ? { ok: false, output: '', error: 'socket closed', exitCode: 1 } : { ok: true, output: 'done', exitCode: 0 };
    } };
    const fallback = await dispatch({ taskClass: 'bulk-mechanical', prompt: 'x', cwd: tempDir(), identity: unbound, caps, rotationAccounts }, tempLedger(), () => fallbackAdapter);
    expect(fallback).toMatchObject({ ok: true, account: 'cursor-current', provider: 'cursor', usedFallback: true });
    expect(fallback.billingDegraded).toBeUndefined();

    const resumeFake = fakeAdapter(undefined, { readAgents: false });
    const resumed = await dispatch({ ...request('default'), resume: 'default', rotationAccounts }, tempLedger(), () => resumeFake.adapter);
    expect(resumed).toMatchObject({ ok: true, account: 'default' });
    expect(resumed.billingDegraded).toBeUndefined();

    const preview = planDispatch({ ...request('default'), rotationAccounts });
    expect(preview.billingRefusal).toBeUndefined();
    expect(preview.billingAdvice).toBeUndefined();
  });

  it('does not spend the auto-effort classifier on a billing-refused primary (REV-1)', async () => {
    classifierDispatch.mockClear();
    registry({ id: 'metered', billingClass: 'pay-per-token' });
    const fake = fakeAdapter();
    const outcome = await dispatch({ ...request('metered'), autoEffort: true }, tempLedger(), () => fake.adapter);
    expect(outcome.refusal?.code).toBe('billing.pay-per-token');
    expect(fake.calls).toHaveLength(0);                  // no worker spawn
    // The plan-level gate refuses BEFORE classifyEffort (dispatch.ts): a refused primary spends no
    // classifier. Red if that gate is removed — classifyEffort would then run and call the classifier.
    expect(classifierDispatch).not.toHaveBeenCalled();
  });

  it('keys the billing gate on the CLAUDE capability-fit fallback account, not the primary (REV-3)', async () => {
    // cursor PRIMARY (enforces nothing) asked for `browse` → capability-denied/unenforceable → the class's
    // claude FALLBACK (which CAN enforce browse) runs. REV-3 rebinds ctx.account to the picked claude
    // account BEFORE runTarget's billing gate reads it. The claude fallback account is pay-per-token, so
    // the gate must REFUSE it — proving the gate keyed the claude account, not the cursor primary's binding.
    cursorClaudeRouting();
    writeRegistry({ claude: [{ id: 'claude-metered', configDir: null, billingClass: 'pay-per-token' }] });
    const fake = fakeAdapter(undefined, { readAgents: false });
    const outcome = await dispatch({
      taskClass: 'cap-fit-billing', capabilities: ['browse'], prompt: 'x', cwd: tempDir(), identity: unbound,
      accounts: [{ id: 'claude-metered', configDir: null, loggedIn: true }], caps: { claude: claudeCapsFor('claude-metered') },
    }, tempLedger(), () => fake.adapter);
    expect(outcome.account).toBe('claude-metered');
    expect(outcome.refusal?.code).toBe('billing.pay-per-token');
    expect(fake.calls).toHaveLength(0);
    // Red if REV-3's claude rebind is removed: ctx.account stays the cursor primary's binding (null here),
    // the gate cannot classify it and loud-degrades-to-ALLOW, and the pay-per-token claude worker SPAWNS
    // (fake.calls === 1, no refusal) — a metered account billed without the gate ever seeing it.
  });

  it('annotates the capability refusal instead of throwing when the CLAUDE fallback pin is bad (REV-3 try/catch)', async () => {
    // pickClaudeAccount THROWS on a bad pin. A cursor primary skips plan-time claude-pin validation
    // (plan.ts only validates the pin for a claude PRIMARY), so a stale accountPin first throws inside the
    // capability-fit fallback. REV-3 wraps it exactly like the class fallback: the (already-ledgered)
    // capability refusal is returned with the blocked-fallback note appended — never a bare throw out of
    // dispatch. Red if the try/catch is removed: this await REJECTS instead of resolving.
    cursorClaudeRouting();
    writeRegistry({ claude: [{ id: 'claude-metered', configDir: null, billingClass: 'subscription-quota' }] });
    const fake = fakeAdapter(undefined, { readAgents: false });
    const outcome = await dispatch({
      taskClass: 'cap-fit-billing', capabilities: ['browse'], prompt: 'x', cwd: tempDir(), identity: unbound, accountPin: 'nonexistent',
      accounts: [{ id: 'claude-metered', configDir: null, loggedIn: true }], caps: { claude: claudeCapsFor('claude-metered') },
    }, tempLedger(), () => fake.adapter);
    expect(outcome.refusal?.code).toBe('capability-denied');   // primary capability refusal preserved
    expect(outcome.error).toContain('claude capability-fit fallback blocked: account_pin "nonexistent"');
    expect(fake.calls).toHaveLength(0);                        // neither cursor primary nor claude fallback spawned
  });

  it('refuses open-billing when the PROVIDER snapshot is stale, even on a fresh-looking row (REV-2)', async () => {
    // Spend authorization is conservative-for-MONEY: once the provider mirror is stale, a limits.json
    // row (which shares the provider's capture) must NOT authorize paid overage even if its own `stale`
    // flag reads fresh. billingCapState maps a stale provider → 'unknown' → open-billing refuses (F3),
    // WITHOUT touching the shared accountCapState. The row-level trust the accountCapState unit test
    // above pins (a fresh row → 'under' through a stale provider) is DELIBERATELY preserved for
    // detectOverageAlert (HED-443, conservative-for-DANGER) and `usage --remaining` (display) — this
    // test proves the billing gate is STRICTER than those read-only consumers, which is the whole point.
    registry({ id: 'open', billingClass: 'subscription-quota', overage: { posture: 'open-billing' } });
    const req = request('open');
    req.caps = { codex: {
      provider: 'codex', source: 'limits.json', stale: true, capturedAt: 1,
      fiveHour: { usedPercentage: null, resetsAt: null }, sevenDay: { usedPercentage: null, resetsAt: null },
      windows: {}, noteCodes: [], activeAccount: 'open',
      accounts: [{ id: 'open', fiveHour: { usedPercentage: 40, resetsAt: null }, sevenDay: { usedPercentage: null, resetsAt: null }, windows: {}, noteCodes: [], limitReached: false, stale: false }],
    } } as unknown as CapsByProvider;
    // F7 parity: the preview refuses on the same provider-stale path.
    const preview = planDispatch(req);
    expect(preview.billingRefusal?.code).toBe('billing.open-billing-at-cap');
    expect(preview.billingRefusal?.reason).toContain('cap state unknown');
    // Spawn level: refuses with NO spawn. Red if billingCapState is reverted to plain accountCapState —
    // the fresh row then reads 'under' and the account SPAWNS into unmetered paid overage on stale data.
    const fake = fakeAdapter();
    const outcome = await dispatch(req, tempLedger(), () => fake.adapter);
    expect(fake.calls).toHaveLength(0);
    expect(outcome.refusal?.code).toBe('billing.open-billing-at-cap');
    expect(outcome.refusal?.reason).toContain('cap state unknown');
  });

  it('keeps a FRESH limits.json account row row-level even under a stale provider mirror (HED-443 source contract)', () => {
    // readLimitsMirror must NOT fold provider staleness into a per-account row: a row carries its OWN
    // `stale` (the dashboard sets it from the account's own tap capture), so a fresh row (stale:false)
    // stays fresh even when the PROVIDER mirror is stale. That is exactly what lets detectOverageAlert
    // (HED-443) still see a fresh RED row and `usage --remaining` show a live account window THROUGH a
    // stale provider. The money-safety tightening for a stale provider lives in billingCapState (the
    // billing gate) — NOT here. A prior "fix at source (row inherits provider staleness)" attempt broke
    // both consumers (usage-remaining.test.ts caught it); this pins the reverted, correct behavior.
    // Fixture mirrors usage-remaining's: provider stale:true (upstream-flagged), fresh under-window row.
    const dir = tempDir();
    writeFileSync(`${dir}/limits.json`, JSON.stringify({
      writtenAt: 5000,
      limits: [{ provider: 'codex', capturedAt: 4900, staleAfterSecs: 300, stale: true,
        fiveHour: { usedPercentage: 40 },
        accounts: [{ id: 'open', stale: false, fiveHour: { usedPercentage: 40 } }] }],
    }));
    const caps = readLimitsMirror(dir, 5000)!;
    expect(caps.codex.stale).toBe(true);                     // provider is stale (upstream-flagged)
    expect(caps.codex.accounts[0].stale).toBe(false);        // the ROW stays row-level fresh (NOT inherited)
    expect(accountCapState(caps.codex, 'open')).toBe('under'); // row-level: trusted for detection + display
  });
});
