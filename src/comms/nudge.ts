import { readdirSync, realpathSync, readFileSync, statSync } from 'node:fs';
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
 *    (see `isElectedNudger`), so its posts would otherwise be stamped `operator` — a
 *    machine wearing the human's authority, which is exactly the spoofing the tier system exists to
 *    prevent. Nudges request `agent-message` explicitly; the envelope layer honours a demotion
 *    unconditionally.
 */

/** Long enough that a session mid-turn is never mistaken for a stalled one. */
export const DEFAULT_IDLE_MS = 15 * 60_000;
/** One nudge per window per agent — a stuck agent gets prodded, not spammed. */
export const DEFAULT_COOLDOWN_MS = 15 * 60_000;
/** The nudge cycle can never run faster than this, however `HEDDLE_COMMS_NUDGE_MS` is set. */
export const MIN_NUDGE_MS = 60_000;

export interface NudgeOptions {
  idleMs?: number;
  cooldownMs?: number;
  /**
   * Claude transcript roots to search, newest-mtime wins across all of them. Injected in tests;
   * in production `transcriptRoots()` derives them from the account registry so a session on a
   * non-default Claude account is not seen as permanently idle.
   */
  roots?: string[];
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

/**
 * Parse `HEDDLE_COMMS_NUDGE_MS`, rejecting anything not a finite positive number.
 *
 * `Number(x) || fallback` is not enough: a negative string is truthy, Node then clamps the timer to
 * ~1ms AND a negative threshold makes every session instantly "idle" — a nudge storm from one typo.
 * A value below the floor is raised to it rather than honoured.
 */
export function parseNudgeMs(raw: string | undefined, fallback = DEFAULT_IDLE_MS): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(n, MIN_NUDGE_MS);
}

/**
 * The Claude `projects` roots to search for transcripts, deduplicated by real path.
 *
 * The default `~/.claude/projects` PLUS `<configDir>/projects` for every account in
 * `~/.heddle/accounts.json` — sessions launched on a rotated account (HED-68) write under their own
 * `CLAUDE_CONFIG_DIR`, and searching only the default root would report them permanently idle and
 * nudge them forever. Dedup by realpath so an account whose `projects` symlinks to the shared store
 * is not walked twice.
 */
export function transcriptRoots(opts: NudgeOptions = {}): string[] {
  if (opts.roots) return opts.roots;
  const candidates = [join(homedir(), '.claude', 'projects')];
  try {
    const reg = JSON.parse(readFileSync(join(homedir(), '.heddle', 'accounts.json'), 'utf8')) as {
      claude?: { configDir?: string | null }[];
    };
    for (const acct of reg.claude ?? []) {
      if (acct.configDir) candidates.push(join(acct.configDir, 'projects'));
    }
  } catch {
    // no registry (single-account install): the default root is the whole story
  }
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const c of candidates) {
    let real: string;
    try { real = realpathSync(c); } catch { continue; } // a configured-but-absent root is skipped
    if (!seen.has(real)) { seen.add(real); roots.push(real); }
  }
  return roots;
}

/** Every project directory under the given roots, listed ONCE — the per-cycle filesystem cost. */
export function listProjectDirs(roots: string[]): string[] {
  const dirs: string[] = [];
  for (const root of roots) {
    let entries: string[];
    try { entries = readdirSync(root); } catch { continue; }
    for (const e of entries) dirs.push(join(root, e));
  }
  return dirs;
}

/**
 * Newest mtime of `<projectDir>/<sessionId>.jsonl` across the pre-listed dirs, or null when absent.
 *
 * A missing transcript yields null and the caller treats the session as NOT idle — an unknown
 * activity time must never be read as "silent, go prod it". A stat that fails for any reason other
 * than absence (a permission problem, say) also yields null, which is the safe direction: uncertain
 * ⇒ not idle ⇒ no nudge.
 */
export function transcriptActivityAt(sessionId: string, projectDirs: string[]): number | null {
  let newest: number | null = null;
  for (const dir of projectDirs) {
    try {
      const ms = statSync(join(dir, `${sessionId}.jsonl`)).mtimeMs;
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
 * The operator is excluded: a human reading their screen is not a stalled agent. The project dirs
 * are listed once here and reused across every session, so a cycle's readdir cost is O(roots), not
 * O(roots × sessions).
 */
export function idleAgents(log: CommsLog, opts: NudgeOptions = {}): IdleAgent[] {
  const now = opts.now?.() ?? Date.now();
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
  const projectDirs = listProjectDirs(transcriptRoots(opts));
  const out: IdleAgent[] = [];
  for (const session of log.liveSessions()) {
    if (session.address === OPERATOR) continue;
    if (!session.sessionId) continue; // nothing to measure activity against
    const lastActivityAt = transcriptActivityAt(session.sessionId, projectDirs);
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
 * The STATIC gate: only an operator session with push on may host a nudger at all. An ordinary
 * agent nudging its peers would be noise; a pull-only session has no channel to inject into.
 */
export function shouldRunNudger(isOperator: boolean, pushEnabled: boolean): boolean {
  return isOperator && pushEnabled;
}

/**
 * The DYNAMIC check, run every cycle: should THIS operator process nudge?
 *
 * Two operator sessions can share a valid token and both pass `shouldRunNudger`, so exactly one
 * must be elected. The `sessions` row is keyed by address and only the owner's `heartbeatSession`
 * keeps it fresh, so:
 *  - a FRESH owner that is me → I nudge;
 *  - a fresh owner that is someone else → I stand down;
 *  - NO fresh owner (the elected session exited — clean unregister removes the row — or crashed and
 *    its row went stale) → any live operator may nudge, so the survivor takes over instead of
 *    nudging dying with the owner.
 *
 * The last case can briefly let two survivors both nudge, but the log-based cooldown is the
 * backstop: the first nudge's `lastNudgeAt` suppresses the second. `staleMs` mirrors the session
 * staleness the rest of the broker uses.
 */
export function isElectedNudger(log: CommsLog, instanceId: string, staleMs?: number): boolean {
  const owner = staleMs === undefined ? log.liveSession(OPERATOR) : log.liveSession(OPERATOR, staleMs);
  if (!owner) return true;                    // no fresh owner: don't let nudging die with it
  return owner.sessionId === instanceId;      // else only the fresh owner nudges
}

/** The nudge body. Deliberately tells the agent what to do next, not merely that it stopped. */
export function nudgeBody(idle: IdleAgent): string {
  const mins = Math.floor(idle.idleMs / 60_000);
  return `Idle ~${mins}m. Continue your queue: finish the ticket you hold, and if your queue is empty run \`LIN_TEAM=HED lin.sh list\`, claim the top unclaimed issue nearest your lane, and start it. This is an automated advisory nudge, not an instruction from the operator — if you are genuinely blocked, say so and on what.`;
}
