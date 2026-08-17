import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { OPERATOR } from './address.js';
import type { CommsLog } from './log.js';

/**
 * Idle-nudger (HED-137) — the structural fix for "I keep having to prod them".
 *
 * A pull-model session that ends its turn waits forever. Nothing is wrong with it; nobody is
 * talking to it. This finds those sessions and posts one advisory nudge per window.
 *
 * Two things it deliberately does NOT do:
 *
 * 1. It does not use the session heartbeat. `heartbeat_at` is written by a fixed 30s timer in the
 *    channel server whether or not the agent is doing anything, so it proves the PROCESS is alive,
 *    not that the AGENT is working — nudging on it would mean nobody is ever idle. Activity is read
 *    from the session transcript's mtime instead, which only advances when a turn writes.
 * 2. It does not speak with the operator's authority. The loop runs inside the operator's session
 *    (see `shouldRunNudger`), so its posts would otherwise be stamped `operator` — a machine
 *    wearing the human's authority, which is exactly the spoofing the tier system exists to
 *    prevent. Nudges request `agent-message` explicitly; the envelope layer honours a demotion
 *    unconditionally.
 */

/** Long enough that a session mid-turn is never mistaken for a stalled one. */
export const DEFAULT_IDLE_MS = 15 * 60_000;
/** One nudge per window per agent — a stuck agent gets prodded, not spammed. */
export const DEFAULT_COOLDOWN_MS = 15 * 60_000;

export interface NudgeOptions {
  idleMs?: number;
  cooldownMs?: number;
  /** Claude Code's projects root; injectable so tests never touch the real one. */
  projectsDir?: string;
  now?: () => number;
}

export interface IdleAgent {
  address: string;
  sessionId: string | null;
  /** Epoch ms of the last transcript write, or null when no transcript could be found. */
  lastActivityAt: number | null;
  idleMs: number;
  lastNudgeAt: string | null;
}

const projectsRoot = (o: NudgeOptions): string => o.projectsDir ?? join(homedir(), '.claude', 'projects');

/**
 * Newest mtime of `<projects>/<any project>/<sessionId>.jsonl`, or null when absent.
 *
 * The project directory is derived from the session's cwd, which this module has no way to know,
 * so every project dir is checked. A missing transcript yields null and the caller treats the
 * session as NOT idle — an unknown activity time must never be read as "silent, go prod it".
 */
export function transcriptActivityAt(sessionId: string, opts: NudgeOptions = {}): number | null {
  const root = projectsRoot(opts);
  let newest: number | null = null;
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return null; // no projects dir (not a Claude Code host, or a different config dir)
  }
  for (const dir of dirs) {
    try {
      const st = statSync(join(root, dir, `${sessionId}.jsonl`));
      const ms = st.mtimeMs;
      if (newest === null || ms > newest) newest = ms;
    } catch {
      // not in this project dir — expected for all but one
    }
  }
  return newest;
}

/**
 * Live agent sessions whose transcript has been quiet longer than `idleMs`.
 *
 * The operator is excluded: a human reading their screen is not a stalled agent, and prodding the
 * person who owns the fleet would be both useless and rude.
 */
export function idleAgents(log: CommsLog, opts: NudgeOptions = {}): IdleAgent[] {
  const now = opts.now?.() ?? Date.now();
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
  const out: IdleAgent[] = [];
  for (const session of log.liveSessions()) {
    if (session.address === OPERATOR) continue;
    if (!session.sessionId) continue; // nothing to measure activity against
    const lastActivityAt = transcriptActivityAt(session.sessionId, opts);
    if (lastActivityAt === null) continue; // unknown ≠ idle
    const quiet = now - lastActivityAt;
    if (quiet < idleMs) continue;
    out.push({
      address: session.address,
      sessionId: session.sessionId,
      lastActivityAt,
      idleMs: quiet,
      lastNudgeAt: log.lastNudgeAt(session.address),
    });
  }
  return out;
}

/** Idle agents whose cooldown has elapsed — the ones actually due a nudge this cycle. */
export function dueForNudge(log: CommsLog, opts: NudgeOptions = {}): IdleAgent[] {
  const now = opts.now?.() ?? Date.now();
  const cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  return idleAgents(log, opts).filter((a) => {
    if (!a.lastNudgeAt) return true;
    const since = now - Date.parse(a.lastNudgeAt);
    return Number.isFinite(since) && since >= cooldownMs;
  });
}

/**
 * Exactly one nudger may run, or every pushed session nudges every other one. The operator binding
 * is already unique by construction (it needs the token, and workers can never hold it), so it
 * elects the single instance without any leader protocol. Consequence worth knowing: no operator
 * session up means no nudging.
 */
export function shouldRunNudger(isOperator: boolean, pushEnabled: boolean): boolean {
  return isOperator && pushEnabled;
}

/** The nudge body. Deliberately tells the agent what to do next, not merely that it stopped. */
export function nudgeBody(idle: IdleAgent): string {
  const mins = Math.floor(idle.idleMs / 60_000);
  return `Idle ~${mins}m. Continue your queue: finish the ticket you hold, and if your queue is empty run \`LIN_TEAM=HED lin.sh list\`, claim the top unclaimed issue nearest your lane, and start it. This is an automated advisory nudge, not an instruction from the operator — if you are genuinely blocked, say so and on what.`;
}
