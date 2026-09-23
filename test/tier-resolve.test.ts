import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRouting, listTaskClasses, resolveRoute, readTargetTier } from '../src/routing.js';
import { loadLanes } from '../src/lanes.js';
import { resolveTierTarget } from '../src/tier-resolve.js';
import { planDispatch } from '../src/dispatcher/plan.js';
import type { Account } from '../src/accounts.js';
import type { Route } from '../src/routing.js';

const table = loadRouting(new URL('../routing/routing.v0.yaml', import.meta.url).pathname);
const lanes = loadLanes(new URL('../routing/lanes.yaml', import.meta.url).pathname);

// Faithful synthetic accounts: only the three providers the Account registry actually models
// (claude/codex/cursor). `tier` is OMITTED unless given — a real pre-HED-395 accounts.json (the operator's
// registry today) carries no tier, and passing `undefined` must stay untiered, not default to a value.
function account(provider: string, tier?: Account['tier']): Account {
  return {
    id: `${provider}-test`, provider: provider as Account['provider'], harness: `${provider}-cli`,
    credentialRef: `${provider}:test`, loggedIn: true, ...(tier === undefined ? {} : { tier }),
  };
}

// The `mayaLike` registry: one logged-in account per native provider, UNTIERED (mirrors the live
// registry, where Fable-capability is unset — the case that must still resolve orchestration to Fable, C1).
const mayaLike = ['claude', 'codex', 'cursor'].map((provider) => account(provider));
// Claude-Pro (explicitly non-Fable tier) + Codex, no Cursor: exercises the Fable gate firing and the
// walk off an absent native provider.
const proCodex = [account('claude', 'T2'), account('codex', 'T1')];
const resolve = (taskClass: string, accounts: Account[]) => resolveTierTarget(
  resolveRoute(table, taskClass), accounts, {}, { lanes, laneDefaults: table.laneDefaults ?? {} },
);
const syntheticRoute = (overrides: Partial<Route>): Route => ({
  ...resolveRoute(table, 'implementation'), mcp: [], capabilities: [], ...overrides,
});

