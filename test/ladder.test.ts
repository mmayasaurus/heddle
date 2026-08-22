import { describe, expect, it } from 'vitest';
import { buildLadder, lanesInTier, tierOfProvider } from '../src/ladder.js';
import type { LanesConfig } from '../src/lanes.js';
import type { RouteTarget, Tier } from '../src/routing.js';

// A synthetic lanes/lane_defaults pair mirroring the ratified shapes, so the ordering rules are
// pinned independently of the real routing/lanes.yaml values (which a retune may change).
const lanes: LanesConfig = {
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
// openrouter-free deliberately has NO default → it must never auto-join. cursor-api-kimi-k3 /
// openrouter-credits / fable live on non-auto-join tiers, so their absence is moot.
const laneDefaults: Record<string, RouteTarget> = {
  cerebras: { provider: 'cerebras', model: 'gpt-oss-120b' },
  groq: { provider: 'groq', model: 'openai/gpt-oss-120b' },
  codex: { provider: 'codex', model: 'gpt-5.6-terra' },
  cursor: { provider: 'cursor', model: 'composer-2.5' },
  'claude-workers': { provider: 'claude', model: 'sonnet' },
};
const all = () => true;
const pv = (out: { target: RouteTarget; tier: Tier }[]) => out.map((c) => `${c.target.provider}/${c.target.model}`);

describe('tier ladder — tierOfProvider', () => {
  it('maps each provider to the cheapest auto-join tier that resolves to it, unlaned → null', () => {
    expect(tierOfProvider('cerebras', lanes, laneDefaults)).toBe('T0');
    expect(tierOfProvider('groq', lanes, laneDefaults)).toBe('T0');
    expect(tierOfProvider('codex', lanes, laneDefaults)).toBe('T1');
    expect(tierOfProvider('cursor', lanes, laneDefaults)).toBe('T1');
    expect(tierOfProvider('claude', lanes, laneDefaults)).toBe('T2');
    expect(tierOfProvider('gemini', lanes, laneDefaults)).toBeNull(); // unlaned
  });
  it('exposes a tier lane list', () => {
    expect(lanesInTier(lanes, 'T1')).toEqual(['codex', 'cursor']);
  });
});

describe('tier ladder — buildLadder ordering', () => {
  it('descends gradually from the dead route tier toward minTier (within-tier siblings first)', () => {
    // dead claude route (T2); the declared target/fallback providers are excluded by the caller.
    const excl = new Set(['claude', 'codex']);
    const out = buildLadder('T2', 'T0', 'T2', lanes, laneDefaults, (t) => !excl.has(t.provider));
    // T2 sibling claude-workers → claude (excluded); descend T1 → cursor (codex excluded); descend T0 → cerebras, groq.
    expect(pv(out)).toEqual(['cursor/composer-2.5', 'cerebras/gpt-oss-120b', 'groq/openai/gpt-oss-120b']);
  });

  it('honours minTier as a hard floor and ascends toward maxTier above the start', () => {
    // start T0 (dead cerebras excluded), bounds [T0,T2]: within-tier T0 siblings → ascend T1 → ascend T2.
    const out = buildLadder('T0', 'T0', 'T2', lanes, laneDefaults, (t) => t.provider !== 'cerebras');
    expect(pv(out)).toEqual(['groq/openai/gpt-oss-120b', 'codex/gpt-5.6-terra', 'cursor/composer-2.5', 'claude/sonnet']);
  });

  it('never emits a lane with no lane_defaults entry (openrouter-free), nor a non-auto-join tier lane', () => {
    const out = buildLadder('T0', 'T0', 'T0', lanes, laneDefaults, all);
    expect(pv(out)).toEqual(['cerebras/gpt-oss-120b', 'groq/openai/gpt-oss-120b']); // openrouter-free dropped
  });

  it('drops the read-only T0 lanes when the class edits code', () => {
    const out = buildLadder('T2', 'T0', 'T2', lanes, laneDefaults, (t, tier) => tier !== 'T0');
    expect(pv(out)).toEqual(['claude/sonnet', 'codex/gpt-5.6-terra', 'cursor/composer-2.5']); // no cerebras/groq
  });

  it('clamps the start tier out of range: a start below minTier yields no within-tier phase', () => {
    // start T0 but minTier T1 → T0 siblings skipped; only ascent T1..T2.
    const out = buildLadder('T0', 'T1', 'T2', lanes, laneDefaults, all);
    expect(pv(out)).toEqual(['codex/gpt-5.6-terra', 'cursor/composer-2.5', 'claude/sonnet']);
  });

  it('treats an unlaned (null) start as T1', () => {
    const out = buildLadder(null, 'T0', 'T2', lanes, laneDefaults, all);
    // start T1: siblings codex,cursor → descend T0 cerebras,groq → ascend T2 claude-workers.
    expect(pv(out)).toEqual(['codex/gpt-5.6-terra', 'cursor/composer-2.5', 'cerebras/gpt-oss-120b', 'groq/openai/gpt-oss-120b', 'claude/sonnet']);
  });

  it('excludes provider families the caller bans (author family) and dedupes', () => {
    const out = buildLadder('T1', 'T0', 'T2', lanes, laneDefaults, (t) => t.provider !== 'cursor');
    expect(pv(out).includes('cursor/composer-2.5')).toBe(false);
  });

  it('a start ABOVE maxTier enters the range from its ceiling, never emitting a tier above it', () => {
    // start T2, bounds [T0,T1]: no within-tier (out of range), descend from the T1 ceiling then T0.
    const out = buildLadder('T2', 'T0', 'T1', lanes, laneDefaults, all);
    expect(pv(out)).toEqual(['codex/gpt-5.6-terra', 'cursor/composer-2.5', 'cerebras/gpt-oss-120b', 'groq/openai/gpt-oss-120b']);
  });

  it('an inverted range (minTier above maxTier) yields no candidates', () => {
    expect(buildLadder('T2', 'T2', 'T0', lanes, laneDefaults, all)).toEqual([]);
  });
});
