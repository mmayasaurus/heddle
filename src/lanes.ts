import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

export interface EscalationTier { via: string; opt_in: boolean; requires_failed_attempts: number; fable_escalations_weekly: number; }
export interface LanesConfig {
  tiers: {
    'T0-menial': string[];
    'T1-workhorse': string[];
    'T1Q-quality-reserve': string[];
    'T2-judgment': string[];
    'T3-orchestrator': string[];
    'T3-escalation': EscalationTier;
  };
  floors: { claude: { never_below_pct: number; residency_cap_below_pct: number; residency_max: number }; cooling_minutes: number; menial_verify_days: number };
  caps: { openrouter_credits_weekly_usd: number };
  guards: { never_via_cursor: string[] };
}

const here = dirname(fileURLToPath(import.meta.url));

/** Repo-relative default; overridable via HEDDLE_LANES for experiments. */
export function defaultLanesPath(): string {
  const envPath = process.env.HEDDLE_LANES;
  if (envPath) return envPath;
  // dist/ -> repo root -> routing/
  return join(here, '..', 'routing', 'lanes.yaml');
}

function objectField(value: unknown, key: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`lanes config: ${key} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredObject(node: Record<string, unknown>, key: string, where = key): Record<string, unknown> {
  if (!(key in node)) throw new Error(`lanes config: ${where} is required`);
  return objectField(node[key], where);
}

function stringList(node: Record<string, unknown>, key: string, where = key): string[] {
  const value = node[key];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.length > 0)) {
    throw new Error(`lanes config: ${where} must be an array of non-empty strings`);
  }
  return value;
}

function stringArray(node: Record<string, unknown>, key: string, where = key): string[] {
  const value = node[key];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`lanes config: ${where} must be an array of strings`);
  }
  return value;
}

function stringField(node: Record<string, unknown>, key: string, where = key): string {
  if (typeof node[key] !== 'string') throw new Error(`lanes config: ${where} must be a string`);
  return node[key];
}

function booleanField(node: Record<string, unknown>, key: string, where = key): boolean {
  if (typeof node[key] !== 'boolean') throw new Error(`lanes config: ${where} must be a boolean`);
  return node[key];
}

function finiteNumber(node: Record<string, unknown>, key: string, where = key): number {
  const value = node[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`lanes config: ${where} must be a finite number`);
  }
  return value;
}

export function loadLanes(path = defaultLanesPath()): LanesConfig {
  if (!existsSync(path)) throw new Error(`lanes config not found: ${path}`);

  const raw = objectField(parseYaml(readFileSync(path, 'utf8')), 'root');
  const tiers = requiredObject(raw, 'tiers');
  const escalation = requiredObject(tiers, 'T3-escalation', 'tiers.T3-escalation');
  const floors = requiredObject(raw, 'floors');
  const claude = requiredObject(floors, 'claude', 'floors.claude');
  const caps = requiredObject(raw, 'caps');
  const guards = requiredObject(raw, 'guards');

  return {
    tiers: {
      'T0-menial': stringList(tiers, 'T0-menial', 'tiers.T0-menial'),
      'T1-workhorse': stringList(tiers, 'T1-workhorse', 'tiers.T1-workhorse'),
      'T1Q-quality-reserve': stringList(tiers, 'T1Q-quality-reserve', 'tiers.T1Q-quality-reserve'),
      'T2-judgment': stringList(tiers, 'T2-judgment', 'tiers.T2-judgment'),
      'T3-orchestrator': stringList(tiers, 'T3-orchestrator', 'tiers.T3-orchestrator'),
      'T3-escalation': {
        via: stringField(escalation, 'via', 'tiers.T3-escalation.via'),
        opt_in: booleanField(escalation, 'opt_in', 'tiers.T3-escalation.opt_in'),
        requires_failed_attempts: finiteNumber(escalation, 'requires_failed_attempts', 'tiers.T3-escalation.requires_failed_attempts'),
        fable_escalations_weekly: finiteNumber(escalation, 'fable_escalations_weekly', 'tiers.T3-escalation.fable_escalations_weekly'),
      },
    },
    floors: {
      claude: {
        never_below_pct: finiteNumber(claude, 'never_below_pct', 'floors.claude.never_below_pct'),
        residency_cap_below_pct: finiteNumber(claude, 'residency_cap_below_pct', 'floors.claude.residency_cap_below_pct'),
        residency_max: finiteNumber(claude, 'residency_max', 'floors.claude.residency_max'),
      },
      cooling_minutes: finiteNumber(floors, 'cooling_minutes', 'floors.cooling_minutes'),
      menial_verify_days: finiteNumber(floors, 'menial_verify_days', 'floors.menial_verify_days'),
    },
    caps: { openrouter_credits_weekly_usd: finiteNumber(caps, 'openrouter_credits_weekly_usd', 'caps.openrouter_credits_weekly_usd') },
    guards: { never_via_cursor: stringArray(guards, 'never_via_cursor', 'guards.never_via_cursor') },
  };
}
