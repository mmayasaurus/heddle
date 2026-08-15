import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { adviseClaudeAccount, capAwarePolicy, currentClaudeAccount, decideRoute, isCursorNativeModel, readClaudeAccounts } from '../src/capaware.js';
import { loadRouting, resolveRoute } from '../src/routing.js';
import type { CapsByProvider, ProviderCaps } from '../src/usage.js';
import { useTempResources } from './helpers.js';

const table = loadRouting(join(process.cwd(), 'routing/routing.v0.yaml'));
const fresh = (provider: string, used: number | null): ProviderCaps => ({ provider, source: 'limits.json', stale: false, capturedAt: 1, fiveHour: { usedPercentage: used, resetsAt: null }, sevenDay: { usedPercentage: null, resetsAt: null }, windows: {}, noteCodes: [], accounts: [], activeAccount: null });
const caps = (values: Record<string, number>): CapsByProvider => Object.fromEntries(Object.entries(values).map(([p, v]) => [p, fresh(p, v)]));
const cursorCaps = ({ total, api, usageBased = 0, noteCodes = [], accountId = 'cursor-agent-keychain' }: { total: number; api: number; usageBased?: number; noteCodes?: string[]; accountId?: string }): CapsByProvider => {
  const windows = {
    'included-total': { usedPercentage: total, resetsAt: null },
    'included-api': { usedPercentage: api, resetsAt: null },
    'usage-based': { usedPercentage: usageBased, resetsAt: null },
  };
  const cursor = { ...fresh('cursor', null), windows, noteCodes, accounts: [{ id: accountId, fiveHour: { usedPercentage: null, resetsAt: null }, sevenDay: { usedPercentage: null, resetsAt: null }, windows, noteCodes, limitReached: false, stale: false }] };
  return { cursor };
};
const route = (name: string) => resolveRoute(table, name);
const decision = (name: string, all: CapsByProvider, explicit = false) => { const r = route(name); return decideRoute(table, r, r.fallback, all, { explicit }); };

