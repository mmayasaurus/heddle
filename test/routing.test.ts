import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadRouting, listTaskClasses, resolveRoute, directRoute, neverViaCursorPrefixes, isNeverViaCursor, providerExecution } from '../src/routing.js';
import { workerMcpSupported } from '../src/mcp.js';
import { normalizeProvider } from '../src/review.js';

/**
 * Behavioral checks on the SHIPPED routing table (routing/routing.v0.yaml) — the file Maya tunes by
 * hand. These catch the mistakes a YAML edit can introduce silently: a class pointing at a model
 * its provider doesn't list, a fallback into an excluded provider, or a Cursor route that would
 * spend a direct-subscription family through the middleman (policy `never_via_cursor`).
 *
 * Per-class invariants use `it.each` so a failure names the offending class instead of stopping
 * the whole loop at the first one.
 */
const here = dirname(fileURLToPath(import.meta.url));
const TABLE_PATH = join(here, '..', 'routing', 'routing.v0.yaml');

describe('routing.v0.yaml — shipped table invariants', () => {
  const table = loadRouting(TABLE_PATH);
  const classes = listTaskClasses(table);
  const targetsOf = (c: string) => {
    const r = resolveRoute(table, c);
    return [r, r.fallback].filter(Boolean) as { provider: string; model: string }[];
  };

  it('has at least one task class', () => {
    expect(classes.length).toBeGreaterThan(0);
  });

  it.each(classes)('%s: if it carries mcp, EVERY provider it can resolve to is worker-MCP-attachable (HED-249)', (c) => {
    // The hard constraint that replaced HED-205's runtime graceful-degrade: an mcp-carrying class must
    // never resolve to a provider that can't attach mcp (gemini/agy) — that hard-fails the dispatch
    // (cursor-blip SPOF, ledger 254). Check the RESOLVED targets: fallback inherits the class mcp unless
    // it sets its own (a fallback with `mcp: []` is legitimately exempt); a picked pool reviewer carries
    // the class mcp. Catches the misconfiguration at CI time, louder and earlier than the runtime throw.
    const r = resolveRoute(table, c);
    const targets: Array<{ label: string; provider: string; mcp?: string[] }> = [
      { label: 'primary', provider: r.provider, mcp: r.mcp },
      ...(r.fallback ? [{ label: 'fallback', provider: r.fallback.provider, mcp: r.fallback.mcp }] : []),
      ...(r.reviewerPool ?? []).map((e, i) => ({ label: `reviewer_pool[${i}]`, provider: e.provider, mcp: r.mcp })),
    ];
    for (const t of targets) {
      if ((t.mcp ?? []).length === 0) continue; // no mcp to attach → any provider is fine
      // Normalize (trim + lowercase) exactly as dispatch does before attach, so a cased YAML entry
      // like " Codex " isn't falsely flagged (copilot/cubic #73).
      const provider = normalizeProvider(t.provider) ?? t.provider;
      expect(workerMcpSupported(provider), `class "${c}" ${t.label} (${t.provider}) carries mcp [${t.mcp}] but is not worker-MCP-attachable`).toBe(true);
    }
  });

  it.each(classes)('%s resolves to a provider and a model', (c) => {
    const r = resolveRoute(table, c);
    expect(r.provider).toBeTruthy();
    expect(r.model).toBeTruthy();
  });

  it.each(classes)('%s: primary and fallback providers exist in the providers block and are not excluded', (c) => {
    for (const t of targetsOf(c)) {
      const cfg = table.providers[t.provider];
      expect(cfg, `unknown provider "${t.provider}"`).toBeDefined();
      expect(cfg.status, `provider "${t.provider}" is excluded`).not.toBe('excluded');
    }
  });

  it.each(classes)('%s: every routed model is in its provider\'s declared model list (catalog snapshot)', (c) => {
    for (const t of targetsOf(c)) {
      const models = table.providers[t.provider]?.models as string[] | undefined;
      expect(models, `provider "${t.provider}" declares no models`).toBeDefined();
      expect(models, `"${t.model}" not in ${t.provider}.models`).toContain(t.model);
    }
  });

  it('declares the never_via_cursor policy for the direct-subscription families', () => {
    expect(table.policy.never_via_cursor).toEqual(['claude', 'gpt', 'gemini']);
  });

  it('expands never_via_cursor families to the unchanged Cursor-refusal prefix set', () => {
    expect(new Set(neverViaCursorPrefixes(table))).toEqual(new Set(['claude-', 'gpt-', 'o1-', 'o3-', 'gemini-']));
  });

  it.each(classes)('%s: never routes a never_via_cursor family through cursor', (c) => {
    const banned = neverViaCursorPrefixes(table);
    for (const t of targetsOf(c)) {
      if (t.provider !== 'cursor') continue;
      for (const p of banned) {
        expect(t.model.startsWith(p), `cursor route "${t.model}" violates never_via_cursor`).toBe(false);
      }
    }
  });

  it('second-opinion-hard stays opt-in (it burns the metered Cursor pool PR review needs)', () => {
    const r = resolveRoute(table, 'second-opinion-hard');
    expect(r.requiresExplicitOptIn).toBe(true);
    expect(r.note).toMatch(/PR review/i);
  });
});

