#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CommsLog, DEFAULT_COMMS_PATH } from '../comms/log.js';
import { Broker } from '../comms/broker.js';
import { ChannelTransport, errorMessage } from '../comms/bridge.js';
import { resolveCommsIdentity, openLedgerIfPresent, OPERATOR_TOKEN_PATH, operatorTokenMatches } from '../comms/server.js';
import { createRotatorDeps, DEFAULT_VERIFY_TIMEOUT_MS, DEFAULT_QUIESCE_TIMEOUT_MS } from './live.js';
import { tick } from './supervisor.js';
import { DEFAULT_THRESHOLDS } from './decide.js';
import { acquireLock, releaseLock, LOCK_REQUIRED_MODES } from './lock.js';

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
 * HED-157: --once / --run also take a single-instance pidfile lock (~/.heddle/rotator.lock, see
 * lock.ts) before touching pause/kill/relaunch — a stray --run daemon and a manual --once must
 * never both drive the state machine at once. --status never takes it (read-only).
 *
 * Env: HEDDLE_FLEET_SCRIPTS (dir with fleet-kill.sh/fleet-relaunch.sh) · HEDDLE_USAGE_DIR
 * (default ~/.heddle/usage) · HEDDLE_ROTATE_SOFT_PCT / HEDDLE_ROTATE_HARD_PCT · HEDDLE_ROTATE_SOFT_PCT_7D /
 * HEDDLE_ROTATE_HARD_PCT_7D (weekly-cap thresholds, HED-190) · HEDDLE_ROTATE_INTERVAL_MS
 * (default 60000) · HEDDLE_ROTATE_VERIFY_TIMEOUT_MS (default 300000) ·
 * HEDDLE_ROTATE_QUIESCE_TIMEOUT_MS (default 1200000) · HEDDLE_COMMS_DB · HEDDLE_LEDGER_DB.
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
const soft7dPct = Number(env.HEDDLE_ROTATE_SOFT_PCT_7D);
const hard7dPct = Number(env.HEDDLE_ROTATE_HARD_PCT_7D);
// A cap percentage is 0–100 by definition (usage.ts `CapWindow.usedPercentage`), so a threshold
// ABOVE 100 can never be reached: it would start the rotator cleanly and silently disable the very
// protection it configures (qodo, HED-190 review). Out-of-range → the default, same as any other
// unusable value. Applied to the 5h pair too — the bound is a property of the percentage, not of
// which window it describes.
const pct = (v: number, dflt: number): number => (Number.isFinite(v) && v > 0 && v <= 100 ? v : dflt);
const thresholds = {
  softPct: pct(softPct, DEFAULT_THRESHOLDS.softPct),
  hardPct: pct(hardPct, DEFAULT_THRESHOLDS.hardPct),
  soft7dPct: pct(soft7dPct, DEFAULT_THRESHOLDS.soft7dPct),
  hard7dPct: pct(hard7dPct, DEFAULT_THRESHOLDS.hard7dPct),
};
if (thresholds.hardPct <= thresholds.softPct) {
  warn(`refusing to run: hard threshold (${thresholds.hardPct}%) must be ABOVE soft (${thresholds.softPct}%) — a value between them would never trigger a rotation.`);
  process.exit(1);
}
if (thresholds.hard7dPct <= thresholds.soft7dPct) {
  warn(`refusing to run: 7d hard threshold (${thresholds.hard7dPct}%) must be ABOVE 7d soft (${thresholds.soft7dPct}%) — a value between them would never trigger a rotation.`);
  process.exit(1);
}

// HED-157: how long VERIFY waits for a relaunched roster member to re-register before escalating.
const rawVerifyTimeout = Number(env.HEDDLE_ROTATE_VERIFY_TIMEOUT_MS);
const verifyTimeoutMs = Number.isFinite(rawVerifyTimeout) && rawVerifyTimeout > 0 ? rawVerifyTimeout : DEFAULT_VERIFY_TIMEOUT_MS;

