import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { LanesConfig } from './lanes.js';

export interface SeatWeights {
  default: number;
  byAgent: Map<string, number>;
}

export interface SeatWeightsDeps {
  homeDir?: string;
  nowS?: () => number;
  stderr?: Pick<NodeJS.WriteStream, 'write'>;
}

function validateWeight(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`lanes config: ${where} must be a finite number >= 0`);
  }
  return value;
}

/** Read only resolved policy values from lanes.yaml; no model or orchestrator inference belongs here. */
export function seatWeightsFrom(lanes: LanesConfig): SeatWeights {
  const configured = lanes.seat_weights;
  const defaultWeight = configured?.default === undefined ? 1 : validateWeight(configured.default, 'seat_weights.default');
  const byAgent = new Map<string, number>();
  for (const [agent, weight] of Object.entries(configured?.by_agent ?? {})) {
    byAgent.set(agent, validateWeight(weight, `seat_weights.by_agent.${agent}`));
  }
  return { default: defaultWeight, byAgent };
}

function mirrorPath(homeDir = homedir()): string {
  return join(homeDir, '.heddle', 'seat-weights.json');
}

/** Atomically refresh the dumb launcher/keeper lookup mirror. Timestamps are epoch seconds. */
export function writeSeatWeightsMirror(weights: SeatWeights, deps: SeatWeightsDeps = {}): void {
  const path = mirrorPath(deps.homeDir);
  const writtenAt = deps.nowS ? deps.nowS() : Math.floor(Date.now() / 1000);
  const byAgent = Object.fromEntries(weights.byAgent);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ generatedFrom: 'routing/lanes.yaml', writtenAt, default: weights.default, byAgent }) + '\n', 'utf8');
  renameSync(temp, path);
}

function fallback(deps: SeatWeightsDeps, detail: string): { weightOf: (letter: string) => number } {
  try {
    (deps.stderr ?? process.stderr).write(`heddle: warning: cannot read seat weights mirror (${detail}); using unit seat weights\n`);
  } catch {
    // The lookup still must fail open even when the caller's stderr is unavailable.
  }
  return { weightOf: () => 1 };
}

/** Read the mirror as a dumb lookup. Any filesystem or data problem fails open to count-equivalent weights. */
export function readSeatWeights(deps: SeatWeightsDeps = {}): { weightOf: (letter: string) => number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(mirrorPath(deps.homeDir), 'utf8'));
  } catch {
    return fallback(deps, 'missing, unreadable, or invalid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback(deps, 'malformed JSON object');
  const record = parsed as Record<string, unknown>;
  if (typeof record.default !== 'number' || !Number.isFinite(record.default) || record.default < 0 ||
      !record.byAgent || typeof record.byAgent !== 'object' || Array.isArray(record.byAgent)) {
    return fallback(deps, 'malformed weights');
  }
  const byAgent = record.byAgent as Record<string, unknown>;
  if (Object.values(byAgent).some((weight) => typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0)) {
    return fallback(deps, 'malformed per-agent weight');
  }
  const defaultWeight = record.default;
  return { weightOf: (letter) => (byAgent[letter] as number | undefined) ?? defaultWeight };
}