describe('tier-symbol routing', () => {
  it('keeps every shipped class on its static-table primary with full account coverage', () => {
    for (const taskClass of listTaskClasses(table)) {
      const staticRoute = resolveRoute(table, taskClass);
      const target = resolve(taskClass, mayaLike);
      expect(target).toMatchObject({ provider: staticRoute.provider, model: staticRoute.model });
    }
    // The Fable-requiring judgment classes resolve to Fable on an untiered Claude account (C1): an
    // unset tier is Fable-capable, so orchestration/escalate stay on Fable exactly as today's table.
    expect(resolve('orchestration', mayaLike)).toMatchObject({ provider: 'claude', model: 'fable' });
    expect(resolve('escalate-judgment', mayaLike)).toMatchObject({ provider: 'claude', model: 'fable' });
    expect(resolve('deep-implementation', mayaLike)).toMatchObject({ provider: 'claude', model: 'opus' });
    expect(resolve('implementation', mayaLike)).toMatchObject({ provider: 'codex', model: 'gpt-5.6-terra' });
    expect(resolve('second-opinion', mayaLike)).toMatchObject({ provider: 'cursor', model: 'cursor-grok-4.6-high' });
    expect(resolve('second-opinion-hard', mayaLike)).toMatchObject({ provider: 'cursor', model: 'kimi-k3-high' });
    expect(resolve('bulk-mechanical', mayaLike)).toMatchObject({ provider: 'codex', model: 'gpt-5.6-luna' });
    expect(resolve('scaffold', mayaLike)).toMatchObject({ provider: 'cursor', model: 'composer-2.5' });
    expect(resolve('research-summarize', mayaLike)).toMatchObject({ provider: 'claude', model: 'haiku' });
    // Env-repoint (non-Account-modeled) providers are never gated on account presence (C2), so a
    // gemini-primary class resolves to its literal even with no gemini row in the registry.
    expect(resolve('documentation', mayaLike)).toMatchObject({ provider: 'gemini', model: 'gemini-3.6-flash-low' });
    expect(resolve('quick-alt-take', mayaLike)).toMatchObject({ provider: 'cursor', model: 'cursor-grok-4.6-medium' });
    expect(resolve('adversarial-review', mayaLike)).toMatchObject({ provider: 'cursor', model: 'cursor-grok-4.6-high' });
    expect(resolve('gemini-analysis', mayaLike)).toMatchObject({ provider: 'gemini', model: 'gemini-3.1-pro-high' });
    expect(resolve('web-research', mayaLike)).toMatchObject({ provider: 'gemini', model: 'gemini-3.1-pro-high' });
  });

  it('never hard-requires Fable and never lands on a dead native route on a Pro+Codex registry', () => {
    // The three providers the Account registry models; a target on one of these with no logged-in
    // account is a DEAD route the resolver must walk off. Env-repoint providers are not decidable here.
    const modeled = new Set<string>(['claude', 'codex', 'cursor']);
    const present = new Set<string>(proCodex.filter((a) => a.loggedIn !== false).map((a) => a.provider));
    for (const taskClass of listTaskClasses(table)) {
      const target = resolve(taskClass, proCodex);
      // HED-394 core acceptance: no class may hard-require Fable when no Fable-capable account exists.
      expect(`${target.provider}/${target.model}`).not.toBe('claude/fable');
      // A resolved NATIVE-provider target must correspond to a logged-in account — the resolver must
      // never settle on claude/codex/cursor when that provider is absent (it walks instead).
      if (modeled.has(target.provider)) expect(present.has(target.provider)).toBe(true);
    }
    // The Claude-judgment classes fall from Fable to Opus (the gate fires: every Claude account here
    // carries an EXPLICIT non-T3 tier). This is the whole point of the prefer walk / Fable gate.
    expect(resolve('orchestration', proCodex)).toMatchObject({ provider: 'claude', model: 'opus', symbol: 'claude/opus' });
    expect(resolve('escalate-judgment', proCodex)).toMatchObject({ provider: 'claude', model: 'opus' });
    // C2: a Cursor-primary class walks OFF the (absent) Cursor account rather than staying dead on it.
    expect(resolve('second-opinion', proCodex).provider).not.toBe('cursor');
  });

  it('explains the orchestration walk on a Pro+Codex registry (fable skipped → opus chosen)', () => {
    const res = resolveTierTarget(
      resolveRoute(table, 'orchestration'), proCodex, {}, { lanes, laneDefaults: table.laneDefaults ?? {} },
    );
    expect(res).toMatchObject({ provider: 'claude', model: 'opus', symbol: 'claude/opus' });
    const narration = res.walk.join(' | ');
    expect(narration).toMatch(/fable.*skipped/i);
    expect(narration).toMatch(/opus.*chosen/i);
  });
});

