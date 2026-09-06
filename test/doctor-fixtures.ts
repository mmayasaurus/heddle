import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import { runDoctor, type DoctorDeps } from '../src/doctor.js';
import { useTempResources } from './helpers.js';

export const resources = useTempResources('heddle-doctor-');

export const CURSOR_CATALOG = `Available models

auto - Auto (default)
cursor-grok-4.6-high-fast - Cursor Grok 4.6 Fast
composer-2.5 - Composer 2.5
gpt-5.6-sol-high - GPT-5.6 Sol 1M High
`;

export const AGY_CATALOG = `Fetching available models...
gemini-3.7-flash-high\tGemini 3.7 Flash (High)
gemini-3.1-pro-high\tGemini 3.1 Pro (High)
claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)
`;

export const ROUTING_YAML = `version: 1
providers:
  claude: {status: active}
  codex: {status: active}
  cursor: {status: active}
  gemini: {status: active}
task_classes:
  cursor-work:
    provider: __CURSOR_PROVIDER__
    model: __CURSOR_MODEL____CURSOR_FALLBACK__
  claude-work:
    provider: claude
    model: sonnet
  codex-work:
    provider: codex
    model: gpt-good
  gemini-work:
    provider: gemini
    model: __GEMINI_MODEL__
__LANE_DEFAULTS__
`;

export const LANES_YAML = `tiers:
  T0-menial: [gemini]
  T1-workhorse: [codex]
  T1Q-quality-reserve: [cursor]
  T2-judgment: [claude]
  T3-orchestrator: [claude]
  T3-escalation: {via: claude, opt_in: true, requires_failed_attempts: 1, fable_escalations_weekly: 1}
floors:
  claude: {never_below_pct: 10, residency_cap_below_pct: 20, residency_max: 2}
  cooling_minutes: 5
  menial_verify_days: 14
caps: {openrouter_credits_weekly_usd: 1}
guards: {never_via_cursor: []}
`;

export function config(
  models = { cursor: 'cursor-grok-4.6-high-fast', gemini: 'gemini-3.7-flash-high' },
  options: { cursorFallback?: string; laneDefaults?: string } = {},
): DoctorDeps['paths'] & { routing: string; lanes: string; projects: string; accounts: string } {
  const dir = resources.tempDir();
  const paths = {
    routing: join(dir, 'routing.yaml'), lanes: join(dir, 'lanes.yaml'),
    projects: join(dir, 'projects.json'), accounts: join(dir, 'accounts.json'),
    // Point comms + the operator token at this temp dir (both nonexistent unless a test provisions
    // them) so no runDoctor() opens the operator's real ~/.heddle/comms.db (which CommsLog would
    // WAL/migrate) or reads the real operator token — HED-463 review (high) + cursor bugbot.
    comms: join(dir, 'comms.db'), operatorToken: join(dir, 'operator.token'),
  };
  const cursorFallback = options.cursorFallback
    ? `\n    fallback:\n      provider: cursor\n      model: ${options.cursorFallback}`
    : '';
  const routing = ROUTING_YAML
    .replace('__CURSOR_PROVIDER__', options.cursorFallback ? 'claude' : 'cursor')
    .replace('__CURSOR_MODEL__', options.cursorFallback ? 'sonnet' : models.cursor)
    .replace('__CURSOR_FALLBACK__', cursorFallback)
    .replace('__GEMINI_MODEL__', models.gemini)
    .replace('__LANE_DEFAULTS__', options.laneDefaults ? `lane_defaults:\n${options.laneDefaults}` : '');
  writeFileSync(paths.routing, routing);
  writeFileSync(paths.lanes, LANES_YAML);
  return paths;
}

export function fakeDeps(
  paths = config(),
  overrides: Partial<DoctorDeps> = {},
): Partial<DoctorDeps> {
  return {
    paths,
    now: () => new Date('2026-09-10T12:00:00Z'),
    env: {},
    execFile: async (cmd, args) => {
      const key = `${cmd} ${args.join(' ')}`;
      if (args[0] === '--version') {
        return { stdout: `${cmd} 1.0.0\n`, stderr: '', exitCode: 0, timedOut: false };
      }
      if (key === 'claude auth status --json') {
        return { stdout: JSON.stringify({ loggedIn: true }), stderr: '', exitCode: 0, timedOut: false };
      }
      if (key === 'codex login status') {
        return {
          stdout: '', stderr: 'Logged in using ChatGPT\n', exitCode: 0, timedOut: false,
        }; // real format: status on STDERR
      }
      if (key === 'cursor-agent status --format json') {
        return { stdout: JSON.stringify({ loggedIn: true }), stderr: '', exitCode: 0, timedOut: false };
      }
      if (key === 'cursor-agent models') {
        return { stdout: CURSOR_CATALOG, stderr: '', exitCode: 0, timedOut: false };
      }
      if (key === 'agy models') {
        return { stdout: AGY_CATALOG, stderr: '', exitCode: 0, timedOut: false };
      }
      throw new Error(`unexpected probe: ${key}`);
    },
    ...overrides,
  };
}

export function check(report: Awaited<ReturnType<typeof runDoctor>>, id: string) {
  const result = report.checks.find((entry) => entry.id === id);
  expect(result, `expected ${id}`).toBeDefined();
  return result!;
}
