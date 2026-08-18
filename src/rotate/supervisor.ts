import type { RotateAction } from './decide.js';
import type { PauseReadiness } from '../comms/quiesce.js';

/**
 * Interactive-session account rotator — the SUPERVISOR state machine (HED-117).
 *
 * A standalone process (never inside a session it relaunches). Each `tick` reads the world, decides
 * one transition, and returns what it did. The machine is deliberately RE-ENTRANT: it holds no
 * durable phase in memory. The phase is derived every tick from durable facts —
 *   1. is a fleet pause in force? (the comms log)
 *   2. what account is the fleet on? (the tap)
 * — so a supervisor that crashes mid-rotation and restarts resumes exactly where it left off. The
 * rotation TARGET survives a crash because `request_pause` stamps it into the pause's meta; on
 * restart the supervisor reads it back rather than re-deciding.
 *
 * The destructive step (killing the old sessions) is the supervisor's alone, and it happens ONLY
 * after `pauseReadiness.ready` — every live agent has acked with its work parked and no dispatch is
 * in flight. `fleet-relaunch.sh` is launch-only by design (R): launching is retry-safe, killing is
 * not, so the irreversible half lives with the machine that has the durable gate.
 */

/** The rotation plan, stamped into the pause meta at PAUSE so it survives a supervisor crash. */
export interface RotationIntent {
  /** The account the rotation is moving TO. */
  target: string;
  /** The account the fleet was on when the rotation began. */
  from: string;
  /**
   * The fleet addresses that must come back on `target` before the pause is lifted — captured at
   * pause time. Re-entrancy and VERIFY both key off this, NOT off a live count that changes as
   * sessions die and re-register during the rotation.
   */
  roster: string[];
}

export type RotatorStep =
  | { phase: 'idle'; reason: string }
  | { phase: 'watch'; reason: string }
  | { phase: 'paused'; reason: string }          // pause requested this tick
  | { phase: 'quiescing'; reason: string; blockers: string[] }
  | { phase: 'relaunching'; reason: string; target: string }
  | { phase: 'verifying'; reason: string; pending: string[] }
  | { phase: 'resumed'; reason: string }         // rotation complete, pause lifted
  | { phase: 'exhausted'; reason: string }       // needs-human: no account to rotate to
  | { phase: 'blocked'; reason: string; target?: string }; // needs-human: a relaunch/verify failure

/**
 * Everything the state machine touches, injected so the machine is testable without a live fleet,
 * a real broker, or actually killing anything. Production wires these to the comms broker (operator
 * identity, in-process), the tap reader, and R's `fleet-relaunch.sh` + the kill mechanism.
 */
export interface RotatorDeps {
  /** The rotation decision from the tap + registry (decide.ts). */
  decide(): RotateAction;
  /** Current pause readiness (quiesce.ts). `pauseId === null` ⇒ no pause in force. */
  readiness(): PauseReadiness;
  /** The rotation intent stamped into the in-force pause's meta, or null if none / not a rotation. */
  pauseIntent(): RotationIntent | null;
  /** Live agent addresses (fleet sessions), operator excluded. */
  liveAddresses(): string[];
  /**
   * Has the live session at `address` already been relaunched onto the target this rotation?
   *
   * The prod adapter derives this durably from process start time vs the pause time (a session
   * whose procStart post-dates the in-force pause is the post-rotation one), NOT from a per-session
   * account lookup — which the session registry does not carry. Crash-safe: it reads the same two
   * durable facts (the registry's procStart, the pause's timestamp) on every tick and after a restart.
   */
  isRelaunched(address: string): boolean;

  /** OPERATOR-tier broadcast that begins a rotation; stamps `intent` into the pause meta. */
  requestPause(reason: string, intent: RotationIntent): Promise<void>;
  /** OPERATOR-tier resume that lifts the in-force pause. */
  resumePause(reason: string): Promise<void>;
  /**
   * Terminate one old session AND remove its presence row, so it immediately leaves the live set.
   * Irreversible — only called after readiness.ready. Un-registering here (not waiting for the
   * heartbeat to go stale) is what makes a re-entrant tick act only on sessions STILL un-moved,
   * never re-killing one it already moved. Returns an outcome: a REFUSED kill (fleet-kill exit 2 —
   * ambiguous pid) must stop the rotation, because relaunching over a still-live old session would
   * put two processes on one conversation. "Already dead" (exit 3) is `ok` — idempotent.
   */
  killSession(address: string): Promise<{ ok: boolean; code: string }>;
  /** Launch one session on `account` (R's fleet-relaunch.sh). Returns its exit outcome. */
  relaunch(address: string, account: string): Promise<{ ok: boolean; code: string }>;
  /**
   * Record DURABLY that `address` has been relaunched this rotation — written AFTER a successful
   * relaunch. This is what makes the crash between kill and relaunch recoverable: a member with no
   * marker is (re)launched (kill is idempotent — fleet-kill exits 3 on an already-dead session),
   * while a marked member is only waited on to boot, never relaunched again.
   */
  markRelaunched(address: string): Promise<void>;
  /** Has `address` been marked relaunched for the pause in force? */
  wasRelaunched(address: string): boolean;
  /** Post a needs-human to the operator (rotation cannot proceed unattended). */
  needsHuman(message: string): Promise<void>;
}

