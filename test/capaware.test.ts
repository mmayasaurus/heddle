import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { adviseClaudeAccount, capAwarePolicy, currentClaudeAccount, decideRoute, isCursorNativeModel, readClaudeAccounts, type LadderContext } from '../src/capaware.js';
import { loadRouting, resolveRoute, type RouteTarget } from '../src/routing.js';
import type { LanesConfig } from '../src/lanes.js';
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
    // both soft-over → primary runs but the fallback STAYS available for a failure retry (the cap is soft)
    expect(both).toMatchObject({ target: { provider: 'codex' }, fallback: { provider: 'cursor' }, routedAwayForCap: false }); expect(both.routeReason).toMatch(/^cap:both-over/);
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
    claude.accounts[0].fiveHour.usedPercentage = 10;
    // best === current → say so instead of recommending a switch to the account already in use
    expect(adviseClaudeAccount(claude, accounts, {}).line).toContain('already on the account with the most 5h headroom (acct1');
    // best is the DEFAULT account but the session is elsewhere → the unset instruction appears
    expect(adviseClaudeAccount(claude, accounts, { CLAUDE_CONFIG_DIR: '/x/.claude-acct2' }).line).toContain('leave CLAUDE_CONFIG_DIR unset'); expect(adviseClaudeAccount(claude, [], {}).line).toContain('none registered'); expect(adviseClaudeAccount(fresh('claude', 1), accounts, {}).line).toContain('cannot advise');
  });

  it('reads valid Claude account registry rows and ignores missing or malformed registries', () => {
    const path = join(tempDir(), 'accounts.json'); writeFileSync(path, JSON.stringify({ claude: [{ id: 'a', configDir: '/p' }, { id: 'b' }, { nope: true }] }));
    expect(readClaudeAccounts(path)).toEqual([{ id: 'a', configDir: '/p', email: undefined, note: undefined }, { id: 'b', configDir: null, email: undefined, note: undefined }]);
    expect(readClaudeAccounts(join(tempDir(), 'missing.json'))).toEqual([]); writeFileSync(path, '{nope'); expect(readClaudeAccounts(path)).toEqual([]); writeFileSync(path, JSON.stringify({ claude: 'x' })); expect(readClaudeAccounts(path)).toEqual([]);
  });
});

