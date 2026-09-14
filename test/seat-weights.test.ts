import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSeatWeights, seatWeightsFrom, writeSeatWeightsMirror } from '../src/seat-weights.js';
import type { LanesConfig } from '../src/lanes.js';
import { useTempResources } from './helpers.js';

const { tempDir } = useTempResources('heddle-seat-weights-test-');

const lanes = (seat_weights?: LanesConfig['seat_weights']): LanesConfig => ({
  tiers: { 'T0-menial': [], 'T1-workhorse': [], 'T1Q-quality-reserve': [], 'T2-judgment': [], 'T3-orchestrator': [], 'T3-escalation': { via: 'x', opt_in: false, requires_failed_attempts: 0, fable_escalations_weekly: 0 } },
  floors: { claude: { never_below_pct: 3, residency_cap_below_pct: 10, residency_max: 2 }, cooling_minutes: 30, menial_verify_days: 7 },
  caps: { openrouter_credits_weekly_usd: 0 }, guards: { never_via_cursor: [] }, seat_weights,
});

describe('seat weights mirror', () => {
  it('resolves configured per-agent weights and defaults unknown agents', () => {
    const weights = seatWeightsFrom(lanes({ default: 1, by_agent: { R: 2.5, Y: 2 } }));
    expect(weights.default).toBe(1);
    expect(weights.byAgent).toEqual(new Map([['R', 2.5], ['Y', 2]]));
    expect(seatWeightsFrom(lanes())).toEqual({ default: 1, byAgent: new Map() });
  });

  it('writes atomically and reads a by-agent hit and default miss', () => {
    const homeDir = tempDir();
    writeSeatWeightsMirror(seatWeightsFrom(lanes({ default: 1, by_agent: { R: 2.5 } })), { homeDir, nowS: () => 1234 });
    const path = join(homeDir, '.heddle', 'seat-weights.json');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      generatedFrom: 'routing/lanes.yaml', writtenAt: 1234, default: 1, byAgent: { R: 2.5 },
    });
    expect(existsSync(`${path}.${process.pid}.tmp`)).toBe(false);
    const weights = readSeatWeights({ homeDir });
    expect(weights.weightOf('R')).toBe(2.5);
    expect(weights.weightOf('S')).toBe(1);
  });

  it('fails open to unit weights and warns when the mirror is missing', () => {
    const warnings: string[] = [];
    const weights = readSeatWeights({ homeDir: tempDir(), stderr: { write: (message: string) => { warnings.push(message); return true; } } });
    expect(weights.weightOf('R')).toBe(1);
    expect(weights.weightOf('anything')).toBe(1);
    expect(warnings.join('')).toMatch(/warning: .*seat weights mirror/i);
  });
});
