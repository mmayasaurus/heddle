import { OPERATOR } from './address.js';
import { DEFAULT_SESSION_STALE_MS, type CommsLog, type FleetPauseAck } from './log.js';

/**
 * Just enough of the dispatch ledger to count in-flight work. Structural on purpose: the comms
 * server holds the ledger as the narrow `LineageSource` it needs for tier lineage, and a heddle
 * install may not have a ledger at all, so quiescence asks for the one method it uses and treats
 * its absence as "cannot tell" rather than as "nothing is running".
 */
export interface InFlightSource {
  inFlight?: () => unknown[];
}

/**
 * Fleet quiescence for account rotation (HED-119).
 *
 * Rotating the fleet to another Claude account means relaunching every session, so the fleet has
 * to be genuinely idle first — a session relaunched mid-edit loses whatever it had not committed.
 * "Genuinely" is the operative word: this module MEASURES quiet instead of inferring it from
 * silence, because a silent agent and a busy agent look identical from outside.
 *
 * Three independent conditions, each able to block on its own:
 *  1. every live agent has ACKED the current pause request,
 *  2. every ack asserts its work is parked (committed / pushed / otherwise safe to relaunch),
 *  3. no dispatch is in flight in the ledger — a worker mid-run would be orphaned by a relaunch.
 *
 * Condition 2 is the agent's own word. The broker cannot inspect another session's worktree, and
 * pretending otherwise would be worse than asking: an agent that acks while sitting on uncommitted
 * edits is the exact failure this protocol exists to prevent, so a false `workParked` is surfaced
 * as a named blocker rather than silently averaged away.
 */
export interface PauseReadiness {
  /** Message id of the pause request in force, or null when the fleet was never asked to pause. */
  pauseId: number | null;
  requestedAt: string | null;
  reason: string | null;
  /** Live agent addresses owing an ack (the operator is excluded — the human does not ack). */
  live: string[];
  acked: FleetPauseAck[];
  /** Live agents with no ack against the current pause. */
  pending: string[];
  /** Live agents that acked but said their work is NOT parked. */
  notParked: string[];
  /** Live agents whose ack came from a session instance that has since been replaced. */
  restarted: string[];
  /** Live sessions that started after the pause and may never have been shown it. */
  joinedAfterPause: string[];
  inFlightDispatches: number;
  /** False when no in-flight source was available — `inFlightDispatches: 0` then proves nothing. */
  ledgerConsulted: boolean;
  ready: boolean;
  /** Human-readable reasons the fleet is not ready, in the order they should be chased. */
  blockers: string[];
}

export interface QuiesceOptions {
  /**
   * Sessions with an older heartbeat are treated as gone rather than as pending acks. CLAMPED to
   * at least the broker default: shrinking this window would let a caller declare live agents
   * "stale", empty `live`, and get `ready: true` out of a fleet that never acked. Widening is
   * always safe (more agents owe an ack), so only the narrowing direction is refused.
   */
  staleMs?: number;
}

/**
 * Compute whether the fleet is safe to relaunch. Pure over its inputs so a rotator can poll it,
 * and so the blocking cases are testable without live sessions.
 */