// HED-106 / HED-264 — the tier-ladder expansion walk INSIDE decideRoute. Gated on opts.ladder, so the
// suite above (no ladder) proves the byte-stable paths are untouched; these exercise the walk with a
// hermetic lanes/lane_defaults fixture (independent of the live routing values).
describe('tier-ladder expansion walk (HED-264 fallback-not-refusal)', () => {
  const lanesFixture: LanesConfig = {
    tiers: {
      'T0-menial': ['cerebras', 'groq', 'openrouter-free'],
      'T1-workhorse': ['codex', 'cursor'],
      'T1Q-quality-reserve': ['cursor-api-kimi-k3', 'openrouter-credits'],
      'T2-judgment': ['claude-workers'],
      'T3-orchestrator': ['fable'],
      'T3-escalation': { via: 'escalate-judgment', opt_in: true, requires_failed_attempts: 2, fable_escalations_weekly: 3 },
    },
    floors: { claude: { never_below_pct: 3, residency_cap_below_pct: 10, residency_max: 2 }, cooling_minutes: 30, menial_verify_days: 7 },
    caps: { openrouter_credits_weekly_usd: 10 },
    guards: { never_via_cursor: ['claude', 'gpt', 'gemini'] },
  };
  const laneDefaultsFixture: Record<string, RouteTarget> = {
    cerebras: { provider: 'cerebras', model: 'gpt-oss-120b' },
    groq: { provider: 'groq', model: 'openai/gpt-oss-120b' },
    codex: { provider: 'codex', model: 'gpt-5.6-terra' },
    cursor: { provider: 'cursor', model: 'composer-2.5' },
    'claude-workers': { provider: 'claude', model: 'sonnet' },
  };
  const ctx = (o: Partial<LadderContext> = {}): LadderContext => ({
    lanes: () => lanesFixture, laneDefaults: laneDefaultsFixture, declaredProvider: 'claude',
    editsCode: false, requiresWeb: false, mcp: [], skills: [], grantedCapabilities: [], excludeProviders: [], ...o,
  });
  const deadClaude = () => [{ id: 'a', configDir: null, loggedIn: false }];
  const t = loadRouting(join(process.cwd(), 'routing/routing.v0.yaml'));

  it('routes a dead-account claude PRIMARY to its declared fallback (the 26% bug fixed)', () => {
    const d = decideRoute(t, { provider: 'claude', model: 'haiku' }, { provider: 'codex', model: 'gpt-5.6-luna' },
      { claude: fresh('claude', 50) }, { explicit: false, claudeAccounts: deadClaude, ladder: ctx() });
    expect(d).toMatchObject({ target: { provider: 'codex', model: 'gpt-5.6-luna' }, routedAwayForCap: true });
    expect(d.routeReason).toBe('cap:expand claude/haiku dead(no-account) → codex/gpt-5.6-luna (declared-fallback)');
  });

  it('expands past a dead declared fallback across the tier ladder, narrating every dead lane', () => {
    const caps = { claude: fresh('claude', 50), ...cursorCaps({ total: 10, api: 100 }) }; // cursor api pool exhausted → kimi metered-dead
    const d = decideRoute(t, { provider: 'claude', model: 'haiku' }, { provider: 'cursor', model: 'kimi-k3-high' },
      caps, { explicit: false, claudeAccounts: deadClaude, ladder: ctx() });
    // declared fallback cursor/kimi dead(metered) → descend to T1; cursor excluded (fallback provider) → codex.
    expect(d.target).toMatchObject({ provider: 'codex', model: 'gpt-5.6-terra' });
    expect(d.routeReason).toBe('cap:expand claude/haiku dead(no-account); cursor/kimi-k3-high dead(metered) → codex/gpt-5.6-terra (t1)');
  });

  it('sets the next live candidate as the runtime fallback', () => {
    const d = decideRoute(t, { provider: 'claude', model: 'opus' }, undefined,
      { claude: fresh('claude', 50) }, { explicit: false, claudeAccounts: deadClaude, ladder: ctx({ minTier: 'T0' }) });
    // no declared fallback; ladder from T2 (claude excluded) → codex, cursor, cerebras, groq.
    expect(d.target).toMatchObject({ provider: 'codex', model: 'gpt-5.6-terra' });
    expect(d.fallback).toMatchObject({ provider: 'cursor', model: 'composer-2.5' });
  });

  it('drops the read-only T0 lanes for an edits_code class', () => {
    const d = decideRoute(t, { provider: 'claude', model: 'opus' }, undefined,
      { claude: fresh('claude', 50) }, { explicit: false, claudeAccounts: deadClaude, ladder: ctx({ editsCode: true, minTier: 'T0' }) });
    expect(d.target).toMatchObject({ provider: 'codex' }); // T1, never cerebras/groq (T0)
    expect(d.fallback).toMatchObject({ provider: 'cursor' });
  });

  it('REFUSES with every lane named when a claude-only class exhausts the walk', () => {
    const d = decideRoute(t, { provider: 'claude', model: 'fable' }, { provider: 'claude', model: 'opus' },
      { claude: fresh('claude', 50) }, { explicit: false, claudeAccounts: deadClaude, ladder: ctx({ minTier: 'T2', maxTier: 'T2' }) });
    // returns the ORIGINAL dead target so planDispatch's no-dispatchable-account refusal fires.
    expect(d).toMatchObject({ target: { provider: 'claude', model: 'fable' }, routedAwayForCap: false });
    expect(d.routeReason).toBe('cap:expand-exhausted claude/fable dead(no-account); claude/opus dead(no-account) — no live lane');
  });

  it('runs the over-soft-cap primary when its route-away target is a dead claude route (Point B)', () => {
    const d = decideRoute(t, { provider: 'codex', model: 'gpt-5.6-terra' }, { provider: 'claude', model: 'sonnet' },
      { codex: fresh('codex', 95), claude: fresh('claude', 50) }, { explicit: false, claudeAccounts: deadClaude, ladder: ctx({ declaredProvider: 'codex' }) });
    expect(d).toMatchObject({ target: { provider: 'codex', model: 'gpt-5.6-terra' }, routedAwayForCap: false });
    expect(d.routeReason).toBe('cap:over codex 5h 95%, fallback claude dead(no-account) → ran primary');
  });

  it('never walks a pinned dispatch — the pin is a placement contract', () => {
    const d = decideRoute(t, { provider: 'claude', model: 'haiku' }, { provider: 'codex', model: 'gpt-5.6-luna' },
      { claude: fresh('claude', 50) }, { explicit: false, accountPin: 'a', claudeAccounts: deadClaude, ladder: ctx() });
    expect(d).toMatchObject({ target: { provider: 'claude', model: 'haiku' }, routedAwayForCap: false });
    expect(d.routeReason).toBe('cap:ok claude 5h 50%');
  });

  it('never walks when no ladder context is supplied (the byte-stable path)', () => {
    const d = decideRoute(t, { provider: 'claude', model: 'haiku' }, { provider: 'codex', model: 'gpt-5.6-luna' },
      { claude: fresh('claude', 50) }, { explicit: false, claudeAccounts: deadClaude });
    expect(d).toMatchObject({ target: { provider: 'claude', model: 'haiku' }, routedAwayForCap: false });
    expect(d.routeReason).toBe('cap:ok claude 5h 50%');
  });
});
