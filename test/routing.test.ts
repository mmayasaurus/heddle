import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadRouting, listTaskClasses, resolveRoute, directRoute } from '../src/routing.js';

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

  it.each(classes)('%s: never routes a never_via_cursor family through cursor', (c) => {
    // Derived from the table's own policy so this guard can't drift from the YAML it validates.
    // Cursor's catalog ids carry the family as a prefix (claude-…, gpt-…, gemini-…).
    const banned = (table.policy.never_via_cursor as string[]).map((family) => `${family}-`);
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

  it('a direct route carries the caller\'s skills/mcp and a self-describing task class', () => {
    const r = directRoute(table, 'codex', 'gpt-5.6-luna', ['worker-role'], ['memtrace']);
    expect(r.taskClass).toBe('direct:codex/gpt-5.6-luna');
    expect(r.skills).toEqual(['worker-role']);
    expect(r.mcp).toEqual(['memtrace']);
    expect(r.fallback).toBeUndefined();
  });
});
