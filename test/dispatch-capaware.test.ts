import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dispatch, planDispatch } from '../src/dispatch.js';
import { decideRoute } from '../src/capaware.js';
import { Ledger } from '../src/ledger.js';
import { loadRouting } from '../src/routing.js';
import { parseGlmUsageQuota } from '../src/glm-usage.js';
import { readProviderCaps } from '../src/usage.js';
import type { CapsByProvider, ProviderCaps } from '../src/usage.js';
import { fakeAdapter, IDENTITIES, useTempResources } from './helpers.js';

const fresh = (provider: string, used: number | null): ProviderCaps => ({ provider, source: 'limits.json', stale: false, capturedAt: 1, fiveHour: { usedPercentage: used, resetsAt: null }, sevenDay: { usedPercentage: null, resetsAt: null }, windows: {}, noteCodes: [], accounts: [], activeAccount: null });
const caps = (values: Record<string, number>): CapsByProvider => Object.fromEntries(Object.entries(values).map(([p, v]) => [p, fresh(p, v)]));
const cursorCaps = ({ total, api }: { total: number; api: number }): CapsByProvider => {
  const windows = {
    'included-total': { usedPercentage: total, resetsAt: null },
    'included-api': { usedPercentage: api, resetsAt: null },
    'usage-based': { usedPercentage: 0, resetsAt: null },
  };
  return { cursor: { ...fresh('cursor', null), windows, accounts: [{ id: 'cursor-agent-keychain', fiveHour: { usedPercentage: null, resetsAt: null }, sevenDay: { usedPercentage: null, resetsAt: null }, windows, noteCodes: [], limitReached: false, stale: false }] } };
};