describe('cap-aware routing', () => {
  const { tempDir } = useTempResources('heddle-capaware-test-');

  it('keeps a primary below its cap and routes bulk work to its fallback above the cap', () => {
    expect(decision('bulk-mechanical', caps({ codex: 10 }))).toMatchObject({ target: { provider: 'codex', model: 'gpt-5.6-luna' }, routedAwayForCap: false, routeReason: 'cap:ok codex 5h 10%' });
    const away = decision('bulk-mechanical', { ...caps({ codex: 95 }), ...cursorCaps({ total: 20, api: 20 }) });
    expect(away).toMatchObject({ target: { provider: 'cursor', model: 'composer-2.5-fast' }, fallback: undefined, routedAwayForCap: true }); expect(away.routeReason).toContain('cap:route-away codex 5h 95%>=90 → cursor/composer-2.5-fast'); expect(away.checks.some((x) => x.startsWith('ROUTE AWAY'))).toBe(true);
  });

  it('runs the primary when both route candidates are over cap or no fallback exists', () => {
    const both = decision('bulk-mechanical', { ...caps({ codex: 95 }), ...cursorCaps({ total: 95, api: 20 }) });
    expect(both).toMatchObject({ target: { provider: 'codex' }, fallback: undefined, routedAwayForCap: false }); expect(both.routeReason).toMatch(/^cap:both-over/);
    const r = route('bulk-mechanical'); const noFallback = decideRoute(table, r, undefined, caps({ codex: 95 }), { explicit: false });
    expect(noFallback.routeReason).toMatch(/^cap:over .*no fallback/);
  });

  it('never moves a route on unknown or stale caps and preserves its fallback', () => {
    for (const codex of [{ ...fresh('codex', 95), source: 'none' as const }, { ...fresh('codex', 95), stale: true }]) {
      const r = route('bulk-mechanical'); const got = decideRoute(table, r, r.fallback, { codex }, { explicit: false });
      expect(got).toMatchObject({ target: { provider: 'codex' }, fallback: r.fallback, routedAwayForCap: false }); expect(got.routeReason).toMatch(/^cap:unknown codex/);
    }
  });

  it('never routes an explicit target away even when its cap is exhausted', () => {
    const got = decision('bulk-mechanical', caps({ codex: 99 }), true);
    expect(got).toMatchObject({ target: { provider: 'codex' }, routedAwayForCap: false }); expect(got.routeReason).toMatch(/^explicit-route/); expect(got.checks[0]).toContain('never routed away');
  });

  it('refuses Cursor named third-party models when their metered API pool is exhausted', () => {
    const exhausted = decision('second-opinion-hard', cursorCaps({ total: 10, api: 100 }));
    expect(exhausted.refusal).toMatchObject({ code: 'metered-pool-exhausted' }); expect(exhausted.refusal?.reason).toContain('included-api'); expect(exhausted.refusal?.reason).toContain('kimi-k3-high'); expect(exhausted.refusal?.reason).toContain('on-demand');
    expect(decision('second-opinion-hard', cursorCaps({ total: 10, api: 50, noteCodes: ['cursor.includedApiExhausted'] })).refusal?.code).toBe('metered-pool-exhausted');
    const available = decision('second-opinion-hard', cursorCaps({ total: 10, api: 50 })); expect(available.refusal).toBeUndefined(); expect(available.routeReason).toBe('cap:ok cursor included-api 50%');
    expect(decision('second-opinion-hard', cursorCaps({ total: 10, api: 100 }), true).refusal?.code).toBe('metered-pool-exhausted');
  });

  it('uses Cursor included-total for native models and identifies native model names', () => {
    const away = decision('second-opinion', { ...cursorCaps({ total: 95, api: 100 }), ...caps({ gemini: 4 }) });
    expect(away).toMatchObject({ target: { provider: 'gemini', model: 'gemini-3.1-pro-high' }, routedAwayForCap: true }); expect(decision('second-opinion', cursorCaps({ total: 20, api: 100 })).routeReason).toBe('cap:ok cursor included-total 20%');
    expect(['cursor-grok-4.6-high', 'composer-2.5-fast', 'auto'].map(isCursorNativeModel)).toEqual([true, true, true]); expect(['kimi-k3-high', 'gpt-5.6-luna'].map(isCursorNativeModel)).toEqual([false, false]);
  });

  it('uses the billing account row for Cursor refusals unless that row is stale', () => {
    expect(decision('second-opinion', cursorCaps({ total: 20, api: 20, noteCodes: ['cursor.onDemandLimitReached'] })).refusal?.reason).toContain('usage-based');
    const rowWins = cursorCaps({ total: 10, api: 100 }); rowWins.cursor.windows = { ...rowWins.cursor.windows, 'included-api': { usedPercentage: 10, resetsAt: null } };
    expect(decision('second-opinion-hard', rowWins).refusal?.code).toBe('metered-pool-exhausted');
    rowWins.cursor.accounts[0].stale = true; expect(decision('second-opinion-hard', rowWins).refusal).toBeUndefined();
  });

  it('runs the primary when a capped fallback would trigger a metered refusal', () => {
    const got = decision('bulk-mechanical', { ...caps({ codex: 95 }), ...cursorCaps({ total: 10, api: 10, noteCodes: ['cursor.onDemandLimitReached'] }) });
    expect(got).toMatchObject({ target: { provider: 'codex' }, routedAwayForCap: false }); expect(got.routeReason).toContain('fallback refused');
  });

  it('honors enabled policy settings and custom route-away thresholds', () => {
    expect(capAwarePolicy(table)).toEqual({ enabled: true, routeAwayAtPct: 90 });
    const disabledPath = join(tempDir(), 'disabled.yaml'); writeFileSync(disabledPath, 'policy: {cap_aware_routing: {enabled: false}}\nproviders: {codex: {}}\ntask_classes: {bulk: {provider: codex, model: m}}\n');
    const disabled = loadRouting(disabledPath); const target = resolveRoute(disabled, 'bulk'); expect(decideRoute(disabled, target, undefined, caps({ codex: 99 }), { explicit: false }).routeReason).toBe('cap-aware routing disabled (policy)');
    const thresholdPath = join(tempDir(), 'threshold.yaml'); writeFileSync(thresholdPath, 'policy: {cap_aware_routing: {route_away_at_pct: 50}}\nproviders: {codex: {}, cursor: {}}\ntask_classes: {bulk: {provider: codex, model: m, fallback: {provider: cursor, model: c}}}\n');
    const threshold = loadRouting(thresholdPath); const r = resolveRoute(threshold, 'bulk'); expect(decideRoute(threshold, r, r.fallback, { ...caps({ codex: 60 }), ...cursorCaps({ total: 10, api: 10 }) }, { explicit: false }).routedAwayForCap).toBe(true);
  });

  it('advises the Claude account with the most fresh headroom and recognizes basename selection', () => {
    const accounts = [{ id: 'acct1', configDir: null }, { id: 'acct2', configDir: '/x/.claude-acct2' }, { id: 'acct3', configDir: '/x/.claude-acct3' }];
    const claude = fresh('claude', 32); claude.accounts = [
      { id: 'acct1', fiveHour: { usedPercentage: 70, resetsAt: null }, sevenDay: { usedPercentage: null, resetsAt: null }, windows: {}, noteCodes: [], limitReached: false, stale: false },
      { id: 'acct2', fiveHour: { usedPercentage: 20, resetsAt: null }, sevenDay: { usedPercentage: null, resetsAt: null }, windows: {}, noteCodes: [], limitReached: false, stale: false },
      { id: 'acct3', fiveHour: { usedPercentage: null, resetsAt: null }, sevenDay: { usedPercentage: null, resetsAt: null }, windows: {}, noteCodes: [], limitReached: false, stale: true },
    ];
    const advice = adviseClaudeAccount(claude, accounts, {}); expect(advice).toMatchObject({ best: { id: 'acct2', usedPct: 20, configDir: '/x/.claude-acct2' }, current: { id: 'acct1', usedPct: 70 } }); expect(advice.line).toContain('acct2 has the most 5h headroom (20% used)'); expect(advice.line).toContain('this session is on acct1 (70%)'); expect(advice.line).toContain('CLAUDE_CONFIG_DIR=/x/.claude-acct2');
    expect(adviseClaudeAccount(claude, accounts, { CLAUDE_CONFIG_DIR: '/x/.claude-acct3' }).line).toContain('no fresh capture'); expect(currentClaudeAccount(accounts, { CLAUDE_CONFIG_DIR: '/other/.claude-acct2' })?.id).toBe('acct2');
    claude.accounts[0].fiveHour.usedPercentage = 10; expect(adviseClaudeAccount(claude, accounts, {}).line).toContain('leave CLAUDE_CONFIG_DIR unset'); expect(adviseClaudeAccount(claude, [], {}).line).toContain('none registered'); expect(adviseClaudeAccount(fresh('claude', 1), accounts, {}).line).toContain('cannot advise');
  });

  it('reads valid Claude account registry rows and ignores missing or malformed registries', () => {
    const path = join(tempDir(), 'accounts.json'); writeFileSync(path, JSON.stringify({ claude: [{ id: 'a', configDir: '/p' }, { id: 'b' }, { nope: true }] }));
    expect(readClaudeAccounts(path)).toEqual([{ id: 'a', configDir: '/p', email: undefined, note: undefined }, { id: 'b', configDir: null, email: undefined, note: undefined }]);
    expect(readClaudeAccounts(join(tempDir(), 'missing.json'))).toEqual([]); writeFileSync(path, '{nope'); expect(readClaudeAccounts(path)).toEqual([]); writeFileSync(path, JSON.stringify({ claude: 'x' })); expect(readClaudeAccounts(path)).toEqual([]);
  });
});
