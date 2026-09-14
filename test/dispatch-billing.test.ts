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
afterEach(() => {
  if (savedAccountsPath === undefined) delete process.env.HEDDLE_ACCOUNTS;
  else process.env.HEDDLE_ACCOUNTS = savedAccountsPath;
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

  it('allows open-billing on a FRESH under-cap row even when the provider snapshot is stale (REV-2 / HED-443)', async () => {
    registry({ id: 'open', billingClass: 'subscription-quota', overage: { posture: 'open-billing' } });
    const req = request('open');
    // Provider snapshot stale, but the per-account row is FRESH (row.stale=false) and under cap. A fresh
    // row is trusted THROUGH a stale provider mirror (that is how a fresh RED row is still detected), so
    // the billing gate must ALLOW here — refusing on provider-level staleness alone would be over-strict
    // and contradict the row-level trust HED-443 relies on. (Contrast: the limits.json SOURCE now marks
    // rows stale when the snapshot is past its OWN window — see the readLimitsMirror test below.)
    req.caps = { codex: {
      provider: 'codex', source: 'limits.json', stale: true, capturedAt: 1,
      fiveHour: { usedPercentage: null, resetsAt: null }, sevenDay: { usedPercentage: null, resetsAt: null },
      windows: {}, noteCodes: [], activeAccount: 'open',
      accounts: [{ id: 'open', fiveHour: { usedPercentage: 40, resetsAt: null }, sevenDay: { usedPercentage: null, resetsAt: null }, windows: {}, noteCodes: [], limitReached: false, stale: false }],
    } } as unknown as CapsByProvider;
    expect(planDispatch(req).billingRefusal).toBeUndefined();
    const fake = fakeAdapter();
    const outcome = await dispatch(req, tempLedger(), () => fake.adapter);
    expect(fake.calls).toHaveLength(1);
    expect(outcome.refusal).toBeUndefined();
  });

  it('marks limits.json account rows stale when the provider snapshot is past its own window (REV-2 source fix)', () => {
    // An aged-out limits.json PROVIDER snapshot (nowS - capturedAt > staleAfterSecs) must mark its
    // per-account rows stale too — not just the provider — so accountCapState returns 'unknown' and an
    // open-billing account REFUSES rather than reading a dead usedPercentage as a fresh 'under'. The file
    // itself is fresh (writtenAt=nowS) so it is not dropped wholesale; only the provider window aged out.
    const dir = tempDir();
    writeFileSync(`${dir}/limits.json`, JSON.stringify({
      writtenAt: 5000,
      limits: [{ provider: 'codex', capturedAt: 1000, staleAfterSecs: 300, stale: false,
        fiveHour: { usedPercentage: 40 },
        accounts: [{ id: 'open', stale: false, fiveHour: { usedPercentage: 40 } }] }],
    }));
    const caps = readLimitsMirror(dir, 5000)!;               // nowS 5000 − capturedAt 1000 = 4000 > 300
    expect(caps.codex.stale).toBe(true);                     // provider aged out (pre-existing behavior)
    expect(caps.codex.accounts[0].stale).toBe(true);         // REV-2: the ROW inherits pastOwnWindow
    expect(accountCapState(caps.codex, 'open')).toBe('unknown'); // → open-billing refuses (F3), no dead 'under'
  });
});
