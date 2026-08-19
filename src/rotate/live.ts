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

/** Default VERIFY boot-timeout (HED-157), overridable via `LiveRotatorOptions.verifyTimeoutMs`. */
export const DEFAULT_VERIFY_TIMEOUT_MS = 300_000;

/** Default PRE-KILL quiesce timeout (HED-186), overridable via `LiveRotatorOptions.quiesceTimeoutMs`. */
export const DEFAULT_QUIESCE_TIMEOUT_MS = 1_200_000; // 20 min: quiesce waits on the DISPATCH LEDGER, and a deep-implementation (opus) worker can outlive 10 min — 20 accommodates a typical in-flight worker so a HEALTHY rotation isn't aborted. Wedge-breaker, not an SLA.

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
  /**
   * Test/targeted scope: if set, the rotator only rotates these fleet addresses — the roster it
   * captures, kills and relaunches is filtered to them. The PAUSE stays fleet-wide (pauseReadiness
   * reads the whole roster, so the quiesce protocol still waits for everyone), so this bounds the
   * KILL blast radius to a chosen subject without weakening the quiet gate. The supervised first
   * run uses it to rotate exactly one idle agent (HED-117).
   */
  only?: string[];
  thresholds?: RotateThresholds;
  /** VERIFY boot-timeout in ms (HED-157). Default `DEFAULT_VERIFY_TIMEOUT_MS` (5 minutes). */
  verifyTimeoutMs?: number;
  /** PRE-KILL quiesce timeout in ms (HED-186). Default `DEFAULT_QUIESCE_TIMEOUT_MS` (20 minutes). */
  quiesceTimeoutMs?: number;
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

  /**
   * The latest relaunch-marker timestamp for pause `pauseId`, across ALL roster members — or null if
   * none exist yet. `verifyTimeout` (HED-157) anchors its deadline here, NOT to the pause's own start:
   * quiesce (waiting for every live agent to ack + park) is unbounded, so a rotation that simply took
   * a while to go quiet must not look "overdue" the instant VERIFY begins. Same scan window as
   * `wasRelaunched` (sinceId:pauseId — see that dep for why a bare `{limit}` would miss markers once
   * the operator inbox grows), just not filtered to one address.
   */
  const latestRelaunchMarkerMs = (pauseId: number): number | null => {
    let latest: number | null = null;
    for (const m of o.log.transcript({ inbox: OPERATOR }, { sinceId: pauseId, limit: 500 })) {
      const rr = (m.meta as { rotationRelaunched?: { pauseId?: number } } | null)?.rotationRelaunched;
      if (rr?.pauseId !== pauseId) continue;
      const ms = Date.parse(m.ts);
      if (Number.isFinite(ms) && (latest === null || ms > latest)) latest = ms;
    }
    return latest;
  };

  return {
    decide: () => readAndDecide({ usageDir: o.usageDir, nowMs: now(), ...(o.accountsPath ? { accountsPath: o.accountsPath } : {}), ...(o.thresholds ? { thresholds: o.thresholds } : {}) }),

    readiness: () => pauseReadiness(o.log, o.inFlight),

    pauseIntent: (): RotationIntent | null => {
      const p = o.log.latestFleetPause();
      // A lifted pause is spent — its rotation intent is history, not a live plan (else --status
      // and a re-entrant tick would both act on a rotation that already completed).
      if (!p || o.log.fleetPauseResumedAt(p.id)) return null;
      const meta = (p.meta ?? {}) as { fleetPause?: { rotation?: unknown } };
      const rot = meta.fleetPause?.rotation as Partial<RotationIntent> | undefined;
      if (!rot || typeof rot.target !== 'string' || typeof rot.from !== 'string' || !Array.isArray(rot.roster)) return null;
      return { target: rot.target, from: rot.from, roster: rot.roster.map(String) };
    },

    liveAddresses: () => o.log.liveSessions().map((s) => s.address)
      .filter((a) => a !== OPERATOR && (!o.only || o.only.includes(a))),

    isRelaunched: (address: string): boolean => {
      // The live session at `address` started after the in-force pause ⇒ it is the post-rotation
      // one. `startedAt` is the registry's session-start epoch; the supervised live run validates
      // that it updates on a relaunch (fleet-relaunch spawns a new pid → a new registry entry).
      const pauseMs = pauseTimeMs();
      const entry = liveRegistryEntry(sessionsDir, address);
      return pauseMs !== null && entry !== null && entry.startedAt > pauseMs;
    },

    requestPause: async (reason, intent) => {
      const posted = await o.broker.post({
        from: OPERATOR, to: BROADCAST, kind: 'status',
        body: `FLEET PAUSE — account rotation: ${reason}. Park your work now (commit or push anything uncommitted), stop starting new dispatches, then call ack_pause with work_parked=true. Do not resume until the rotation completes.`,
        meta: { fleetPause: { reason, rotation: intent } },
      });
      // A refused post appended no pause row — the rotation did not begin. Throw so the tick surfaces
      // it (the bin's loop logs it) rather than reporting 'paused' for a pause that does not exist.
      if (posted.outcome === 'refused') throw new Error(`request_pause refused (${posted.code}) — rotation not started`);
    },

    resumePause: async (reason) => {
      const p = o.log.latestFleetPause();
      if (!p) return; // nothing in force to lift
      const posted = await o.broker.post({
        from: OPERATOR, to: BROADCAST, kind: 'status', replyTo: p.id,
        body: `FLEET RESUMED — ${reason}. Carry on.`,
        meta: { fleetResume: { pauseId: p.id } },
      });
      // A refused resume left the pause IN FORCE — surface it rather than reporting 'resumed'.
      if (posted.outcome === 'refused') throw new Error(`resume_pause refused (${posted.code}) — pause still in force`);
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
      // The target MUST be a known registry account. If the registry is unreadable/missing the row,
      // fail CLOSED — silently omitting --account would relaunch onto the DEFAULT login, i.e. the
      // wrong account, which is worse than not relaunching.
      const accounts = readClaudeAccounts(o.accountsPath);
      const target = accounts.find((a) => a.id === account);
      if (!target) return { ok: false, code: `target account "${account}" not in registry` };
      // Omit --account for the DEFAULT login (configDir null) — setting CLAUDE_CONFIG_DIR to the
      // default dir changes Claude's auth resolution (see the accounts.json _doc).
      const args = [address, ...(target.configDir ? ['--account', account] : [])];
      const code = runScript('fleet-relaunch.sh', args);
      return code === 0 ? { ok: true, code: 'launched' } : { ok: false, code: `fleet-relaunch exit ${code}` };
    },

    markRelaunched: async (address) => {
      const p = o.log.latestFleetPause();
      if (!p) return;
      await o.broker.post({ from: OPERATOR, to: OPERATOR, kind: 'status',
        body: `rotation ${p.id}: relaunched ${address} onto target`,
        meta: { rotationRelaunched: { pauseId: p.id, address } } });
    },

    wasRelaunched: (address) => {
      const p = o.log.latestFleetPause();
      if (!p) return false;
      // transcript() is oldest-first, so a bare {limit} scans the OLDEST messages and would miss this
      // pause's markers once the operator inbox grows past it (re-relaunching forever). The markers are
      // posted after the pause's own id, so scope to sinceId:p.id — correct and bounded (a rotation
      // posts one marker per fleet member).
      return o.log.transcript({ inbox: OPERATOR }, { sinceId: p.id, limit: 500 }).some((m) => {
        const rr = (m.meta as { rotationRelaunched?: { pauseId?: number; address?: string } } | null)?.rotationRelaunched;
        return rr?.pauseId === p.id && rr?.address === address;
      });
    },

    verifyTimeout: (): { timedOut: boolean; timeoutMs: number } => {
      const timeoutMs = o.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
      const p = o.log.latestFleetPause();
      if (!p) return { timedOut: false, timeoutMs };
      // Defensive fallback only: `tick` calls `verifyTimeout` exclusively once every roster member is
      // already marked relaunched, so a marker always exists on the real path. If one is somehow
      // missing, fall back to the pause time rather than treating "no data" as "never times out".
      const baseMs = latestRelaunchMarkerMs(p.id) ?? pauseTimeMs();
      if (baseMs === null) return { timedOut: false, timeoutMs };
      return { timedOut: now() - baseMs > timeoutMs, timeoutMs };
    },

    quiesceTimeout: (): { timedOut: boolean; timeoutMs: number } => {
      const timeoutMs = o.quiesceTimeoutMs ?? DEFAULT_QUIESCE_TIMEOUT_MS;
      // Anchor to the pause START: quiescing runs from the pause until the fleet goes quiet.
      // (verifyTimeout anchors to the relaunch marker instead, because quiesce — its predecessor — is unbounded.)
      const baseMs = pauseTimeMs();
      if (baseMs === null) return { timedOut: false, timeoutMs };
      return { timedOut: now() - baseMs > timeoutMs, timeoutMs };
    },

    needsHuman: async (message) => {
      // De-dupe: a persistent block (a kill that keeps refusing) re-enters this every tick, and one
      // rotation can have SEVERAL distinct needs-human live at once (a VERIFY timeout AND a late-joiner
      // warning, HED-157) that alternate tick-to-tick. Scope to the active pause and skip if this EXACT
      // body was already posted since it — `.some`, NOT just the last match: two alternating bodies each
      // look "new" against the other under a last-only check and would spam the operator, eventually
      // overflowing the sinceId:pause marker-scan window wasRelaunched relies on.
      const p = o.log.latestFleetPause();
      if (p) {
        const seen = o.log.transcript({ inbox: OPERATOR }, { sinceId: p.id, limit: 500 })
          .filter((m) => m.kind === 'needs-human' && m.from === OPERATOR);
        if (seen.some((m) => m.body === message)) return;
      }
      await o.broker.post({ from: OPERATOR, to: OPERATOR, kind: 'needs-human', body: message });
    },
  };
}
