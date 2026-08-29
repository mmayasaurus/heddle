import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Operator mode (HED-336) — the single host-side signal for HOW the fleet should work for Maya right
 * now: `desktop` (today's behavior), `mobile` (she's on the pocket console — phone-sized messages,
 * decisions via structured option cards, prompt hygiene), or `away` (only urgent interrupts).
 *
 * This module is the S1a FOUNDATION only: the state file at `~/.heddle/operator-mode.json`, a robust
 * reader (every per-turn hook and agent reads this on the hot path), and a writer (the `heddle mode`
 * CLI, the pocket-console toggle, and the desktop app all write the SAME file). It ENFORCES nothing
 * on its own — the per-turn-hook carrier that turns the mode into fleet-wide directives is a separate
 * enforcement-chain change (S1b). An absent or broken file always reads as `desktop`, so shipping
 * this module alone changes no behavior.
 */

export type OperatorMode = 'desktop' | 'mobile' | 'away';
export const OPERATOR_MODES = ['desktop', 'mobile', 'away'] as const;
export const DEFAULT_OPERATOR_MODE: OperatorMode = 'desktop';

/** Same framework-layer convention as `~/.heddle/projects.json` / `accounts.json`. */
export const OPERATOR_MODE_PATH = join(homedir(), '.heddle', 'operator-mode.json');

export interface OperatorModeState {
  mode: OperatorMode;
  /** ISO-8601 UTC of the last flip; `null` when defaulted (no file written yet). */
  since: string | null;
  /** Optional operator note (e.g. "school run"); `null` when unset. */
  note: string | null;
}

export function isOperatorMode(value: unknown): value is OperatorMode {
  return typeof value === 'string' && (OPERATOR_MODES as readonly string[]).includes(value);
}

/**
 * Read the current operator mode. ANY failure — absent file, unreadable, malformed JSON, unknown
 * `mode` string — degrades to the `desktop` default rather than throwing: this runs on the per-turn
 * hook hot path for every agent, so a broken file must never break a turn, and must never silently
 * escalate the fleet into mobile/away. `since`/`note` are best-effort and independently defaulted.
 */
export function readOperatorMode(path: string = OPERATOR_MODE_PATH): OperatorModeState {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { mode: DEFAULT_OPERATOR_MODE, since: null, note: null };
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      mode: isOperatorMode(parsed.mode) ? parsed.mode : DEFAULT_OPERATOR_MODE,
      since: typeof parsed.since === 'string' ? parsed.since : null,
      note: typeof parsed.note === 'string' ? parsed.note : null,
    };
  } catch {
    return { mode: DEFAULT_OPERATOR_MODE, since: null, note: null };
  }
}

/**
 * Set the operator mode, stamping `since` with `now`. Written temp-then-rename so a reader mid-turn
 * never observes a half-written file, and so two writers (CLI + pocket console) cannot interleave
 * into corruption. `path` and `now` are injectable for tests.
 */
export function writeOperatorMode(
  mode: OperatorMode,
  note: string | null = null,
  path: string = OPERATOR_MODE_PATH,
  now: Date = new Date(),
): OperatorModeState {
  const state: OperatorModeState = { mode, since: now.toISOString(), note };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  // 0600: the presence state (mobile/away) and any note ("school run") are private — a multi-user
  // host with a 022 umask would otherwise create this 0644 and leak it to other local users, and a
  // rename over an existing 0600 file would loosen it (codex HED-336). The temp carries the mode, so
  // the renamed file inherits it.
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
  return state;
}
