import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describeTaskClasses, loadRouting, listTaskClasses, resolveRoute, directRoute, neverViaCursorPrefixes, isNeverViaCursor, providerExecution, type Route } from '../src/routing.js';
import { targetModels } from '../src/health/parse.js';
import { mcpAttachable, webCapable } from '../src/mcp.js';
import { ENFORCEABLE } from '../src/capabilities.js';
import { normalizeProvider, pickReviewer } from '../src/review.js';

/**
 * Behavioral checks on the SHIPPED routing table (routing/routing.v0.yaml) — the file the operator tunes by
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

  it.each(classes)('%s: every provider a capability-carrying class resolves to satisfies that capability (HED-249, HED-239)', (c) => {
    // The hard constraint that replaced HED-205's runtime graceful-degrade: an mcp-carrying class must
    // never resolve to a provider that can't attach mcp (gemini/agy) — that hard-fails the dispatch
    // (cursor-blip SPOF, ledger 254). Check the RESOLVED targets: fallback inherits the class mcp unless
    // it sets its own (a fallback with `mcp: []` is legitimately exempt); a picked pool reviewer carries
    // the class mcp. Catches the misconfiguration at CI time, louder and earlier than the runtime throw.
    const r = resolveRoute(table, c);
    const targets: Array<{ label: string; provider: string; mcp?: string[]; capabilities?: string[] }> = [
      { label: 'primary', provider: r.provider, mcp: r.mcp, capabilities: r.capabilities },
      ...(r.fallback ? [{ label: 'fallback', provider: r.fallback.provider, mcp: r.fallback.mcp, capabilities: r.fallback.capabilities }] : []),
      ...(r.reviewerPool ?? []).map((e, i) => ({ label: `reviewer_pool[${i}]`, provider: e.provider, mcp: e.mcp ?? r.mcp, capabilities: r.capabilities })),
    ];
    for (const t of targets) {
      // Normalize (trim + lowercase) exactly as dispatch does before attach, so a cased YAML entry
      // like " Codex " isn't falsely flagged (copilot/cubic #73).
      const provider = normalizeProvider(t.provider) ?? t.provider;
      if ((t.mcp ?? []).length > 0) {
        // Validate the DECLARED server list, not a generic memtrace probe — `['serena']` on cursor is
        // unattachable even though cursor attaches memtrace (cubic #73).
        expect(mcpAttachable(provider, t.mcp ?? []), `class "${c}" ${t.label} (${t.provider}) cannot attach its mcp [${t.mcp}]`).toBe(true);
      }
      if (r.requiresWeb) {
        expect(webCapable(provider, t.capabilities ?? []), `class "${c}" ${t.label} (${t.provider}) cannot perform web research`).toBe(true);
      }
      // The GENERAL invariant (not just requiresWeb): every ordinary capability a class DECLARES
      // (net/browse/exec-privileged) must be enforceable by every provider the class resolves to —
      // else the grant is a silent no-op the run would refuse as `unenforceable` (codex #76). The
      // operator two-key gate still governs exec-privileged at dispatch; enforceability is the floor.
      // OWN-PROPERTY read (like decideCapabilities): a provider literally named "toString"/"constructor"
      // must resolve to [] (unknown), never an inherited function that crashes .includes (qodo #76 / HED-21).
      const enforceable: readonly string[] = Object.hasOwn(ENFORCEABLE, provider) ? ENFORCEABLE[provider] : [];
      for (const cap of t.capabilities ?? []) {
        expect(enforceable.includes(cap),
          `class "${c}" ${t.label} (${t.provider}) declares capability "${cap}" its provider cannot enforce`).toBe(true);
      }
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

  it('every Claude-routed alias (and the claude catalog) is pinned in CLAUDE_MODEL_IDS', async () => {
    const { CLAUDE_MODEL_IDS } = await import('../src/adapters/claude.js');
    const pinned = Object.keys(CLAUDE_MODEL_IDS);
    for (const m of (table.providers.claude?.models as string[] | undefined) ?? []) {
      expect(pinned, `claude catalog alias \"${m}\" is not pinned in CLAUDE_MODEL_IDS`).toContain(m);
    }
    for (const c of classes) for (const t of targetsOf(c)) if (t.provider === 'claude') {
      expect(pinned, `class ${c} routes unpinned claude model \"${t.model}\"`).toContain(t.model);
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

  it('web-research requires web capability and gives its Codex fallback browse', () => {
    const route = resolveRoute(table, 'web-research');
    expect(route.requiresWeb).toBe(true);
    expect(route.fallback?.capabilities).toEqual(['browse']);
  });

  it('keeps FDL public-source research inert and pins its complete GLM resource envelope', () => {
    const route = resolveRoute(table, 'fdl-public-source-research') as Route & { bounds?: Record<string, number | boolean> };
    expect(route).toMatchObject({
      provider: 'glm', model: 'glm-5.3', readOnly: true, autoAssess: false,
      requiresExplicitOptIn: true, fallback: undefined,
    });
    expect(route.mcp ?? []).toEqual([]);
    expect(route.capabilities ?? []).toEqual([]);
    expect(route.bounds).toEqual({
      maxModelRequests: 1,
      maxInputTokens: 72_000,
      maxGeneratedTokens: 8_000,
      maxTotalTokens: 80_000,
      maxOutputBytes: 16_000,
      maxConcurrency: 1,
      timeoutMs: 150_000,
      maxDispatchesPerHour: 4,
      maxDispatchesPerSession: 48,
      maxSessionTokens: 2_400_000,
      maxHeadroomAgeMs: 300_000,
      retry: false,
    });
  });
});

describe('pickReviewer — per-entry mcp reaches the usability gate (codeant #111)', () => {
  it('checks each duplicate (provider,model) pool entry against its own mcp list', () => {
    // Author is cursor (so both glm entries are eligible different-family reviewers). The two entries
    // share (glm, glm-5.3) but differ in mcp: the first demands [memtrace] (unattachable for an HTTP
    // provider), the second opts out with []. A gate that re-derived mcp by (provider,model) would
    // test BOTH against the first entry's list and wrongly reject the usable second one (→ throws).
    const route = {
      taskClass: 'dup', provider: 'cursor', model: 'cursor-grok-4.6-high',
      reviewerPool: [
        { provider: 'glm', model: 'glm-5.3', mcp: ['memtrace'] },
        { provider: 'glm', model: 'glm-5.3', mcp: [] },
      ],
    } as unknown as Route;
    // Gate mirrors plan.ts: reject only when the entry's OWN mcp is a non-empty, unattachable list.
    const usable = (_p: string, _m: string, mcp?: string[]) => ((mcp ?? []).length > 0 ? 'cannot attach the class mcp' : null);
    expect(pickReviewer(route, 'cursor', usable)).toMatchObject({ provider: 'glm', model: 'glm-5.3', mcp: [], reason: 'pool:2 (author is cursor)' });
  });
});

describe('resolveRoute / directRoute — policy fences', () => {
  const table = loadRouting(TABLE_PATH);
  const directSubscriptionModels = ['claude-opus-4.6', 'gpt-5.6', 'gemini-3-pro', 'o1-preview', 'o3-mini'];
  const cursorModels = ['cursor-grok-4.6-high', 'composer-2.5', 'kimi-k3-high'];

  it('adversarial-review defaults to memtrace so a reviewer gets code discovery (HED-205)', () => {
    expect(resolveRoute(table, 'adversarial-review').mcp).toEqual(['memtrace']);
  });

  it('HED-465: GLM is the cursor-primary advisory fallback only, never an adversarial-review target', () => {
    // glm ships on the two CURSOR-primary advisory classes (no dead-claude walk, no capability hatch).
    for (const taskClass of ['second-opinion', 'quick-alt-take']) {
      expect(resolveRoute(table, taskClass).fallback).toMatchObject({ provider: 'glm', model: 'glm-5.3' });
    }
    // research-summarize's fallback stays codex/luna, NOT glm: its claude PRIMARY needs an always-addressable
    // non-claude walk (HED-264) and a capability-enforcing fallback (net/exec → codex). See routing.v0.yaml.
    expect(resolveRoute(table, 'research-summarize').fallback).toMatchObject({ provider: 'codex', model: 'gpt-5.6-luna' });
    const adversarial = resolveRoute(table, 'adversarial-review');
    const adversarialProviders = [adversarial.provider, adversarial.fallback?.provider, ...(adversarial.reviewerPool ?? []).map((entry) => entry.provider)]
      .filter((provider): provider is string => Boolean(provider)).map((provider) => normalizeProvider(provider));
    expect(adversarialProviders).not.toContain('glm');
    expect(() => directRoute(table, 'glm', 'glm-5.3')).not.toThrow();
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
    expect(() => directRoute(table, 'not-a-provider', 'x')).toThrow(/unknown provider "not-a-provider"/);
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
    const rt = { ...table, taskClasses: { ...table.taskClasses, bad: { provider: 'not-a-provider', model: 'x' } } };
    expect(() => resolveRoute(rt, 'bad')).toThrow(/names unknown provider "not-a-provider"/);
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

describe('HED-545 — prefer-only classes during enumeration', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  function tierOnlyTable() {
    return {
      version: 0,
      policy: {},
      providers: { claude: { models: ['haiku'] } },
      taskClasses: {
        orchestration: { prefer: ['T2'], dispatchable: false, edits_code: false },
        implementation: { provider: 'claude', model: 'haiku', edits_code: true },
      },
    };
  }

  it('describes a tier-only prefer-only class without resolving it and preserves its guidance', () => {
    const table = tierOnlyTable();
    (table.taskClasses as Record<string, unknown>).orchestration = {
      prefer: ['T2'],
      dispatchable: false,
      edits_code: false,
      skills: ['orchestrator-guide'],
      mcp: ['memtrace'],
      reviewer_pool: [{ provider: 'claude', model: 'haiku' }],
    };
    expect(() => resolveRoute(table, 'orchestration')).toThrow(/missing provider or model/);
    expect(() => describeTaskClasses(table)).not.toThrow();
    expect(describeTaskClasses(table).find((row) => row.task_class === 'orchestration')).toMatchObject({
      provider: null,
      model: null,
      prefer: ['T2'],
      dispatchable: false,
      skills: ['orchestrator-guide'],
      mcp: ['memtrace'],
      reviewer_pool: ['claude/haiku'],
    });
    expect(describeTaskClasses(table).find((row) => row.task_class === 'implementation')).toMatchObject({
      provider: 'claude', model: 'haiku',
    });
  });

  it('re-throws for a CONCRETE class that fails to resolve — never masks a misconfig as prefer-only', () => {
    const table = tierOnlyTable();
    (table.taskClasses as Record<string, unknown>).broken = { provider: 'nonexistent', model: 'x' };
    // The tolerance is ONLY for prefer-only classes; a concrete provider+model that resolveRoute
    // rejects (here: unknown provider) must still throw from enumeration, not be masked as prefer-only.
    expect(() => describeTaskClasses(table)).toThrow(/unknown provider/);
  });

  it('re-throws for a dispatchable tier-only class', () => {
    const table = tierOnlyTable();
    (table.taskClasses as Record<string, unknown>).dispatchableTierOnly = { prefer: ['T2'] };
    expect(() => describeTaskClasses(table)).toThrow(/missing provider or model/);
  });

  it('re-throws for a malformed prefer-only-shaped class', () => {
    const table = tierOnlyTable();
    (table.taskClasses as Record<string, unknown>).malformed = { prefer: 'T2', dispatchable: false };
    expect(() => describeTaskClasses(table)).toThrow(/prefer must be a non-empty list/);
  });

  it('keeps shipped orchestration on its concrete Fable route', () => {
    const orchestration = describeTaskClasses(loadRouting(TABLE_PATH))
      .find((row) => row.task_class === 'orchestration');
    expect(orchestration).toMatchObject({ provider: 'claude', model: 'fable' });
  });

  it('skips a tier-only prefer-only class while enumerating catalog targets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'heddle-545-'));
    dirs.push(dir);
    const path = join(dir, 'routing.yaml');
    writeFileSync(path, [
      'version: 0',
      'providers:',
      '  claude: { models: [haiku] }',
      'task_classes:',
      '  orchestration: { prefer: [T2], dispatchable: false, edits_code: false }',
      '  implementation: { provider: claude, model: haiku }',
      '',
    ].join('\n'));
    expect(() => targetModels('claude', path)).not.toThrow();
  });

  it('surfaces a real routing error while enumerating catalog targets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'heddle-545-'));
    dirs.push(dir);
    const path = join(dir, 'routing.yaml');
    writeFileSync(path, [
      'version: 0',
      'providers:',
      '  claude: { models: [haiku] }',
      'task_classes:',
      '  orchestration: { prefer: [T2], dispatchable: false }',
      '  broken: { provider: unknown, model: m1 }',
      '',
    ].join('\n'));
    expect(() => targetModels('claude', path)).toThrow(/unknown provider/);
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

  it('inherits class capabilities into a fallback unless the fallback defines its own', () => {
    const table = syntheticTable(`
providers: { codex: {} }
task_classes:
  synthetic:
    provider: codex
    model: m1
    capabilities: [browse]
    fallback: { provider: codex, model: m2 }
`);
    expect(resolveRoute(table, 'synthetic').fallback?.capabilities).toEqual(['browse']);
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

  it('defers rejecting bare skills, mcp, and capabilities values until resolveRoute validates each target', () => {
    const skillsYaml = `
providers: { codex: {} }
task_classes: { synthetic: { provider: codex, model: m1, skills: quality-gate } }
`;
    const mcpYaml = `
providers: { codex: {} }
task_classes: { synthetic: { provider: codex, model: m1, mcp: memtrace } }
`;
    const capabilitiesYaml = `
providers: { codex: {} }
task_classes: { synthetic: { provider: codex, model: m1, capabilities: browse } }
`;
    // loadRouting itself must accept these files — the assignments below fail the test if it throws.
    const skillsTable = syntheticTable(skillsYaml);
    const mcpTable = syntheticTable(mcpYaml);
    const capabilitiesTable = syntheticTable(capabilitiesYaml);
    expect(() => resolveRoute(skillsTable, 'synthetic')).toThrow(/skills must be a list of strings/);
    expect(() => resolveRoute(mcpTable, 'synthetic')).toThrow(/mcp must be a list of strings/);
    expect(() => resolveRoute(capabilitiesTable, 'synthetic')).toThrow(/capabilities must be a list of strings/);
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
