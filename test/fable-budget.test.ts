import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adviseClaudeAccount, bestFableWeekly, decideRoute, pickClaudeAccount, type ClaudeAccount } from '../src/capaware.js';
import { dispatch } from '../src/dispatch.js';
import { loadRouting, resolveRoute } from '../src/routing.js';
import { readLimitsMirror, type ProviderCaps } from '../src/usage.js';
import { fakeAdapter, IDENTITIES, useTempResources } from './helpers.js';

const registry: ClaudeAccount[] = [{ id: 'acct1', configDir: null }, { id: 'acct2', configDir: '/x/.a2' }];
const fresh = (rows: Array<{ id: string; fable?: number | null; used?: number | null; stale?: boolean }>, stale = false): ProviderCaps => ({
  provider: 'claude', source: 'limits.json', stale, capturedAt: Math.floor(Date.now() / 1000), fiveHour: { usedPercentage: null, resetsAt: null }, sevenDay: { usedPercentage: null, resetsAt: null }, windows: {}, noteCodes: [], activeAccount: null,
  accounts: rows.map((r) => ({ id: r.id, fiveHour: { usedPercentage: r.used ?? null, resetsAt: null }, sevenDay: { usedPercentage: null, resetsAt: null }, windows: {}, noteCodes: [], limitReached: false, stale: r.stale ?? false, fableWeeklyEstimatePct: r.fable, fableWeeklySamples: r.fable === undefined ? undefined : 7 })),
});
const routingYaml = `version: 0
providers:
  claude: { execution: headless, models: [fable, opus] }
task_classes:
  escalate-judgment:
    provider: claude
    model: fable
    fallback: { provider: claude, model: opus }
    skills: [worker-role]
    edits_code: false
    auto_assess: false
`;