export function pauseReadiness(
  log: CommsLog,
  ledger: InFlightSource | null | undefined,
  opts: QuiesceOptions = {},
): PauseReadiness {
  const pause = log.latestFleetPause();
  const staleMs = Math.max(opts.staleMs ?? DEFAULT_SESSION_STALE_MS, DEFAULT_SESSION_STALE_MS);
  const sessions = log.liveSessions(staleMs).filter((s) => s.address !== OPERATOR);
  // One row per address (the sessions table upserts ON CONFLICT(address)), so this is already unique.
  const live = sessions.map((s) => s.address);

  // A missing ledger is not proof that nothing is running — heddle may not be installed here, or
  // the server may hold a lineage-only view. It counts as zero, and `ledgerConsulted` says whether
  // that zero means anything, so a rotator never reads "no dispatches" out of an absent ledger.
  const ledgerConsulted = typeof ledger?.inFlight === 'function';
  const inFlightDispatches = ledgerConsulted ? (ledger as { inFlight: () => unknown[] }).inFlight().length : 0;

  if (!pause) {
    return {
      pauseId: null, requestedAt: null, reason: null,
      live, acked: [], pending: live, notParked: [], restarted: [], joinedAfterPause: [],
      inFlightDispatches, ledgerConsulted, ready: false,
      blockers: ['no pause has been requested — call request_pause first'],
    };
  }

  const acked = log.fleetPauseAcks(pause.id);
  const sessionOf = new Map(sessions.map((s) => [s.address, s]));

  // An ack counts only when the session that gave it is STILL the session at that address. A
  // process replaced under the same address after acking never answered this pause, so inheriting
  // its predecessor's ack would relaunch a session that is mid-work.
  const currentAck = (a: FleetPauseAck): boolean => {
    const session = sessionOf.get(a.sender);
    if (!session) return false;                       // not live: judged under `live`, not here
    if (!a.sessionId || !session.sessionId) return true;  // pre-binding ack, or a session with no id
    return a.sessionId === session.sessionId;
  };
  const liveAcks = acked.filter(currentAck);
  const ackedBy = new Set(liveAcks.map((a) => a.sender));
  const pending = live.filter((a) => !ackedBy.has(a));
  const restarted = acked
    .filter((a) => sessionOf.has(a.sender) && !currentAck(a))
    .map((a) => a.sender);
  // Only LIVE agents can block on not-parked. A dead session's "not parked" is not a thing anyone
  // can clear, so honouring it would wedge every future rotation.
  const notParked = liveAcks.filter((a) => !a.workParked).map((a) => a.sender);
  // A session that started after the pause was posted may never have been shown it (the inbound
  // pump starts a first-time session at the current tail), so it is named rather than silently
  // counted as ignoring the operator.
  const joinedAfterPause = sessions
    .filter((s) => !ackedBy.has(s.address) && s.startedAt > pause.ts)
    .map((s) => s.address);

  // Each agent is chased under ONE reason. `pending`, `restarted` and `joinedAfterPause` overlap by
  // construction — a replaced process is un-acked AND restarted AND newer than the pause — and three
  // blocker lines naming the same agent read as three contradictory problems to whoever is clearing
  // them. The arrays keep their plain meanings for callers; only the human-facing lines are attributed.
  const claimed = new Set([...restarted, ...joinedAfterPause]);
  const stillPending = pending.filter((a) => !claimed.has(a));
  const blockers: string[] = [];
  if (stillPending.length) blockers.push(`${stillPending.length} live agent(s) have not acked: ${stillPending.join(', ')}`);
  if (restarted.length) blockers.push(`${restarted.length} agent(s) acked from a session that has since been replaced: ${restarted.join(', ')}`);
  if (notParked.length) blockers.push(`${notParked.length} agent(s) acked with work NOT parked: ${notParked.join(', ')}`);
  if (inFlightDispatches) blockers.push(`${inFlightDispatches} dispatch(es) still in flight`);
  // The documented contract is that a zero from an absent ledger proves nothing — so it must not
  // be able to produce `ready`, or the doc and the behaviour disagree in the dangerous direction.
  if (!ledgerConsulted) blockers.push('dispatch status could not be verified: no in-flight source available');
  const joinedOnly = joinedAfterPause.filter((a) => !restarted.includes(a));
  if (joinedOnly.length) blockers.push(`${joinedOnly.length} session(s) started after the pause and may not have seen it — re-issue request_pause: ${joinedOnly.join(', ')}`);

  const meta = (pause.meta ?? {}) as Record<string, unknown>;
  const fleetPause = meta.fleetPause as Record<string, unknown> | undefined;

  return {
    pauseId: pause.id,
    requestedAt: pause.ts,
    reason: typeof fleetPause?.reason === 'string' ? fleetPause.reason : null,
    live, acked, pending, notParked, restarted, joinedAfterPause,
    inFlightDispatches, ledgerConsulted,
    ready: blockers.length === 0,
    blockers,
  };
}
