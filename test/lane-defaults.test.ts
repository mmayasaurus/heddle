import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadRouting, resolveRoute } from '../src/routing.js';
import { useTempResources } from './helpers.js';

const realTable = loadRouting(join(process.cwd(), 'routing/routing.v0.yaml'));

describe('HED-106 lane_defaults + tier bounds — routing.v0.yaml', () => {
  const { tempDir } = useTempResources('heddle-lane-defaults-test-');

  it('parses lane_defaults into concrete routes', () => {
    expect(realTable.laneDefaults).toMatchObject({
      cerebras: { provider: 'cerebras', model: 'gpt-oss-120b' },
      codex: { provider: 'codex', model: 'gpt-5.6-terra' },
      cursor: { provider: 'cursor', model: 'cursor-grok-4.6-high' },
      'claude-workers': { provider: 'claude', model: 'sonnet' },
    });
    // openrouter-free is deliberately absent — no routable :free id yet.
    expect(realTable.laneDefaults?.['openrouter-free']).toBeUndefined();
  });

  it('CI invariant: every lane_defaults model is a real member of its provider models list', () => {
    for (const [lane, target] of Object.entries(realTable.laneDefaults ?? {})) {
      const models = (realTable.providers[target.provider] as { models?: unknown })?.models;
      expect(Array.isArray(models), `provider "${target.provider}" (lane ${lane}) has no models list`).toBe(true);
      expect(models as string[], `lane_defaults.${lane} → ${target.provider}/${target.model} is not a listed model`).toContain(target.model);
    }
  });

  it('never resolves a lane default to a metered/never-auto model (cursor→bench-proven grok not kimi, claude→sonnet not fable)', () => {
    expect(realTable.laneDefaults?.cursor?.model).toBe('cursor-grok-4.6-high'); // the bench-proven incumbent (R nod 2026-08-22); composer-2.5 pending bench
    expect(realTable.laneDefaults?.cursor?.model).not.toBe('kimi-k3-high');
    expect(realTable.laneDefaults?.['claude-workers']?.model).toBe('sonnet');
    expect(realTable.laneDefaults?.['claude-workers']?.model).not.toBe('fable');
  });

  it('reads class tier bounds (default absent; the three flagged edges set explicitly)', () => {
    expect(resolveRoute(realTable, 'research-summarize').minTier).toBe('T0');
    expect(resolveRoute(realTable, 'documentation').minTier).toBe('T0');
    expect(resolveRoute(realTable, 'escalate-judgment').minTier).toBe('T2');
    expect(resolveRoute(realTable, 'implementation').minTier).toBeUndefined(); // default rule applies
    expect(resolveRoute(realTable, 'implementation').maxTier).toBeUndefined();
  });

  it('throws loudly on a malformed lane_defaults entry (missing model)', () => {
    const p = join(tempDir(), 'bad-lanes.yaml');
    writeFileSync(p, 'version: 0\nproviders: {codex: {}}\nlane_defaults: {codex: {provider: codex}}\ntask_classes: {x: {provider: codex, model: m}}\n');
    expect(() => loadRouting(p)).toThrow(/lane_defaults\.codex needs non-empty string provider and model/);
  });

  it('throws loudly on an invalid min_tier (typo)', () => {
    const p = join(tempDir(), 'bad-tier.yaml');
    writeFileSync(p, 'version: 0\nproviders: {codex: {}}\ntask_classes: {x: {provider: codex, model: m, min_tier: T4}}\n');
    expect(() => loadRouting(p)).not.toThrow(); // loadRouting itself is lazy; the bound is read at resolveRoute
    const bad = loadRouting(p);
    expect(() => resolveRoute(bad, 'x')).toThrow(/min_tier must be one of T0, T1, T2/);
  });

  it('throws when min_tier is above max_tier (an empty expansion range)', () => {
    const p = join(tempDir(), 'inverted-tier.yaml');
    writeFileSync(p, 'version: 0\nproviders: {codex: {}}\ntask_classes: {x: {provider: codex, model: m, min_tier: T2, max_tier: T1}}\n');
    expect(() => resolveRoute(loadRouting(p), 'x')).toThrow(/min_tier T2 is above max_tier T1/);
  });

  it('throws when the DEFAULTED min_tier (T1) exceeds an explicit max_tier (grok review)', () => {
    const p = join(tempDir(), 'defaulted-max.yaml');
    writeFileSync(p, 'version: 0\nproviders: {codex: {}}\ntask_classes: {x: {provider: codex, model: m, max_tier: T0}}\n');
    expect(() => resolveRoute(loadRouting(p), 'x')).toThrow(/min_tier T1 \(default\) is above max_tier T0/);
  });

  it('accepts a table with no lane_defaults (nothing auto-joins the walk)', () => {
    const p = join(tempDir(), 'no-lanes.yaml');
    writeFileSync(p, 'version: 0\nproviders: {codex: {}}\ntask_classes: {x: {provider: codex, model: m}}\n');
    expect(loadRouting(p).laneDefaults).toEqual({});
  });
});