describe('resolveRoute / directRoute — policy fences', () => {
  const table = loadRouting(TABLE_PATH);
  const directSubscriptionModels = ['claude-opus-4.6', 'gpt-5.6', 'gemini-3-pro', 'o1-preview', 'o3-mini'];
  const cursorModels = ['cursor-grok-4.6-high', 'composer-2.5', 'kimi-k3-high'];

  it('adversarial-review defaults to memtrace so a reviewer gets code discovery (HED-205)', () => {
    expect(resolveRoute(table, 'adversarial-review').mcp).toEqual(['memtrace']);
  });

  it('rejects an unknown class and lists every known class in the message', () => {
    let message = '';
    try { resolveRoute(table, 'no-such-class'); } catch (e) { message = (e as Error).message; }
    expect(message).toMatch(/unknown task class "no-such-class"/);
    for (const known of listTaskClasses(table)) expect(message).toContain(known);
  });

  it('refuses a direct route to the excluded provider (ollama-cloud is the PR-reviewer pool)', () => {
    expect(() => directRoute(table, 'ollama-cloud', 'anything')).toThrow(/excluded/);
  });

  it('refuses a direct route to a provider the table does not know', () => {
    expect(() => directRoute(table, 'openrouter', 'x')).toThrow(/unknown provider "openrouter"/);
  });

  it.each(directSubscriptionModels)('rejects %s through Cursor in both class and direct routing', (model) => {
    const className = `cursor-${model}`;
    const routedTable = { ...table, taskClasses: { ...table.taskClasses, [className]: { provider: 'cursor', model } } };
    expect(() => resolveRoute(routedTable, className)).toThrow(/direct-subscription family/);
    expect(() => directRoute(table, 'cursor', model)).toThrow(/direct-subscription family/);
  });

  it.each(directSubscriptionModels)('rejects %s through Cursor as a class fallback', (model) => {
    const className = `cursor-fallback-${model}`;
    const routedTable = { ...table, taskClasses: { ...table.taskClasses, [className]: { provider: 'codex', model: 'gpt-5.6-luna', fallback: { provider: 'cursor', model } } } };
    expect(() => resolveRoute(routedTable, className)).toThrow(/direct-subscription family/);
  });

  it.each(cursorModels)('allows the Cursor-native model %s through both class and direct routing', (model) => {
    const className = `cursor-${model}`;
    const routedTable = { ...table, taskClasses: { ...table.taskClasses, [className]: { provider: 'cursor', model } } };
    expect(() => resolveRoute(routedTable, className)).not.toThrow();
    expect(() => directRoute(table, 'cursor', model)).not.toThrow();
  });

  it('rejects a primary provider that is held', () => {
    const routedTable = { ...table, providers: { ...table.providers, held: { status: 'held' } }, taskClasses: { ...table.taskClasses, held: { provider: 'held', model: 'm1' } } };
    expect(() => resolveRoute(routedTable, 'held')).toThrow(/provider "held" is on hold and not routable yet/);
  });

  it('rejects a fallback provider that is held', () => {
    const routedTable = { ...table, providers: { ...table.providers, held: { status: 'held' } }, taskClasses: { ...table.taskClasses, 'fallback-held': { provider: 'codex', model: 'gpt-5.6-luna', fallback: { provider: 'held', model: 'm1' } } } };
    expect(() => resolveRoute(routedTable, 'fallback-held')).toThrow(/fallback provider "held" is on hold and not routable yet/);
  });

  it('refuses a DIFFERENTLY-CASED direct-subscription id through Cursor (case-insensitive — gitar #63)', () => {
    for (const model of ['GPT-5.6', 'Claude-3', 'Gemini-3-pro', 'O3-mini']) {
      const className = `cursor-upper-${model}`;
      const routedTable = { ...table, taskClasses: { ...table.taskClasses, [className]: { provider: 'cursor', model } } };
      expect(() => resolveRoute(routedTable, className)).toThrow(/direct-subscription family/);
      expect(() => directRoute(table, 'cursor', model)).toThrow(/direct-subscription family/);
    }
    expect(isNeverViaCursor(table, 'GPT-5.6')).toBe(true);
    expect(isNeverViaCursor(table, 'cursor-grok-4.6-high')).toBe(false);
  });

  it('FAILS SAFE on a malformed never_via_cursor — refuses ALL families, not none (codeant #63)', () => {
    for (const badPolicy of [{}, { never_via_cursor: 'claude' }, { never_via_cursor: null }]) {
      const bad = { ...table, policy: badPolicy as any };
      expect(new Set(neverViaCursorPrefixes(bad))).toEqual(new Set(['claude-', 'gpt-', 'o1-', 'o3-', 'gemini-']));
      const rt = { ...bad, taskClasses: { ...table.taskClasses, x: { provider: 'cursor', model: 'gpt-5.6' } } };
      expect(() => resolveRoute(rt, 'x')).toThrow(/direct-subscription family/);
    }
  });

  it('rejects a task class whose PRIMARY provider is unknown (copilot #63)', () => {
    const rt = { ...table, taskClasses: { ...table.taskClasses, bad: { provider: 'openrouter', model: 'x' } } };
    expect(() => resolveRoute(rt, 'bad')).toThrow(/names unknown provider "openrouter"/);
  });

  it('treats a task class whose provider is an inherited property (`toString`) as UNKNOWN, never the prototype method (cubic #63)', () => {
    const rt = { ...table, taskClasses: { ...table.taskClasses, proto: { provider: 'toString', model: 'x' } } };
    expect(() => resolveRoute(rt, 'proto')).toThrow(/names unknown provider "toString"/);
    // same prototype-key hole in the fallback slot and in a direct route
    const rtf = { ...table, taskClasses: { ...table.taskClasses, protofb: { provider: 'codex', model: 'gpt-5.6-luna', fallback: { provider: 'constructor', model: 'x' } } } };
    expect(() => resolveRoute(rtf, 'protofb')).toThrow(/fallback names unknown provider "constructor"/);
    expect(() => directRoute(table, 'toString', 'x')).toThrow(/unknown provider "toString"/);
  });

  it('FAILS SAFE on an EMPTY or non-string never_via_cursor — refuses ALL families, never none (cubic #63)', () => {
    for (const badPolicy of [{ never_via_cursor: [] }, { never_via_cursor: ['claude', 123] }, { never_via_cursor: [null] }]) {
      const bad = { ...table, policy: badPolicy as any };
      expect(new Set(neverViaCursorPrefixes(bad))).toEqual(new Set(['claude-', 'gpt-', 'o1-', 'o3-', 'gemini-']));
      const rt = { ...bad, taskClasses: { ...table.taskClasses, x: { provider: 'cursor', model: 'gpt-5.6' } } };
      expect(() => resolveRoute(rt, 'x')).toThrow(/direct-subscription family/);
    }
  });

  it('case-folds a custom never_via_cursor family and expands upper-case GPT to its o1-/o3- ids (cubic #63)', () => {
    // a synthesized prefix for a non-hardcoded family must be lowercased so a lowercased model still matches
    const groq = { ...table, policy: { never_via_cursor: ['Groq'] } as any,
      taskClasses: { ...table.taskClasses, g: { provider: 'cursor', model: 'groq-3' } } };
    expect(() => resolveRoute(groq, 'g')).toThrow(/direct-subscription family/);
    // the hardcoded-family lookup is case-folded too, so `GPT` still reaches o1-/o3-, not just gpt-
    const gpt = { ...table, policy: { never_via_cursor: ['GPT'] } as any,
      taskClasses: { ...table.taskClasses, o: { provider: 'cursor', model: 'o1-mini' } } };
    expect(() => resolveRoute(gpt, 'o')).toThrow(/direct-subscription family/);
    // a prototype-key family must not embed the inherited method (which would crash the compare)
    const proto = { ...table, policy: { never_via_cursor: ['toString'] } as any };
    expect(() => neverViaCursorPrefixes(proto)).not.toThrow();
    expect(neverViaCursorPrefixes(proto)).toEqual(['tostring-']);
  });

  it('a direct route carries the caller\'s skills/mcp and a self-describing task class', () => {
    const r = directRoute(table, 'codex', 'gpt-5.6-luna', ['worker-role'], ['memtrace']);
    expect(r.taskClass).toBe('direct:codex/gpt-5.6-luna');
    expect(r.skills).toEqual(['worker-role']);
    expect(r.mcp).toEqual(['memtrace']);
    expect(r.fallback).toBeUndefined();
  });
});