// HED-186: how long the PRE-KILL quiesce waits for the fleet to go quiet before ABORTING (lift the pause + needs-human).
const rawQuiesceTimeout = Number(env.HEDDLE_ROTATE_QUIESCE_TIMEOUT_MS);
const quiesceTimeoutMs = Number.isFinite(rawQuiesceTimeout) && rawQuiesceTimeout > 0 ? rawQuiesceTimeout : DEFAULT_QUIESCE_TIMEOUT_MS;

const scriptsDir = env.HEDDLE_FLEET_SCRIPTS;
if ((mode === 'run' || mode === 'once') && !scriptsDir) {
  warn('refusing to run: set HEDDLE_FLEET_SCRIPTS to the directory holding fleet-kill.sh and fleet-relaunch.sh.');
  process.exit(1);
}

// Optional single-/multi-subject scope (HED-117): the supervised first run rotates ONE idle agent.
const only = (env.HEDDLE_ROTATE_ONLY ?? '').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
const deps = createRotatorDeps({
  log, broker, inFlight: ledger, thresholds, verifyTimeoutMs, quiesceTimeoutMs,
  usageDir: env.HEDDLE_USAGE_DIR || join(homedir(), '.heddle', 'usage'),
  scriptsDir: scriptsDir ?? '', // only reached for active modes, which required it above
  ...(only.length ? { only } : {}),
});

/** Single-instance advisory lock path (HED-157) — fixed, not env-overridable (see lock.ts). */
const LOCK_PATH = join(homedir(), '.heddle', 'rotator.lock');

const stamp = () => new Date().toISOString();

async function statusOnce(): Promise<void> {
  const decision = deps.decide();
  const readiness = deps.readiness();
  process.stdout.write(JSON.stringify({
    at: stamp(), identity, isOperator,
    scope: only.length ? only : 'whole fleet',
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

  // HED-157: --run/--once only, before any pause/kill. Two active-mode rotators (a stray --run
  // daemon plus a manual --once, say) both deciding to pause/kill the fleet at once is a race the
  // state machine was never built to survive — refuse a second instance outright rather than risk it.
  if (LOCK_REQUIRED_MODES.has(mode)) {
    const lock = acquireLock(LOCK_PATH, process.pid);
    if (!lock.ok) {
      warn(`refusing to run: another rotator (pid ${lock.heldBy}) is running — refusing a second instance.`);
      log.close();
      process.exit(1);
    }
  }

  if (mode === 'once') {
    try { await runOnce(); } finally { releaseLock(LOCK_PATH); }
    log.close();
    return;
  }

  // --run: one tick per interval, self-scheduling so a slow tick never overlaps the next.
  // A bad env value (negative is truthy) would clamp the timer to ~0 and spin — validate it.
  const rawInterval = Number(env.HEDDLE_ROTATE_INTERVAL_MS);
  const intervalMs = Number.isFinite(rawInterval) && rawInterval >= 1_000 ? rawInterval : 60_000;
  let stopping = false;
  const loop = async (): Promise<void> => {
    if (stopping) return;
    // A token rotation revokes the operator everywhere (like the comms server's per-call check) —
    // a daemon that keeps pausing/killing after its authority was revoked would be dangerous.
    if (!operatorTokenMatches(env)) { warn('operator token no longer matches (rotated?) — stopping.'); stopping = true; releaseLock(LOCK_PATH); try { log.close(); } catch { /* closing */ } process.exit(1); }
    try { await runOnce(); } catch (err) { warn(`tick failed: ${errorMessage(err)}`); }
    // NOT unref()'d: the timer is the daemon's only event-loop reference; unref would exit after the first tick.
    if (!stopping) setTimeout(() => void loop(), intervalMs);
  };
  const bye = () => { stopping = true; releaseLock(LOCK_PATH); try { log.close(); } catch { /* closing */ } process.exit(0); };
  process.on('SIGTERM', bye); process.on('SIGINT', bye);
  warn(`started (interval ${intervalMs}ms, soft ${thresholds.softPct}% / hard ${thresholds.hardPct}%, 7d soft ${thresholds.soft7dPct}% / hard ${thresholds.hard7dPct}%)`);
  void loop();
}

void main().catch((err) => { warn(`fatal: ${errorMessage(err)}`); process.exit(1); });