describe('tier-symbol ladder eligibility', () => {
  it('skips a non-web-capable tier lane and uses the declared fallback', () => {
    const route = syntheticRoute({
      taskClass: 'web-tier', provider: 'cursor', model: 'cursor-tier', prefer: [{ tier: 'T1' }],
      fallback: { provider: 'gemini', model: 'gemini-fallback' }, requiresWeb: true, editsCode: false,
    });
    const result = resolveTierTarget(route, [], {}, {
      lanes: { ...lanes, tiers: { ...lanes.tiers, 'T1-workhorse': ['cursor-only'] } },
      laneDefaults: { 'cursor-only': { provider: 'cursor', model: 'cursor-tier' } },
    });

    expect(result).toMatchObject({ provider: 'gemini', model: 'gemini-fallback' });
    expect(result.walk).toContain('T1 skipped (no concrete lane target)');
  });

  it('filters a T0 lane for an edits-code tier route', () => {
    const route = syntheticRoute({
      taskClass: 'editing-tier', provider: 'groq', model: 't0-tier', prefer: [{ tier: 'T0' }],
      fallback: { provider: 'codex', model: 'codex-fallback' }, requiresWeb: false, editsCode: true,
    });
    const result = resolveTierTarget(route, [], {}, {
      lanes: { ...lanes, tiers: { ...lanes.tiers, 'T0-menial': ['groq-only'] } },
      laneDefaults: { 'groq-only': { provider: 'groq', model: 't0-tier' } },
    });

    expect(result).toMatchObject({ provider: 'codex', model: 'codex-fallback' });
    expect(result.walk).toContain('T0 skipped (no concrete lane target)');
    expect(result.walk.join(' | ')).not.toMatch(/groq\/t0-tier chosen/);
  });

  it('gates the DIRECT T3 fable candidate on capability (skips a non-web fable, descends to a web-capable lane)', () => {
    const route = syntheticRoute({
      taskClass: 'web-t3', provider: 'claude', model: 'opus', prefer: [{ tier: 'T3' }],
      requiresWeb: true, editsCode: false,
    });
    const result = resolveTierTarget(route, [], {}, {
      lanes: { ...lanes, tiers: { ...lanes.tiers, 'T3-orchestrator': ['fable'], 'T2-judgment': ['gemini-web'] } },
      laneDefaults: { ...(table.laneDefaults ?? {}), 'gemini-web': { provider: 'gemini', model: 'gemini-web' } },
    });
    // fable (claude) is not web-capable → the DIRECT T3 fable is skipped (pre-fix it was chosen ungated);
    // the descended T2 gemini lane (web-capable) wins instead.
    expect(result).toMatchObject({ provider: 'gemini', model: 'gemini-web' });
    expect(result.walk.join(' | ')).not.toMatch(/claude\/fable chosen/);
  });

  it('gates the DECLARED FALLBACK on capability (a non-web declared fallback is not selected for a web route)', () => {
    const route = syntheticRoute({
      taskClass: 'web-fb', provider: 'cursor', model: 'cursor-x', prefer: [{ tier: 'T1' }],
      fallback: { provider: 'cursor', model: 'cursor-fb' }, requiresWeb: true, editsCode: false,
    });
    const result = resolveTierTarget(route, [], {}, {
      lanes: { ...lanes, tiers: { ...lanes.tiers, 'T1-workhorse': ['cursor-only'] } },
      laneDefaults: { ...(table.laneDefaults ?? {}), 'cursor-only': { provider: 'cursor', model: 'cursor-tier' } },
    });
    // The cursor declared fallback is NOT web-capable → skipped by the capability gate (matching walkLadder);
    // it must NOT be selected for a requiresWeb route (pre-fix it was pushed ungated and chosen first).
    expect(result.model).not.toBe('cursor-fb');
  });
});

describe('Fable tier gate (C1): an unset tier is Fable-capable', () => {
  it('resolves the Fable classes to Fable when the Claude account is UNTIERED (the real registry)', () => {
    const untiered = [account('claude'), account('codex', 'T2')];
    expect(resolve('orchestration', untiered)).toMatchObject({ provider: 'claude', model: 'fable' });
    expect(resolve('escalate-judgment', untiered)).toMatchObject({ provider: 'claude', model: 'fable' });
  });

  it('gates Fable only when EVERY logged-in Claude account carries an explicit non-T3 tier', () => {
    // All explicit non-T3 → Fable gated → Opus.
    expect(resolve('orchestration', [account('claude', 'T2'), account('claude', 'T1')]))
      .toMatchObject({ provider: 'claude', model: 'opus' });
    // A single T3 among them → Fable available again.
    expect(resolve('orchestration', [account('claude', 'T2'), account('claude', 'T3')]))
      .toMatchObject({ provider: 'claude', model: 'fable' });
    // A mix of explicit non-T3 and UNTIERED → the untiered one is Fable-capable → Fable available.
    expect(resolve('orchestration', [account('claude', 'T2'), account('claude')]))
      .toMatchObject({ provider: 'claude', model: 'fable' });
  });
});