describe('dispatch cap-aware decisions', () => {
  const { tempDir, tempLedger, trackLedger } = useTempResources('heddle-dispatch-capaware-test-');
  const { unbound } = IDENTITIES;

  it('dispatches bulk work to the cap-aware fallback and records that decision in the ledger', async () => {
    const fake = fakeAdapter(); const ledger = tempLedger(); const outcome = await dispatch({ taskClass: 'bulk-mechanical', prompt: 'x', cwd: tempDir(), identity: unbound, caps: { ...caps({ codex: 95 }), ...cursorCaps({ total: 10, api: 10 }) } }, ledger, () => fake.adapter);
    expect(fake.calls[0].opts.model).toBe('composer-2.5-fast'); expect(outcome).toMatchObject({ usedFallback: true }); expect(outcome.routeReason).toContain('cap:route-away codex 5h 95%'); expect(ledger.recent(1)[0]).toMatchObject({ model: 'composer-2.5-fast', fell_back_from: 'codex/gpt-5.6-luna' }); expect(ledger.recent(1)[0].route_reason).toContain('cap:route-away');
  });

  it('dispatches bulk work to its primary when the primary remains below the cap', async () => {
    const fake = fakeAdapter(); const ledger = tempLedger(); const outcome = await dispatch({ taskClass: 'bulk-mechanical', prompt: 'x', cwd: tempDir(), identity: unbound, caps: caps({ codex: 10 }) }, ledger, () => fake.adapter);
    expect(fake.calls[0].opts.model).toBe('gpt-5.6-luna'); expect(outcome.usedFallback).toBe(false); expect(ledger.recent(1)[0].route_reason).toMatch(/^cap:ok codex 5h 10%/);
  });

  it('ledgers a metered Cursor refusal without invoking an adapter', async () => {
    const fake = fakeAdapter(); const ledger = tempLedger(); const outcome = await dispatch({ taskClass: 'second-opinion-hard', optIn: true, prompt: 'x', cwd: tempDir(), identity: unbound, caps: cursorCaps({ total: 10, api: 100 }) }, ledger, () => fake.adapter);
    expect(outcome.refusal?.code).toBe('metered-pool-exhausted'); expect(fake.calls).toHaveLength(0); expect(ledger.recent(1)[0]).toMatchObject({ refusal: 'metered-pool-exhausted', finished_at: expect.any(String) }); expect(ledger.recent(1)[0].route_reason).toMatch(/^cap:refuse/); expect(ledger.inFlight()).toEqual([]);
  });

  it('includes Claude account advice in an in-session refusal but routes away before refusing an exhausted primary', async () => {
    const accounts = [{ id: 'acct1', configDir: null }, { id: 'acct2', configDir: '/x/.claude-acct2' }]; const claude = fresh('claude', 70); claude.accounts = [
      { id: 'acct1', fiveHour: { usedPercentage: 70, resetsAt: null }, sevenDay: { usedPercentage: null, resetsAt: null }, windows: {}, noteCodes: [], limitReached: false, stale: false }, { id: 'acct2', fiveHour: { usedPercentage: 20, resetsAt: null }, sevenDay: { usedPercentage: null, resetsAt: null }, windows: {}, noteCodes: [], limitReached: false, stale: false },
    ];
    const ledger = tempLedger(); const refused = await dispatch({ taskClass: 'deep-implementation', prompt: 'x', cwd: tempDir(), identity: unbound, inSession: true, caps: { claude }, accounts }, ledger, () => fakeAdapter().adapter);
    expect(refused).toMatchObject({ refusal: { code: 'claude-in-session' }, account: 'acct2' }); expect(refused.refusal?.instruction).toContain('acct2 has the most 5h headroom'); expect(ledger.recent(1)[0].account).toBe('acct1');
    const fake = fakeAdapter(); claude.fiveHour.usedPercentage = 95; const away = await dispatch({ taskClass: 'deep-implementation', prompt: 'x', cwd: tempDir(), identity: unbound, caps: { claude, ...caps({ codex: 5 }) }, accounts }, ledger, () => fake.adapter);
    expect(away).toMatchObject({ usedFallback: true }); expect(fake.calls[0].opts.model).toBe('gpt-5.6-sol'); expect(away.routeReason).toContain('cap:route-away claude 5h 95%'); expect(ledger.recent(1)[0]).toMatchObject({ task_class: 'deep-implementation', fell_back_from: 'claude/opus' });
  });

  it('keeps planning side-effect free while returning the cap-aware target and trace', () => {
    const ledger = trackLedger(new Ledger(join(tempDir(), 'ledger.db'))); const plan = planDispatch({ taskClass: 'bulk-mechanical', prompt: '(dry run)', cwd: tempDir(), identity: unbound, caps: { ...caps({ codex: 95 }), ...cursorCaps({ total: 10, api: 10 }) } });
    expect(plan.target.model).toBe('composer-2.5-fast'); expect(plan.decision).toMatchObject({ routedAwayForCap: true }); expect(plan.decision.checks.length).toBeGreaterThan(0); expect(ledger.recent(1)).toEqual([]);
  });

  it('routes away from an exhausted GLM quota instead of leaving its dispatch on a depleted HTTP pool', () => {
    const quota = parseGlmUsageQuota({ data: { level: 'coding-pro', limits: [
      { type: 'five_hour', usage: 1000, remaining: 0, percentage: 100, nextResetTime: 1_788_000_000_000 },
    ] } });
    const glmCaps = readProviderCaps({ nowS: 1_787_000_000, glmQuota: quota ?? undefined });
    const decision = decideRoute(loadRouting(),
      { provider: 'glm', model: 'glm-5.3' }, { provider: 'codex', model: 'gpt-5.6-luna' },
      { ...glmCaps, ...caps({ codex: 5 }) }, { explicit: false });
    expect(decision).toMatchObject({ target: { provider: 'codex', model: 'gpt-5.6-luna' }, routedAwayForCap: true });
    expect(decision.routeReason).toContain('cap:route-away glm 5h 100%');
  });

  it('records the selected Codex account using the CODEX_HOME basename', async () => {
    const ledger = tempLedger(); const outcome = await dispatch({ taskClass: 'bulk-mechanical', prompt: 'x', cwd: tempDir(), identity: unbound, env: { CODEX_HOME: '/Users/x/.codex-acct2' }, caps: caps({ codex: 5 }) }, ledger, () => fakeAdapter().adapter);
    expect(outcome.account).toBe('.codex-acct2'); expect(ledger.recent(1)[0].account).toBe('.codex-acct2');
  });
});
