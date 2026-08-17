#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CommsLog, DEFAULT_COMMS_PATH } from '../comms/log.js';
import { Broker } from '../comms/broker.js';
import { ChannelTransport, errorMessage } from '../comms/bridge.js';
import { resolveCommsIdentity, openLedgerIfPresent, OPERATOR_TOKEN_PATH, operatorTokenMatches } from '../comms/server.js';
import { createRotatorDeps } from './live.js';
import { tick } from './supervisor.js';
import { DEFAULT_THRESHOLDS } from './decide.js';

/**
 * heddle-rotator bin — the standalone interactive-session account rotator (HED-117).
 *
 * It CANNOT live inside a session it relaunches, so it runs as its own long-lived process. All the
 * logic is in src/rotate/{decide,supervisor,live}.ts (unit-tested); this file binds identity, wires
 * the broker + tap + R's primitives, and runs the tick loop.
 *
 *   heddle-rotator --status     print the current decision + pause readiness, act on nothing (default)
 *   heddle-rotator --once       run exactly one tick, print the step, exit
 *   heddle-rotator --run        the daemon loop (one tick per interval) — this is what a launchd plist runs
 *
 * TRUST SURFACE: --once / --run hold the operator token and can pause + relaunch the whole fleet
 * unattended. The bin therefore REFUSES to do anything active unless bound as the operator
 * (HEDDLE_COMMS_ROLE=operator + HEDDLE_COMMS_OPERATOR_TOKEN). This is Maya's deliberate automation,
 * but the binding is enforced here, not assumed.
 *
 * Env: HEDDLE_FLEET_SCRIPTS (dir with fleet-kill.sh/fleet-relaunch.sh) · HEDDLE_USAGE_DIR
 * (default ~/.heddle/usage) · HEDDLE_ROTATE_SOFT_PCT / HEDDLE_ROTATE_HARD_PCT · HEDDLE_ROTATE_INTERVAL_MS
 * (default 60000) · HEDDLE_COMMS_DB · HEDDLE_LEDGER_DB.
 */

const warn = (m: string) => process.stderr.write(`heddle-rotator: ${m}\n`);
const env = process.env;
const mode = process.argv.includes('--run') ? 'run' : process.argv.includes('--once') ? 'once' : 'status';

const { identity, isOperator } = resolveCommsIdentity(env, process.cwd(), warn, OPERATOR_TOKEN_PATH);

// Active modes require the operator binding — a rotator that could pause/relaunch the fleet from any
// unprivileged process would be a fleet-wide denial of service.
if ((mode === 'run' || mode === 'once') && !(isOperator && operatorTokenMatches(env))) {
  warn('refusing to run: the rotator must be bound as the operator (HEDDLE_COMMS_ROLE=operator + HEDDLE_COMMS_OPERATOR_TOKEN == ~/.heddle/operator.token). It holds the token and can pause/relaunch the whole fleet.');
  process.exit(1);
}

const log = new CommsLog(env.HEDDLE_COMMS_DB || DEFAULT_COMMS_PATH);
const ledger = openLedgerIfPresent(env, warn);
const broker = new Broker({ log, ledger, transport: new ChannelTransport(log), onWarning: warn });

const softPct = Number(env.HEDDLE_ROTATE_SOFT_PCT);
const hardPct = Number(env.HEDDLE_ROTATE_HARD_PCT);
const thresholds = {
  softPct: Number.isFinite(softPct) && softPct > 0 ? softPct : DEFAULT_THRESHOLDS.softPct,
  hardPct: Number.isFinite(hardPct) && hardPct > 0 ? hardPct : DEFAULT_THRESHOLDS.hardPct,
};

const scriptsDir = env.HEDDLE_FLEET_SCRIPTS;
if ((mode === 'run' || mode === 'once') && !scriptsDir) {
  warn('refusing to run: set HEDDLE_FLEET_SCRIPTS to the directory holding fleet-kill.sh and fleet-relaunch.sh.');
  process.exit(1);
}

const deps = createRotatorDeps({
  log, broker, inFlight: ledger, thresholds,
  usageDir: env.HEDDLE_USAGE_DIR || join(homedir(), '.heddle', 'usage'),
  scriptsDir: scriptsDir ?? '', // only reached for active modes, which required it above
});

const stamp = () => new Date().toISOString();

async function statusOnce(): Promise<void> {
  const decision = deps.decide();
  const readiness = deps.readiness();
  process.stdout.write(JSON.stringify({
    at: stamp(), identity, isOperator,
    decision: { action: decision.action, reason: decision.reason },
    pause: { inForce: readiness.pauseId !== null, ready: readiness.ready, blockers: readiness.blockers },
    intent: deps.pauseIntent(),
  }, null, 2) + '\n');
}

async function runOnce(): Promise<void> {
  const step = await tick(deps);
  process.stdout.write(`${stamp()} rotator: ${step.phase} — ${step.reason}\n`);
}

async function main(): Promise<void> {
  if (mode === 'status') { await statusOnce(); log.close(); return; }
  if (mode === 'once') { await runOnce(); log.close(); return; }

  // --run: one tick per interval, self-scheduling so a slow tick never overlaps the next.
  const intervalMs = Number(env.HEDDLE_ROTATE_INTERVAL_MS) || 60_000;
  let stopping = false;
  const loop = async (): Promise<void> => {
    if (stopping) return;
    try { await runOnce(); } catch (err) { warn(`tick failed: ${errorMessage(err)}`); }
    if (!stopping) setTimeout(() => void loop(), intervalMs).unref();
  };
  const bye = () => { stopping = true; try { log.close(); } catch { /* closing */ } process.exit(0); };
  process.on('SIGTERM', bye); process.on('SIGINT', bye);
  warn(`started (interval ${intervalMs}ms, soft ${thresholds.softPct}% / hard ${thresholds.hardPct}%)`);
  void loop();
}

void main().catch((err) => { warn(`fatal: ${errorMessage(err)}`); process.exit(1); });