/**
 * One step of the rotator. Returns the transition taken (for logging and tests).
 *
 * Operational FAILURES from the primitives — a refused kill, a failed relaunch — become a `blocked`
 * needs-human (a half-rotated fleet must surface to the human, not proceed). A dependency that
 * itself THROWS (a broker post refused, an exec error the adapter did not map) propagates to the
 * caller's loop, which logs it and reschedules the next tick — the supervisor is never left in an
 * unknown in-memory state because it holds none: the next tick re-derives everything.
 */
/**
 * Kill then relaunch each still-un-moved session onto the target, in order. Stops at the first
 * failure — a refused kill (the old session may still be live) or a failed relaunch (a half-rotated
 * fleet) — with a needs-human, never a blind march. Extracted from `tick` so each is one procedure.
 */
async function killRelaunchMark(deps: RotatorDeps, members: string[], intent: RotationIntent): Promise<RotatorStep> {
  for (const address of members) {
    const k = await deps.killSession(address);
    if (!k.ok) {
      // A refused kill means the old session may still be live — relaunching over it would put two
      // processes on one conversation. Stop before that, don't retry blindly. (An already-dead
      // session is exit-3/ok, so this fires only on a genuine identity refusal.)
      await deps.needsHuman(`Rotation to ${intent.target} could NOT kill ${address} (${k.code}) — the old session may still be live. Resolve manually, then resume_pause.`);
      return { phase: 'blocked', reason: `kill of ${address} refused: ${k.code}`, target: intent.target };
    }
    const r = await deps.relaunch(address, intent.target);
    if (!r.ok) {
      // A half-relaunched fleet is the dangerous state — stop and surface it, never retry blindly.
      await deps.needsHuman(`Rotation to ${intent.target} FAILED relaunching ${address} (${r.code}). Fleet is half-rotated — resolve manually, then resume_pause.`);
      return { phase: 'blocked', reason: `relaunch of ${address} failed: ${r.code}`, target: intent.target };
    }
    // Durable: a crash after this point will not re-launch address into a duplicate.
    await deps.markRelaunched(address);
  }
  return { phase: 'relaunching', reason: `killed + relaunched ${members.length} session(s) onto ${intent.target}`, target: intent.target };
}

export async function tick(deps: RotatorDeps): Promise<RotatorStep> {
  const readiness = deps.readiness();
  const inForce = readiness.pauseId !== null;

  // ── No pause in force: WATCH. Decide whether to begin a rotation. ────────────────────────────
  if (!inForce) {
    const decision = deps.decide();
    switch (decision.action) {
      case 'idle':
      case 'unknown':
        return { phase: 'idle', reason: decision.reason };
      case 'watch':
        return { phase: 'watch', reason: decision.reason };
      case 'exhausted':
        await deps.needsHuman(`Account rotation needed but no target: ${decision.reason}`);
        return { phase: 'exhausted', reason: decision.reason };
      case 'rotate': {
        // Capture the roster NOW — these are the sessions that must come back on the target.
        const intent: RotationIntent = { target: decision.target.id, from: decision.current, roster: deps.liveAddresses() };
        await deps.requestPause(decision.reason, intent);
        return { phase: 'paused', reason: decision.reason };
      }
    }
  }

  // ── A pause is in force. Recover the rotation plan from its meta (survives a crash). ─────────
  const intent = deps.pauseIntent();
  if (!intent) {
    // A pause with no rotation intent was raised by something else (a manual operator pause). The
    // rotator must not drive it — leave it to whoever raised it.
    return { phase: 'idle', reason: 'a non-rotation pause is in force — not the rotator\'s to resume' };
  }

  const live = deps.liveAddresses();
  // A roster member still needs (kill+)relaunch until it carries a DURABLE relaunch marker. This is
  // the source of truth, not the live set: a member killed-but-not-relaunched by a mid-rotation
  // crash has no marker, so it is re-handled; a member already relaunched has a marker, so it is
  // only waited on — never re-launched into a duplicate.
  const needsRelaunch = intent.roster.filter((a) => !deps.wasRelaunched(a));

  if (needsRelaunch.length > 0) {
    // Hold until the fleet is genuinely quiet, THEN do the irreversible half.
    if (!readiness.ready) {
      return { phase: 'quiescing', reason: 'waiting for the fleet to go quiet', blockers: readiness.blockers };
    }
    return killRelaunchMark(deps, needsRelaunch, intent);
  }

  // Every roster member is marked relaunched ⇒ the launches are issued. VERIFY each has actually
  // BOOTED (live again as its new session) before lifting the pause — a session that never came
  // back is a needs-human, not a silent drop.
  const pending = intent.roster.filter((a) => !(live.includes(a) && deps.isRelaunched(a)));
  if (pending.length > 0) {
    return { phase: 'verifying', reason: `waiting for ${pending.join(', ')} to boot on ${intent.target}`, pending };
  }
  await deps.resumePause(`rotation complete: fleet on ${intent.target}`);
  return { phase: 'resumed', reason: `resumed on ${intent.target}` };
}
