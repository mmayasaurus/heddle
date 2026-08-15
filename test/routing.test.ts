import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadRouting, listTaskClasses, resolveRoute, directRoute } from '../src/routing.js';

/**
 * Behavioral checks on the SHIPPED routing table (routing/routing.v0.yaml) — the file Maya tunes by
 * hand. These catch the mistakes a YAML edit can introduce silently: a class pointing at a model
 * its provider doesn't list, a fallback into an excluded provider, or a Cursor route that would
 * spend a direct-subscription family through the middleman (policy `never_via_cursor`).
 */
const here = dirname(fileURLToPath(import.meta.url));
const TABLE_PATH = join(here, '..', 'routing', 'routing.v0.yaml');

/** Families the policy says must never route via Cursor, as the model-id prefixes Cursor uses. */
const DIRECT_SUB_PREFIXES = ['claude-', 'gpt-', 'gemini-'];

describe('routing.v0.yaml — shipped table invariants', () => {
  const table = loadRouting(TABLE_PATH);
  const classes = listTaskClasses(table);

  it('has task classes and every one resolves to a provider+model', () => {
    expect(classes.length).toBeGreaterThan(0);
    for (const c of classes) {
      const r = resolveRoute(table, c);
      expect(r.provider, `${c}.provider`).toBeTruthy();
      expect(r.model, `${c}.model`).toBeTruthy();
    }
  });

  it('every primary and fallback provider exists in the providers block and is not excluded', () => {
    for (const c of classes) {
      const r = resolveRoute(table, c);
      for (const t of [r, r.fallback].filter(Boolean) as { provider: string }[]) {
        const cfg = table.providers[t.provider];
        expect(cfg, `${c}: unknown provider "${t.provider}"`).toBeDefined();
        expect(cfg.status, `${c}: provider "${t.provider}" is excluded`).not.toBe('excluded');
      }
    }
  });

  it('every routed model is in its provider\'s declared model list (catalog snapshot)', () => {
    for (const c of classes) {
      const r = resolveRoute(table, c);
      for (const t of [r, r.fallback].filter(Boolean) as { provider: string; model: string }[]) {
        const models = table.providers[t.provider]?.models as string[] | undefined;
        expect(models, `${c}: provider "${t.provider}" declares no models`).toBeDefined();
        expect(models, `${c}: "${t.model}" not in ${t.provider}.models`).toContain(t.model);
      }
    }
  });

  it('never routes a direct-subscription family (claude/gpt/gemini) through cursor', () => {
    for (const c of classes) {
      const r = resolveRoute(table, c);
      for (const t of [r, r.fallback].filter(Boolean) as { provider: string; model: string }[]) {
        if (t.provider !== 'cursor') continue;
        for (const p of DIRECT_SUB_PREFIXES) {
          expect(t.model.startsWith(p), `${c}: cursor route "${t.model}" violates never_via_cursor`).toBe(false);
        }
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

  it('names the known classes when asked for an unknown one', () => {
    expect(() => resolveRoute(table, 'no-such-class')).toThrow(/unknown task class "no-such-class"[\s\S]*implementation/);
  });

  it('refuses a direct route to the excluded provider (ollama-cloud is the PR-reviewer pool)', () => {
    expect(() => directRoute(table, 'ollama-cloud', 'anything')).toThrow(/excluded/);
  });

  it('refuses a direct route to a provider the table does not know', () => {
    expect(() => directRoute(table, 'openrouter', 'x')).toThrow(/unknown provider "openrouter"/);
  });

  it('a direct route carries the caller\'s skills/mcp and a self-describing task class', () => {
    const r = directRoute(table, 'codex', 'gpt-5.6-luna', ['worker-role'], ['memtrace']);
    expect(r.taskClass).toBe('direct:codex/gpt-5.6-luna');
    expect(r.skills).toEqual(['worker-role']);
    expect(r.mcp).toEqual(['memtrace']);
    expect(r.fallback).toBeUndefined();
  });
});
