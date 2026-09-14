import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRouting, listTaskClasses, resolveRoute, readTargetTier } from '../src/routing.js';
import { loadLanes } from '../src/lanes.js';
import { resolveTierTarget } from '../src/tier-resolve.js';
import type { Account } from '../src/accounts.js';

const table = loadRouting(new URL('../routing/routing.v0.yaml', import.meta.url).pathname);
const lanes = loadLanes(new URL('../routing/lanes.yaml', import.meta.url).pathname);

function account(provider: string, tier: Account['tier'] = 'T2'): Account {
  return {
    id: `${provider}-test`, provider: provider as Account['provider'], harness: `${provider}-cli`,
    credentialRef: `${provider}:test`, loggedIn: true, tier,
  };
}

const mayaLike = ['claude', 'codex', 'cursor', 'gemini', 'groq', 'cerebras', 'glm']
  .map((provider) => account(provider, provider === 'claude' ? 'T3' : 'T2'));
const proCodex = [account('claude', 'T2'), account('codex', 'T1')];
const resolve = (taskClass: string, accounts: Account[]) => resolveTierTarget(
  resolveRoute(table, taskClass), accounts, {}, { lanes, laneDefaults: table.laneDefaults ?? {} },
);

describe('tier-symbol routing', () => {
  it('keeps every shipped class on its static-table primary with full account coverage', () => {
    for (const taskClass of listTaskClasses(table)) {
      const staticRoute = resolveRoute(table, taskClass);
      const target = resolve(taskClass, mayaLike);
      expect(target).toMatchObject({ provider: staticRoute.provider, model: staticRoute.model });
    }
    expect(resolve('orchestration', mayaLike)).toMatchObject({ provider: 'claude', model: 'fable' });
    expect(resolve('deep-implementation', mayaLike)).toMatchObject({ provider: 'claude', model: 'opus' });
    expect(resolve('implementation', mayaLike)).toMatchObject({ provider: 'codex', model: 'gpt-5.6-terra' });
    expect(resolve('second-opinion', mayaLike)).toMatchObject({ provider: 'cursor', model: 'cursor-grok-4.6-high' });
    expect(resolve('second-opinion-hard', mayaLike)).toMatchObject({ provider: 'cursor', model: 'kimi-k3-high' });
    expect(resolve('escalate-judgment', mayaLike)).toMatchObject({ provider: 'claude', model: 'fable' });
    expect(resolve('bulk-mechanical', mayaLike)).toMatchObject({ provider: 'codex', model: 'gpt-5.6-luna' });
    expect(resolve('scaffold', mayaLike)).toMatchObject({ provider: 'cursor', model: 'composer-2.5' });
    expect(resolve('research-summarize', mayaLike)).toMatchObject({ provider: 'claude', model: 'haiku' });
    expect(resolve('documentation', mayaLike)).toMatchObject({ provider: 'gemini', model: 'gemini-3.6-flash-low' });
    expect(resolve('quick-alt-take', mayaLike)).toMatchObject({ provider: 'cursor', model: 'cursor-grok-4.6-medium' });
    expect(resolve('adversarial-review', mayaLike)).toMatchObject({ provider: 'cursor', model: 'cursor-grok-4.6-high' });
    expect(resolve('gemini-analysis', mayaLike)).toMatchObject({ provider: 'gemini', model: 'gemini-3.1-pro-high' });
    expect(resolve('web-research', mayaLike)).toMatchObject({ provider: 'gemini', model: 'gemini-3.1-pro-high' });
  });

  it('uses only logged-in Claude or Codex routes on a Claude-Pro plus Codex registry', () => {
    for (const taskClass of listTaskClasses(table)) {
      const target = resolve(taskClass, proCodex);
      expect(target.provider).toMatch(/^(claude|codex)$/);
      expect(`${target.provider}/${target.model}`).not.toBe('claude/fable');
    }
    expect(resolve('orchestration', proCodex)).toMatchObject({ provider: 'claude', model: 'opus', symbol: 'claude/opus' });
    expect(resolve('escalate-judgment', proCodex)).toMatchObject({ provider: 'claude', model: 'opus' });
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
