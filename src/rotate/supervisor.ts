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
  /** Which account a live session is currently running on, or null if unknown. */
  accountOf(address: string): string | null;

  /** OPERATOR-tier broadcast that begins a rotation; stamps `intent` into the pause meta. */
  requestPause(reason: string, intent: RotationIntent): void;
  /** OPERATOR-tier resume that lifts the in-force pause. */
  resumePause(reason: string): void;
  /**
   * Terminate one old session AND remove its presence row, so it immediately leaves the live set.
   * Irreversible — only called after readiness.ready. Un-registering here (not waiting for the
   * heartbeat to go stale) is what makes a re-entrant tick act only on sessions STILL on the source
   * account, never re-killing one it already moved.
   */
  killSession(address: string): Promise<void>;
  /** Launch one session on `account` (R's fleet-relaunch.sh). Returns its exit outcome. */
  relaunch(address: string, account: string): Promise<{ ok: boolean; code: string }>;
  /** Post a needs-human to the operator (rotation cannot proceed unattended). */
  needsHuman(message: string): void;
}

/**
 * One step of the rotator. Returns the transition taken (for logging and tests). Never throws for
 * an operational failure — a relaunch/verify problem becomes a `blocked` needs-human, because a
 * half-rotated fleet must surface to the human, not crash the supervisor into an unknown state.
 */
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
        deps.needsHuman(`Account rotation needed but no target: ${decision.reason}`);
        return { phase: 'exhausted', reason: decision.reason };
      case 'rotate': {
        // Capture the roster NOW — these are the sessions that must come back on the target.
        const intent: RotationIntent = { target: decision.target.id, from: decision.current, roster: deps.liveAddresses() };
        deps.requestPause(decision.reason, intent);
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
  // Roster members STILL running on the source account. killSession unregisters, so a member we
  // already moved is not live here — a re-entrant tick relaunches only what is genuinely un-moved,
  // never re-killing progress made before a crash or in an earlier tick.
  const sourceRemaining = intent.roster.filter((a) => live.includes(a) && deps.accountOf(a) === intent.from);

  if (sourceRemaining.length > 0) {
    // Not yet (fully) relaunched. Hold until the fleet is genuinely quiet, THEN do the irreversible
    // half — kill + relaunch each remaining source session onto the target.
    if (!readiness.ready) {
      return { phase: 'quiescing', reason: 'waiting for the fleet to go quiet', blockers: readiness.blockers };
    }
    for (const address of sourceRemaining) {
      await deps.killSession(address);
      const r = await deps.relaunch(address, intent.target);
      if (!r.ok) {
        // A half-relaunched fleet is the dangerous state — stop and surface it, never retry blindly.
        deps.needsHuman(`Rotation to ${intent.target} FAILED relaunching ${address} (${r.code}). Fleet is half-rotated — resolve manually, then resume_pause.`);
        return { phase: 'blocked', reason: `relaunch of ${address} failed: ${r.code}`, target: intent.target };
      }
    }
    return { phase: 'relaunching', reason: `killed + relaunched ${sourceRemaining.length} session(s) onto ${intent.target}`, target: intent.target };
  }

  // No roster member left on the source account ⇒ the relaunch is done. VERIFY every roster member
  // is live again on the target before lifting the pause — a session that never came back is a
  // needs-human, not a silent drop.
  const pending = intent.roster.filter((a) => !(live.includes(a) && deps.accountOf(a) === intent.target));
  if (pending.length > 0) {
    return { phase: 'verifying', reason: `waiting for ${pending.join(', ')} to re-register on ${intent.target}`, pending };
  }
  deps.resumePause(`rotation complete: fleet on ${intent.target}`);
  return { phase: 'resumed', reason: `resumed on ${intent.target}` };
}