describe('Fable-weekly budget behavior', () => {
  const { tempDir, tempLedger } = useTempResources('heddle-fable-budget-test-');
  afterEach(() => vi.unstubAllEnvs());

  it('finds the lowest fresh Fable-weekly estimate only among addressable registered accounts', () => {
    expect(bestFableWeekly(fresh([{ id: 'acct1', fable: 48 }, { id: 'acct2', fable: 22 }]), registry)).toEqual({ id: 'acct2', pct: 22 });
    expect(bestFableWeekly(fresh([{ id: 'acct1', fable: 48 }, { id: 'acct2', fable: 22, stale: true }]), registry)).toEqual({ id: 'acct1', pct: 48 });
    expect(bestFableWeekly(fresh([{ id: 'acct1' }, { id: 'acct2', fable: null }]), registry)).toBeNull();
    expect(bestFableWeekly(fresh([{ id: 'acct1', fable: 10 }], true), registry)).toBeNull();
    expect(bestFableWeekly(fresh([{ id: 'acct1', fable: 48 }, { id: 'acct2', fable: 10 }]), [{ ...registry[0], loggedIn: false }, registry[1]])).toEqual({ id: 'acct2', pct: 10 });
  });

  it('parses optional Fable-weekly fields from fresh limits mirror account rows', () => {
    const dir = tempDir(); const now = Math.floor(Date.now() / 1000);
    writeFileSync(join(dir, 'limits.json'), JSON.stringify({ writtenAt: now, limits: [{ provider: 'claude', capturedAt: now, accounts: [{ id: 'acct1', fableWeeklyEstimatePct: 33.5, fableWeeklySamples: 7 }, { id: 'acct2' }] }] }));
    const rows = readLimitsMirror(dir, now)?.claude.accounts;
    expect(rows?.[0]).toMatchObject({ fableWeeklyEstimatePct: 33.5, fableWeeklySamples: 7 });
    expect(rows?.[1].fableWeeklyEstimatePct ?? null).toBeNull(); expect(rows?.[1].fableWeeklySamples ?? null).toBeNull();
  });

  it('picks Fable headroom before five-hour headroom unless a pin or unknown estimates require otherwise', () => {
    const caps = fresh([{ id: 'acct1', fable: 48, used: 10 }, { id: 'acct2', fable: 22, used: 80 }]);
    const fable = pickClaudeAccount(caps, registry, { forFable: true })!;
    expect(fable.account.id).toBe('acct2'); expect(fable.reason).toContain('fable-headroom'); expect(fable.reason).toContain('22');
    const ordinary = pickClaudeAccount(caps, registry)!;
    expect(ordinary.account.id).toBe('acct1'); expect(ordinary.reason).toContain('most headroom');
    expect(pickClaudeAccount(fresh([{ id: 'acct1', used: 80 }, { id: 'acct2', used: 10 }]), registry, { forFable: true })?.account.id).toBe('acct2');
    expect(pickClaudeAccount(caps, registry, { forFable: true, pin: 'acct1' })?.account.id).toBe('acct1');
  });

  it('routes non-explicit Fable class work away at its soft cap and records unknown and blocked fallback checks', () => {
    const dir = tempDir(); const path = join(dir, 'routing.yaml'); writeFileSync(path, routingYaml);
    const table = loadRouting(path); const target = resolveRoute(table, 'escalate-judgment'); const fallback = target.fallback!;
    const high = decideRoute(table, target, fallback, { claude: fresh([{ id: 'acct1', fable: 51 }, { id: 'acct2', fable: 60 }]) }, { explicit: false, claudeAccounts: () => registry });
    expect(high).toMatchObject({ target: { model: 'opus' }, routedAwayForCap: true }); expect(high.routeReason).toMatch(/^cap:fable-soft-cap/); expect(high.routeReason).toContain('51');
    const low = decideRoute(table, target, fallback, { claude: fresh([{ id: 'acct1', fable: 30 }]) }, { explicit: false, claudeAccounts: () => registry });
    expect(low.target.model).toBe('fable'); expect(low.routedAwayForCap).toBe(false); expect(low.checks.some((x) => x.includes('vs fable act threshold 45'))).toBe(true);
    const unknown = decideRoute(table, target, fallback, { claude: fresh([{ id: 'acct1' }, { id: 'acct2', fable: null }]) }, { explicit: false, claudeAccounts: () => registry });
    expect(unknown.target.model).toBe('fable'); expect(unknown.checks.some((x) => x.includes('no fresh estimate'))).toBe(true);
    expect(decideRoute(table, target, fallback, { claude: fresh([{ id: 'acct1', fable: 51 }]) }, { explicit: true, claudeAccounts: () => registry }).target.model).toBe('fable');
    const blocked = decideRoute(table, target, { provider: 'cursor', model: 'kimi-k3' }, { claude: fresh([{ id: 'acct1', fable: 51 }]), cursor: { ...fresh([]), provider: 'cursor', windows: { 'included-api': { usedPercentage: 100, resetsAt: null } } } }, { explicit: false, claudeAccounts: () => registry });
    expect(blocked.target.model).toBe('fable'); expect(blocked.checks.some((x) => x.includes('fallback is blocked'))).toBe(true);
  });

  it('dispatches escalate-judgment headlessly to Opus above the soft cap and Fable with its selected account below it', async () => {
    const dir = tempDir(); const path = join(dir, 'routing.yaml'); writeFileSync(path, routingYaml); vi.stubEnv('HEDDLE_ROUTING', path);
    // claude workers materialize no AGENTS.md (readAgents: false) and NEVER run in the real
    // worktree (fleet rule: dispatch cwd = temp dir in tests)
    const highFake = fakeAdapter(undefined, { readAgents: false }); const highLedger = tempLedger();
    await dispatch({ taskClass: 'escalate-judgment', prompt: 'x', cwd: tempDir(), identity: IDENTITIES.unbound, accounts: registry, caps: { claude: fresh([{ id: 'acct1', fable: 51 }, { id: 'acct2', fable: 49 }]) } }, highLedger, () => highFake.adapter);
    expect(highFake.calls[0].opts.model).toBe('opus'); expect(highLedger.recent(1)[0].route_reason).toContain('fable-soft-cap');
    const lowFake = fakeAdapter(undefined, { readAgents: false }); const lowLedger = tempLedger();
    await dispatch({ taskClass: 'escalate-judgment', prompt: 'x', cwd: tempDir(), identity: IDENTITIES.unbound, accounts: registry, caps: { claude: fresh([{ id: 'acct1', fable: 40, used: 10 }, { id: 'acct2', fable: 20, used: 80 }]) } }, lowLedger, () => lowFake.adapter);
    expect(lowFake.calls[0].opts.model).toBe('fable'); expect(lowLedger.recent(1)[0].route_reason).toContain('fable-headroom');
  });

  it('adds Fable-weekly account advice only when a fresh addressable estimate exists', () => {
    const advice = adviseClaudeAccount(fresh([{ id: 'acct1', fable: 50, used: 20 }, { id: 'acct2', fable: 55, used: 10 }]), registry, {});
    expect(advice.line).toContain('Fable-weekly:'); expect(advice.line).toContain('acct1'); expect(advice.line).toContain('act threshold');
    expect(adviseClaudeAccount(fresh([{ id: 'acct1' }, { id: 'acct2', fable: null }]), registry, {}).line).not.toContain('Fable-weekly');
  });

  it('uses a pinned account to decide the Fable soft cap', () => {
    const dir = tempDir(); const path = join(dir, 'routing.yaml'); writeFileSync(path, routingYaml);
    const table = loadRouting(path); const target = resolveRoute(table, 'escalate-judgment'); const fallback = target.fallback!;
    const caps = { claude: fresh([{ id: 'acct1', fable: 60 }, { id: 'acct2', fable: 10 }]) };
    const pinned = decideRoute(table, target, fallback, caps, { explicit: false, claudeAccounts: () => registry, accountPin: 'acct1' });
    expect(pinned).toMatchObject({ target: { model: 'opus' }, routedAwayForCap: true }); expect(pinned.routeReason).toContain('pinned acct1');
    expect(decideRoute(table, target, fallback, caps, { explicit: false, claudeAccounts: () => registry }).target.model).toBe('fable');
    const unknownPinned = decideRoute(table, target, fallback, { claude: fresh([{ id: 'acct1', fable: null }, { id: 'acct2', fable: 10 }]) }, { explicit: false, claudeAccounts: () => registry, accountPin: 'acct1' });
    expect(unknownPinned.target.model).toBe('fable'); expect(unknownPinned.checks.some((x) => x.includes('no fresh estimate'))).toBe(true);
  });

  it('returns the pinned Fable-weekly estimate only for registered accounts', () => {
    const caps = fresh([{ id: 'acct1', fable: 50 }, { id: 'acct2', fable: 10 }]);
    expect(bestFableWeekly(caps, registry, 'acct1')).toEqual({ id: 'acct1', pct: 50, pinned: true });
    expect(bestFableWeekly(caps, registry, 'not-registered')).toEqual({ id: 'acct2', pct: 10 });
    expect(bestFableWeekly(fresh([{ id: 'acct1', fable: null }, { id: 'acct2', fable: 10 }]), registry, 'acct1')).toBeNull();
  });

  it('keeps fractional Fable estimates precise around the act threshold', () => {
    const dir = tempDir(); const path = join(dir, 'routing.yaml'); writeFileSync(path, routingYaml);
    const table = loadRouting(path); const target = resolveRoute(table, 'escalate-judgment'); const fallback = target.fallback!;
    const below = decideRoute(table, target, fallback, { claude: fresh([{ id: 'acct1', fable: 44.6 }]) }, { explicit: false, claudeAccounts: () => registry });
    expect(below.target.model).toBe('fable'); expect(below.checks.some((x) => x.includes('44.6') && !x.includes('45%'))).toBe(true);
    const above = decideRoute(table, target, fallback, { claude: fresh([{ id: 'acct1', fable: 45.4 }]) }, { explicit: false, claudeAccounts: () => registry });
    expect(above).toMatchObject({ target: { model: 'opus' }, routedAwayForCap: true }); expect(above.routeReason).toContain('45.4');
  });

  it('breaks equal Fable headroom by known five-hour usage', () => {
    expect(pickClaudeAccount(fresh([{ id: 'acct1', fable: 20, used: 80 }, { id: 'acct2', fable: 20, used: 10 }]), registry, { forFable: true })?.account.id).toBe('acct2');
    expect(pickClaudeAccount(fresh([{ id: 'acct1', fable: 20 }, { id: 'acct2', fable: 20, used: 10 }]), registry, { forFable: true })?.account.id).toBe('acct2');
  });

  it('advises below-threshold Fable-weekly usage without calling for action', () => {
    const advice = adviseClaudeAccount(fresh([{ id: 'acct1', fable: 30, used: 20 }, { id: 'acct2', fable: 40, used: 10 }]), registry, {});
    expect(advice.line).toContain('Fable-weekly:'); expect(advice.line).toContain('30'); expect(advice.line).not.toContain('act threshold');
  });

  it('picks runtime Claude/Fable fallback account by Fable headroom', async () => {
    const dir = tempDir(); const path = join(dir, 'routing.yaml');
    writeFileSync(path, `version: 0
providers:
  codex: { execution: headless, models: [gpt-5.6-terra] }
  claude: { execution: headless, models: [fable, opus] }
task_classes:
  runtime-fable-fallback:
    provider: codex
    model: gpt-5.6-terra
    fallback: { provider: claude, model: fable }
    skills: [worker-role]
    edits_code: false
    auto_assess: false
`);
    vi.stubEnv('HEDDLE_ROUTING', path);
    const primary = fakeAdapter({ ok: false, output: '', exitCode: 1, error: 'boom' }, { readAgents: false });
    const claude = fakeAdapter(undefined, { readAgents: false }); const ledger = tempLedger();
    await dispatch({ taskClass: 'runtime-fable-fallback', prompt: 'x', cwd: tempDir(), identity: IDENTITIES.unbound, accounts: registry, caps: { claude: fresh([{ id: 'acct1', fable: 40, used: 10 }, { id: 'acct2', fable: 15, used: 90 }]) } }, ledger, (provider) => provider === 'codex' ? primary.adapter : claude.adapter);
    expect(primary.calls).toHaveLength(1); expect(claude.calls).toHaveLength(1);
    const fallbackCall = claude.calls[0]!;
    expect(fallbackCall.opts.env?.CLAUDE_CONFIG_DIR).toBe('/x/.a2');
    expect(ledger.recent(1)[0].route_reason).toContain('fable-headroom');
  });
});
