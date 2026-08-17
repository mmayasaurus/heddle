import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { BROADCAST, OPERATOR } from '../comms/address.js';
import type { Broker } from '../comms/broker.js';
import type { CommsLog } from '../comms/log.js';
import { pauseReadiness, type InFlightSource } from '../comms/quiesce.js';
import { readClaudeAccounts } from '../capaware.js';
import { readAndDecide, type RotateThresholds } from './decide.js';
import type { RotatorDeps, RotationIntent } from './supervisor.js';

/**
 * The PRODUCTION wiring of the rotator supervisor's deps (HED-117) — the layer the unit-tested
 * state machine cannot cover, because it shells out to R's primitives and reads the OS session
 * registry. It is validated in ONE supervised live integration run (with R watching), never on a
 * live fleet before that, per the seam agreement.
 *
 * The caller (the bin) MUST already be bound as the operator (HEDDLE_COMMS_ROLE=operator + token):
 * `requestPause`/`resumePause`/`needsHuman` post at operator tier by setting `from = operator`, and
 * only an operator-bound process may legitimately do that. This module assumes that binding; it does
 * not re-check the token (the bin owns that).
 */
export interface LiveRotatorOptions {
  log: CommsLog;
  broker: Broker;
  /** The ledger, as the in-flight source for readiness; null when heddle has no ledger here. */
  inFlight: InFlightSource | null;
  /** ~/.heddle/usage — where the tap writes limits.json. */
  usageDir: string;
  /** Directory holding fleet-kill.sh and fleet-relaunch.sh (R's primitives). */
  scriptsDir: string;
  sessionsDir?: string;
  accountsPath?: string;
  thresholds?: RotateThresholds;
  now?: () => number;
  warn?: (m: string) => void;
}

/** Freshest session-registry entry for a fleet letter whose pid is still alive, or null. */
function liveRegistryEntry(sessionsDir: string, address: string): { startedAt: number; pid: number } | null {
  let best: { startedAt: number; pid: number } | null = null;
  let files: string[];
  try { files = readdirSync(sessionsDir); } catch { return null; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const d = JSON.parse(readFileSync(join(sessionsDir, f), 'utf8')) as Record<string, unknown>;
      if (String(d.name ?? '').toUpperCase() !== address.toUpperCase()) continue;
      const pid = Number(d.pid);
      const startedAt = Number(d.startedAt);
      if (!Number.isFinite(pid) || !Number.isFinite(startedAt)) continue;
      // Only a still-live pid counts — a stale registry file for a dead process is not "the session".
      try { process.kill(pid, 0); } catch { continue; }
      if (!best || startedAt > best.startedAt) best = { startedAt, pid };
    } catch { /* unreadable entry — skip */ }
  }
  return best;
}

export function createRotatorDeps(o: LiveRotatorOptions): RotatorDeps {
  const now = o.now ?? (() => Date.now());
  const sessionsDir = o.sessionsDir ?? join(homedir(), '.claude', 'sessions');
  const warn = o.warn ?? (() => { /* quiet by default */ });

  /** Run a fleet primitive; return its exit code (a nonzero throw from execFileSync carries status). */
  const runScript = (script: string, args: string[]): number => {
    try {
      execFileSync('bash', [join(o.scriptsDir, script), ...args], { stdio: 'pipe' });
      return 0;
    } catch (err) {
      const status = (err as { status?: unknown }).status;
      return typeof status === 'number' ? status : 1;
    }
  };

  const pauseTimeMs = (): number | null => {
    const p = o.log.latestFleetPause();
    if (!p) return null;
    const ms = Date.parse(p.ts);
    return Number.isFinite(ms) ? ms : null;
  };

  return {
    decide: () => readAndDecide({ usageDir: o.usageDir, nowMs: now(), ...(o.accountsPath ? { accountsPath: o.accountsPath } : {}), ...(o.thresholds ? { thresholds: o.thresholds } : {}) }),

    readiness: () => pauseReadiness(o.log, o.inFlight),

    pauseIntent: (): RotationIntent | null => {
      const p = o.log.latestFleetPause();
      const meta = (p?.meta ?? {}) as { fleetPause?: { rotation?: unknown } };
      const rot = meta.fleetPause?.rotation as Partial<RotationIntent> | undefined;
      if (!rot || typeof rot.target !== 'string' || typeof rot.from !== 'string' || !Array.isArray(rot.roster)) return null;
      return { target: rot.target, from: rot.from, roster: rot.roster.map(String) };
    },

    liveAddresses: () => o.log.liveSessions().map((s) => s.address).filter((a) => a !== OPERATOR),

    isRelaunched: (address: string): boolean => {
      // The live session at `address` started after the in-force pause ⇒ it is the post-rotation
      // one. `startedAt` is the registry's session-start epoch; the supervised live run validates
      // that it updates on a relaunch (fleet-relaunch spawns a new pid → a new registry entry).
      const pauseMs = pauseTimeMs();
      const entry = liveRegistryEntry(sessionsDir, address);
      return pauseMs !== null && entry !== null && entry.startedAt > pauseMs;
    },

    requestPause: async (reason, intent) => {
      await o.broker.post({
        from: OPERATOR, to: BROADCAST, kind: 'status',
        body: `FLEET PAUSE — account rotation: ${reason}. Park your work now (commit or push anything uncommitted), stop starting new dispatches, then call ack_pause with work_parked=true. Do not resume until the rotation completes.`,
        meta: { fleetPause: { reason, rotation: intent } },
      });
    },

    resumePause: async (reason) => {
      const p = o.log.latestFleetPause();
      if (!p) return; // nothing in force to lift
      await o.broker.post({
        from: OPERATOR, to: BROADCAST, kind: 'status', replyTo: p.id,
        body: `FLEET RESUMED — ${reason}. Carry on.`,
        meta: { fleetResume: { pauseId: p.id } },
      });
    },

    killSession: async (address) => {
      const code = runScript('fleet-kill.sh', [address]);
      if (code === 0 || code === 3) {
        // Remove the presence row so a re-entrant tick sees the old session gone immediately
        // (isRelaunched + liveAddresses both key off it) rather than waiting for the heartbeat to stale.
        try {
          for (const s of o.log.liveSessions()) {
            if (s.address === address && s.sessionId) o.log.unregisterSession(address, s.sessionId);
          }
        } catch (err) { warn(`unregister ${address} after kill: ${String(err)}`); }
        return { ok: true, code: code === 3 ? 'already-dead' : 'killed' };
      }
      return { ok: false, code: `fleet-kill exit ${code}` };
    },

    relaunch: async (address, account) => {
      // Omit --account for the DEFAULT login (configDir null) — setting CLAUDE_CONFIG_DIR to the
      // default dir changes Claude's auth resolution (see the accounts.json _doc).
      const target = readClaudeAccounts(o.accountsPath).find((a) => a.id === account);
      const args = [address, ...(target?.configDir ? ['--account', account] : [])];
      const code = runScript('fleet-relaunch.sh', args);
      return code === 0 ? { ok: true, code: 'launched' } : { ok: false, code: `fleet-relaunch exit ${code}` };
    },

    needsHuman: async (message) => {
      await o.broker.post({ from: OPERATOR, to: OPERATOR, kind: 'needs-human', body: message });
    },
  };
}