describe('resolveRoute — fallback inherits class policy', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  function syntheticTable(yaml: string) {
    const dir = mkdtempSync(join(tmpdir(), 'heddle-routing-test-'));
    dirs.push(dir);
    const path = join(dir, 'routing.yaml');
    writeFileSync(path, yaml);
    return loadRouting(path);
  }

  it('inherits deep-implementation skills and mcp into its fallback without inheriting effort', () => {
    const fallback = resolveRoute(loadRouting(TABLE_PATH), 'deep-implementation').fallback;
    expect(fallback).toMatchObject({
      provider: 'codex', model: 'gpt-5.6-sol',
      skills: ['worker-role', 'code-discovery', 'quality-gate'], mcp: ['memtrace'],
    });
    expect(fallback?.effort).toBeUndefined();
  });

  it('keeps bulk-mechanical primary effort out of its fallback while carrying class skills', () => {
    const route = resolveRoute(loadRouting(TABLE_PATH), 'bulk-mechanical');
    expect(route.effort).toBe('low');
    expect(route.fallback?.effort).toBeUndefined();
    expect(route.fallback?.skills).toEqual(['worker-role', 'quality-gate']);
  });

  it('uses a fallback node’s own skills instead of the class skills when the fallback defines them', () => {
    const table = syntheticTable(`
providers: { codex: {} }
task_classes:
  synthetic:
    provider: codex
    model: m1
    skills: [a, b]
    fallback: { provider: codex, model: m2, skills: [only-this] }
`);
    const fallback = resolveRoute(table, 'synthetic').fallback;
    expect(fallback?.skills).toEqual(['only-this']);
    expect(fallback?.mcp).toBeUndefined();
  });

  it('defers rejecting bare skills and mcp values until resolveRoute validates each target', () => {
    const skillsYaml = `
providers: { codex: {} }
task_classes: { synthetic: { provider: codex, model: m1, skills: quality-gate } }
`;
    const mcpYaml = `
providers: { codex: {} }
task_classes: { synthetic: { provider: codex, model: m1, mcp: memtrace } }
`;
    // loadRouting itself must accept these files — the assignments below fail the test if it throws.
    const skillsTable = syntheticTable(skillsYaml);
    const mcpTable = syntheticTable(mcpYaml);
    expect(() => resolveRoute(skillsTable, 'synthetic')).toThrow(/skills must be a list of strings/);
    expect(() => resolveRoute(mcpTable, 'synthetic')).toThrow(/mcp must be a list of strings/);
  });

  it('rejects a fallback node that lacks a provider or a model instead of routing to "undefined"', () => {
    const table = syntheticTable(`
providers: { codex: {} }
task_classes:
  synthetic:
    provider: codex
    model: m1
    fallback: { provider: codex }
`);
    expect(() => resolveRoute(table, 'synthetic')).toThrow(/task class "synthetic": fallback is missing provider or model/);
  });

  it('reports declared provider execution modes and leaves unknown providers undefined', () => {
    const table = loadRouting(TABLE_PATH);
    expect(providerExecution(table, 'claude')).toBe('headless'); // HED-78: claude -p under the best account; in_session:true keeps the subagent protocol
    expect(providerExecution(table, 'codex')).toBe('headless');
    expect(providerExecution(table, 'no-such-provider')).toBeUndefined();
  });
});

describe('resolveRoute — fallback provider policy checks', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs.length = 0; });
  function table(yaml: string) {
    const dir = mkdtempSync(join(tmpdir(), 'heddle-routing-fbpolicy-'));
    dirs.push(dir);
    const path = join(dir, 'routing.yaml');
    writeFileSync(path, yaml);
    return loadRouting(path);
  }

  it('rejects a fallback that names a provider the table does not declare', () => {
    const t = table('providers: { codex: {} }\ntask_classes:\n  synth: { provider: codex, model: m1, fallback: { provider: nope, model: x } }\n');
    expect(() => resolveRoute(t, 'synth')).toThrow(/fallback names unknown provider "nope"/);
  });

  it('rejects a fallback into an excluded provider at resolve time, not after the primary fails', () => {
    const t = table('providers: { codex: {}, ollama-cloud: { status: excluded } }\ntask_classes:\n  synth: { provider: codex, model: m1, fallback: { provider: ollama-cloud, model: x } }\n');
    expect(() => resolveRoute(t, 'synth')).toThrow(/fallback routes to excluded provider "ollama-cloud"/);
  });
});
