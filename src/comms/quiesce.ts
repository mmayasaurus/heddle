import { OPERATOR } from './address.js';
import type { CommsLog, FleetPauseAck } from './log.js';

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
  /** Agents that acked but said their work is NOT parked. */
  notParked: string[];
  inFlightDispatches: number;
  /** False when no in-flight source was available — `inFlightDispatches: 0` then proves nothing. */
  ledgerConsulted: boolean;
  ready: boolean;
  /** Human-readable reasons the fleet is not ready, in the order they should be chased. */
  blockers: string[];
}

export interface QuiesceOptions {
  /** Sessions with an older heartbeat are treated as gone rather than as pending acks. */
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
  const live = log
    .liveSessions(...(opts.staleMs === undefined ? [] : [opts.staleMs]))
    .map((s) => s.address)
    .filter((a) => a !== OPERATOR);

  // A missing ledger is not proof that nothing is running — heddle may not be installed here, or
  // the server may hold a lineage-only view. It counts as zero, and `ledgerConsulted` says whether
  // that zero means anything, so a rotator never reads "no dispatches" out of an absent ledger.
  const ledgerConsulted = typeof ledger?.inFlight === 'function';
  const inFlightDispatches = ledgerConsulted ? (ledger as { inFlight: () => unknown[] }).inFlight().length : 0;

  if (!pause) {
    return {
      pauseId: null, requestedAt: null, reason: null,
      live, acked: [], pending: live, notParked: [],
      inFlightDispatches, ledgerConsulted, ready: false,
      blockers: ['no pause has been requested — call request_pause first'],
    };
  }

  const acked = log.fleetPauseAcks(pause.id);
  const ackedBy = new Set(acked.map((a) => a.sender));
  const pending = live.filter((a) => !ackedBy.has(a));
  const notParked = acked.filter((a) => !a.workParked).map((a) => a.sender);

  const blockers: string[] = [];
  if (pending.length) blockers.push(`${pending.length} live agent(s) have not acked: ${pending.join(', ')}`);
  if (notParked.length) blockers.push(`${notParked.length} agent(s) acked with work NOT parked: ${notParked.join(', ')}`);
  if (inFlightDispatches) blockers.push(`${inFlightDispatches} dispatch(es) still in flight`);

  const meta = (pause.meta ?? {}) as Record<string, unknown>;
  const fleetPause = meta.fleetPause as Record<string, unknown> | undefined;

  return {
    pauseId: pause.id,
    requestedAt: pause.ts,
    reason: typeof fleetPause?.reason === 'string' ? fleetPause.reason : null,
    live, acked, pending, notParked, inFlightDispatches, ledgerConsulted,
    ready: blockers.length === 0,
    blockers,
  };
}
