import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadLanes } from '../src/lanes.js';
import { useTempResources } from './helpers.js';

describe('lanes.yaml — ratified routing lanes', () => {
  const { tempDir } = useTempResources('heddle-lanes-test-');

  it('loads the ratified lanes configuration exactly', () => {
    const lanes = loadLanes(join(process.cwd(), 'routing', 'lanes.yaml'));

    expect(lanes.tiers).toEqual({
      'T0-menial': ['cerebras', 'groq', 'openrouter-free'],
      'T1-workhorse': ['codex', 'cursor'],
      'T1Q-quality-reserve': ['cursor-api-kimi-k3', 'openrouter-credits'],
      'T2-judgment': ['claude-workers'],
      'T3-orchestrator': ['fable'],
      'T3-escalation': {
        via: 'escalate-judgment',
        opt_in: true,
        requires_failed_attempts: 2,
        fable_escalations_weekly: 3,
      },
    });
    expect(lanes.floors).toEqual({
      claude: { never_below_pct: 3, residency_cap_below_pct: 10, residency_max: 2 },
      cooling_minutes: 30,
      menial_verify_days: 7,
    });
    expect(lanes.caps.openrouter_credits_weekly_usd).toBe(10);
    expect(lanes.guards.never_via_cursor).toEqual(['claude', 'gpt', 'gemini']);
  });

  it('rejects malformed lanes configuration with the offending key', () => {
    const path = join(tempDir(), 'lanes.yaml');
    writeFileSync(path, `tiers:
  T0-menial: not-a-list
  T1-workhorse: [codex]
  T1Q-quality-reserve: [cursor-api-kimi-k3]
  T2-judgment: [claude-workers]
  T3-orchestrator: [fable]
  T3-escalation: {via: escalate-judgment, opt_in: true, requires_failed_attempts: 2, fable_escalations_weekly: 3}
floors:
  claude: {never_below_pct: 3, residency_cap_below_pct: 10, residency_max: 2}
  cooling_minutes: 30
  menial_verify_days: 7
caps: {openrouter_credits_weekly_usd: 10}
guards: {never_via_cursor: [claude]}
`);

    expect(() => loadLanes(path)).toThrow('tiers.T0-menial');
  });
});