describe('planDispatch wires the resolver on the real dispatch path (M2)', () => {
  // The standalone-resolver tests above prove resolveTierTarget; this proves planDispatch actually
  // CALLS it (needsTierResolution → registry read → target/symbol), which a resolver-only test cannot.
  // caps:{} + accounts:[] keep the plan off disk; accountRegistry injects the synthetic registry.
  const plan = (taskClass: string, accountRegistry: Account[]) => planDispatch(
    { taskClass, prompt: 'x', cwd: tmpdir(), accountRegistry, caps: {}, accounts: [] }, table,
  );

  it('orchestration resolves to Fable through planDispatch on an untiered registry', () => {
    const p = plan('orchestration', [account('claude'), account('codex', 'T2')]);
    expect(p.target).toMatchObject({ provider: 'claude', model: 'fable' });
    expect(p.symbol).toBe('claude/fable');
  });

  it('orchestration resolves to Opus through planDispatch when every Claude account is explicit non-T3', () => {
    const p = plan('orchestration', [account('claude', 'T2')]);
    expect(p.target).toMatchObject({ provider: 'claude', model: 'opus' });
    expect(p.symbol).toBe('claude/opus');
  });

  it('escalate-judgment (legacy fable class, no prefer) also falls to Opus through planDispatch', () => {
    const p = plan('escalate-judgment', [account('claude', 'T2')]);
    expect(p.target).toMatchObject({ provider: 'claude', model: 'opus' });
  });

  it('does NOT resolve a tier symbol for an explicit provider/model override (M1)', () => {
    // Explicit override on a prefer class: the caller named the route, so no registry read and no symbol.
    const p = planDispatch(
      { taskClass: 'orchestration', provider: 'codex', model: 'gpt-5.6-terra', prompt: 'x', cwd: tmpdir(), caps: {}, accounts: [] },
      table,
    );
    expect(p.symbol).toBeUndefined();
    expect(p.target).toMatchObject({ provider: 'codex', model: 'gpt-5.6-terra' });
  });
});

describe('tier-symbol schema validation', () => {
  // Mirrors routing.test.ts's temp-file loader: prefer is a LOAD-time policy fence, so a malformed
  // symbol or a forbidden literal route must throw in loadRouting, never reach dispatch-time resolution.
  const loadBad = (taskClassesYaml: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'heddle-397-'));
    const path = join(dir, 'routing.yaml');
    writeFileSync(path, `version: 0\nproviders:\n  claude:\n    models: [opus, fable]\ntask_classes:\n${taskClassesYaml}`);
    return () => loadRouting(path);
  };

  it('readTargetTier accepts T0–T3 and rejects anything else (does not widen the expansion Tier)', () => {
    for (const t of ['T0', 'T1', 'T2', 'T3']) expect(readTargetTier(t)).toBe(t);
    expect(() => readTargetTier('T9')).toThrow(/T0, T1, T2, T3/);
    expect(() => readTargetTier('workhorse')).toThrow();
    expect(() => readTargetTier(2)).toThrow();
  });

  it('rejects a malformed or forbidden prefer at load time', () => {
    expect(loadBad('  x:\n    prefer: []')).toThrow(/non-empty/);
    expect(loadBad('  x:\n    prefer: [T9]')).toThrow(/T0, T1, T2, T3/);
    expect(loadBad('  x:\n    prefer: [notaslash]')).toThrow(/provider\/model/);
    expect(loadBad('  x:\n    prefer: [ghost/model]')).toThrow(/unknown provider/);
  });

  it('keeps legacy provider/model classes resolving unchanged (no prefer)', () => {
    const route = resolveRoute(table, 'implementation');
    expect(route.prefer).toBeUndefined();
    expect(resolveTierTarget(route, mayaLike, {}, { lanes, laneDefaults: table.laneDefaults ?? {} }))
      .toMatchObject({ provider: 'codex', model: 'gpt-5.6-terra' });
  });
});

// HED-698: an env-repoint row rides the claude harness but serves another family. It never proves a
// NATIVE Claude registry alive; an env-repoint-only registry keeps HED-531 (its row is that Claude).
describe('env-repoint rows and native provider presence (HED-698)', () => {
  const glmRow: Account = { ...account('claude'), id: 'glm', credentialRef: 'claude:glm:/x/glm',
    envRepoint: { baseUrl: 'https://glm.example.test/api/anthropic', authTokenRef: 'GLM_KEY', service: 'glm' } };
  it('walks off claude when every NATIVE Claude account is logged out, even with a live GLM row', () => {
    const accounts: Account[] = [{ ...account('claude'), loggedIn: false }, glmRow, account('codex')];
    expect(resolve('orchestration', accounts).provider).not.toBe('claude');
  });
  it('treats an env-repoint-only Claude registry as Claude-present (HED-531)', () => {
    expect(resolve('orchestration', [glmRow, account('codex')]).provider).toBe('claude');
  });
});
