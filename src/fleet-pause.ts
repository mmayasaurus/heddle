import { statSync } from 'node:fs';
import { CommsLog, DEFAULT_COMMS_PATH } from './comms/log.js';

/**
 * Dispatch admission gate (HED-124): refuse NEW dispatches while an operator fleet pause is in force.
 *
 * The residual HED-119 left: quiescence MEASURES readiness for an account rotation, but nothing
 * stopped a fresh dispatch from starting in the window between "fleet reports ready" and the
 * relaunch — orphaning that worker. This closes it at the one place every dispatch passes through.
 *
 * The gate reads ONE bit — `CommsLog.fleetPauseInForce()` (latest operator pause with no matching
 * operator resume) — not the whole `pauseReadiness` struct, which also computes ack/quiescence
 * state a rotator needs but an admission gate does not. CommsLog has no read-only mode (its
 * constructor creates the schema idempotently and shares the file via WAL, so a concurrent open is
 * safe — CommsLog(path) opens it read-WRITE and runs the idempotent schema setup, so this is not a
 * read-only open despite only reading); the gate opens, reads, and closes.
 *
 * FAIL-OPEN by design (agreed with Agent V, who owns quiescence): a pause is an OPT-IN coordination
 * signal from a human who is present. If the comms DB is absent (heddle installed without the
 * broker) or unreadable, nobody can have paused this fleet, so refusing would brick every
 * comms-less install for a stop that cannot exist. The asymmetry is the argument: failing closed
 * breaks working installs permanently and silently, while failing open loses the pause property
 * only in the narrow window where someone paused AND the log broke at the same moment. An
 * UNREADABLE log logs the reason (a broken log must never look like a silent green light); an
 * ABSENT log is silent, because "no broker installed" is a normal steady state, not a fault.
 *
 * (This is the OPPOSITE direction from `pauseReadiness`, which BLOCKS when it cannot verify
 * in-flight dispatches — deliberately, because there the caller is about to relaunch the fleet and
 * an unverifiable answer must not read as "safe to relaunch". Different question, different default.)
 */

export interface FleetPauseStatus {
  paused: boolean;
  pauseId: number | null;
  reason: string | null;
  requestedAt: string | null;
}

const NOT_PAUSED: FleetPauseStatus = { paused: false, pauseId: null, reason: null, requestedAt: null };

/**
 * Is a fleet pause in force? Reads the comms log read-only and closes it. Never throws — any
 * failure resolves to NOT paused (fail-open) with the reason on stderr.
 *
 * `commsPath` and `logFactory` are injectable so tests never touch the operator's real comms.db.
 */
export function fleetPauseStatus(opts: {
  commsPath?: string;
  logFactory?: (path: string) => Pick<CommsLog, 'fleetPauseInForce' | 'close'>;
} = {}): FleetPauseStatus {
  const path = opts.commsPath ?? process.env.HEDDLE_COMMS_DB ?? DEFAULT_COMMS_PATH;
  // No comms DB → no broker here → nobody can have paused this fleet. An empty file counts as
  // absent too: the comms server treats a 0-byte HEDDLE_COMMS_DB as a fresh db to initialise (the
  // SCHEMA exec is idempotent), and a fresh db has no pause rows — so failing open is the same
  // answer, without the constructor cost (codex-connector).
  if (!opts.logFactory && path !== ':memory:') {
    let stat; try { stat = statSync(path); } catch { stat = null; }
    if (!stat || stat.size === 0) return NOT_PAUSED;
  }

  let log: Pick<CommsLog, 'fleetPauseInForce' | 'close'> | null = null;
  try {
    log = opts.logFactory ? opts.logFactory(path) : new CommsLog(path);
    const inForce = log.fleetPauseInForce();
    return inForce
      ? { paused: true, pauseId: inForce.pauseId, reason: inForce.reason, requestedAt: inForce.requestedAt }
      : NOT_PAUSED;
  } catch (err) {
    process.stderr.write(
      `heddle: comms log unreadable, cannot check for a fleet pause (${err instanceof Error ? err.message : String(err)}) ` +
      `— FAILING OPEN: this dispatch proceeds ungated. If a pause was in force it was NOT enforced here.\n`,
    );
    return NOT_PAUSED;
  } finally {
    try { log?.close(); } catch { /* already closed */ }
  }
}
