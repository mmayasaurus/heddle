import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Transport as McpTransport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { CommsLog, DEFAULT_COMMS_PATH } from './log.js';
import { channelLoadedFromParentArgv } from './channel-loaded-probe.js';
import { Ledger, DEFAULT_LEDGER_PATH } from '../ledger.js';
import { Broker } from './broker.js';
import type { LineageSource } from './envelope.js';
import {
  ChannelTransport, InboundPump, CHANNEL_INSTRUCTIONS, SENDMESSAGE_LIMITS, sendMessageHint, confirmSent, mirrorSent, mirrorReceived, errorMessage,
} from './bridge.js';
import { parseAddress, BROADCAST, OPERATOR } from './address.js';
import { pauseReadiness, type InFlightSource } from './quiesce.js';
import { dueForNudge, nudgeBody, shouldRunNudger, isElectedNudger, parseNudgeMs, type NudgeOptions } from './nudge.js';
import { TIERS, MESSAGE_KINDS, type Tier, type MessageKind } from './types.js';
import type { TargetStateProvider } from './broker.js';

/**
 * heddle-comms — the comms broker as a Claude Code CHANNEL MCP server (HED-7 / HED-73), as a
 * constructible unit so it can be tested in-process (InMemoryTransport) and shipped as a bin
 * (src/comms/channel-server.ts wires stdio + signals).
 *
 * Identity is bound from trusted process configuration (never chosen by the model):
 *   operator   — only via the configuration-level credential: HEDDLE_COMMS_ROLE=operator AND
 *                HEDDLE_COMMS_OPERATOR_TOKEN equal to ~/.heddle/operator.token (created once with
 *                `heddle-comms --init-operator-token`, 0600; `--rotate` invalidates the old one).
 *                The path is a FIXED trust root (no env override). A model cannot edit its own MCP
 *                config and agent sessions never see that env, so "origin-verified" = "this session
 *                was configured as the operator's". Workers (HEDDLE_WORKER=1 / HEDDLE_COMMS_ADDRESS)
 *                can never bind operator even if they inherited the env. The token is re-checked on
 *                every privileged call AND in the push/heartbeat loop, so a rotation revokes a running
 *                session immediately (tools refused, presence unregistered, push stopped).
 *   agent/child — HEDDLE_AGENT → FLEET_AGENT → HEDDLE_COMMS_ADDRESS (a heddle-dispatched worker)
 *                → a `.fleet-agent` file walking up from cwd → a Claude PID bridge label at
 *                `<cacheDir>/pid-<ppid>.label` → unbound (tools that need a sender refuse).
 *                `cacheDir` defaults to `~/.claude/fleet-identity-cache` and can be overridden
 *                with HEDDLE_IDENTITY_CACHE_DIR for tests. The PID bridge accepts agent labels
 *                only — never operator or child. A session that begins unbound retries this full
 *                chain on sender-requiring tool calls until it binds, then pins that label for its
 *                lifetime. ANY identity bound LATE (the session started unbound, then resolved one
 *                from env/.fleet-agent/pid-bridge) is capped to agent-message — a late source may be
 *                model-influenced (a writable .fleet-agent), so no late bind carries a directive.
 *                A bridge file whose mtime predates the hosting process's start is ignored
 *                (recycled-pid guard; the writer hook refreshes it every turn, so live sessions stay
 *                fresh). A PID-bridge binding is capped to `agent-message` on every send; it is
 *                never trusted to emit a directive. `operator` is REFUSED from the agent sources.
 *                HEDDLE_WORKER=1 disables the PID bridge and forbids mint_child (depth 1).
 *
 * PUSH IS OPT-IN (HEDDLE_COMMS_PUSH=1): Claude Code gives a server no way to know whether it was
 * loaded as a channel and drops channel events silently when it was not, so presence (the
 * `sessions` row that makes senders get "queued-for-channel") and the inbound pump run only when
 * the launcher says the flag is on. Otherwise the session is pull-only and senders get
 * "no-live-session" (+ the SendMessage hint) — honest, never "delivered" into a void.
 * The guard now best-effort infers channel-load from the parent Claude argv and surfaces a fail-open
 * "suspect" warning only when the flag is clearly absent; pushEnabled still gates presence and pumping.
 */

export interface CommsServerOptions {
  env: NodeJS.ProcessEnv;
  cwd?: string;
  /** Injectable for tests; defaults open the real files (env HEDDLE_COMMS_DB / HEDDLE_LEDGER_DB). */
  log?: CommsLog;
  ledger?: LineageSource | null;
  warn?: (message: string) => void;
  /** Injectable for tests; by default probes the parent Claude argv for the channel-load flag. */
  channelLoadedProbe?: () => boolean | null;
  /** Epoch-ms clock passed to the Broker (rate limits, holds, floor leases); injectable for tests. */
  now?: () => number;
  /** Injectable target-state provider for the Broker (tests build real held→released flows). */
  targetState?: TargetStateProvider;
  /**
   * TEST-ONLY override of the operator token file. Deliberately NOT an env var: the trust root
   * must be a path only the operator controls, never one a process can point at its own file.
   */
  operatorTokenPath?: string;
}

export interface CommsServer {
  mcp: Server;
  broker: Broker;
  log: CommsLog;
  identity: string | null;
  isOperator: boolean;
  pushEnabled: boolean;
  /** Connect the MCP transport, register presence (push mode), start the loops. */
  start(transport: McpTransport): Promise<void>;
  /** Unregister presence, stop loops, close db handles. Idempotent. */
  stop(): Promise<void>;
}

export type BindingSource = 'env' | 'fleet-file' | 'pid-bridge';
type FleetBinding = { identity: string; source: BindingSource };

let parentStartMsCache: number | null | undefined;
/**
 * The hosting (parent) process's start time in epoch ms, via `ps -o etime=` — cached per process;
 * null = unverifiable. Used by the PID-bridge recycle guard: a label file OLDER than the hosting
 * claude process cannot have been written for it (macOS recycles pids across reboots; the cache dir
 * survives them), so it is ignored. Tests override via HEDDLE_PID_BRIDGE_PARENT_START_MS.
 */
function parentProcessStartMs(): number | null {
  if (parentStartMsCache !== undefined) return parentStartMsCache;
  try {
    const out = execFileSync('ps', ['-o', 'etime=', '-p', String(process.ppid)], { timeout: 1500 }).toString().trim();
    const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(out);
    if (!m) { parentStartMsCache = null; return null; }
    const elapsedMs = (((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3])) * 60 + Number(m[4])) * 1000;
    parentStartMsCache = Date.now() - elapsedMs;
  } catch { parentStartMsCache = null; }
  return parentStartMsCache;
}

const IDENTIFIER = /^[a-z0-9_]+$/;
const PUSH_SUSPECT_RELAUNCH_REMEDY = 'Relaunch with --dangerously-load-development-channels server:heddle-comms (and --dangerously-skip-permissions).';

/** The instruction every resume carries; an operator note is appended to it, never swapped for it. */
const RESUME_DIRECTIVE = 'FLEET RESUMED — the pause is lifted; carry on.';

/** The operator trust root. Fixed on purpose — no env var may move it (see CommsServerOptions.operatorTokenPath). */
export const OPERATOR_TOKEN_PATH = join(homedir(), '.heddle', 'operator.token');
const DEFAULT_IDENTITY_CACHE_DIR = join(homedir(), '.claude', 'fleet-identity-cache');

/**
 * Create (or, with rotate, replace) the operator token file (0600 — enforced with chmod even on an
 * existing or rewritten file). Returns what happened; the token value itself is only ever in the
 * file — never printed, never logged.
 */
export function initOperatorToken(opts: { rotate?: boolean; path?: string } = {}): { path: string; action: 'created' | 'rotated' | 'kept' } {
  const path = opts.path ?? OPERATOR_TOKEN_PATH;
  const existed = existsSync(path);
  if (existed && !opts.rotate) {
    chmodSync(path, 0o600); // a pre-existing file with loose bits is tightened, not trusted as-is
    return { path, action: 'kept' };
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, randomBytes(24).toString('hex') + '\n', { mode: 0o600 });
  chmodSync(path, 0o600); // { mode } applies on create only; a rotated file keeps its old bits otherwise
  return { path, action: existed ? 'rotated' : 'created' };
}

/** Does the presented credential match the operator token file right now? Constant-time; never logs the values. */
export function operatorTokenMatches(env: NodeJS.ProcessEnv, path: string = OPERATOR_TOKEN_PATH): boolean {
  const presented = (env.HEDDLE_COMMS_OPERATOR_TOKEN ?? '').trim();
  if (!presented || !existsSync(path)) return false;
  const expected = readFileSync(path, 'utf8').trim();
  const a = Buffer.from(presented), b = Buffer.from(expected);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

/**
 * The raw fleet agent/child identity from the env chain or a `.fleet-agent` file, IGNORING
 * HEDDLE_COMMS_ROLE — or null. Used both by resolveCommsIdentity's non-operator branch and by the
 * rotator's in-session guard (HED-187), which needs the fleet letter even when the operator binding
 * has masked it to 'operator'.
 */
function resolvePidBridgeIdentity(env: NodeJS.ProcessEnv, warn: (m: string) => void): FleetBinding | null {
  const ppid = process.ppid;
  if (!Number.isInteger(ppid) || ppid <= 1) {
    warn(`PID identity bridge unavailable: unexpected parent pid ${String(ppid)} — continuing unbound`);
    return null;
  }
  const cacheDir = env.HEDDLE_IDENTITY_CACHE_DIR?.trim() || DEFAULT_IDENTITY_CACHE_DIR;
  try {
    if (!statSync(cacheDir).isDirectory()) {
      warn(`PID identity bridge cache is not a directory: ${cacheDir} — continuing unbound`);
      return null;
    }
  } catch (err) {
    // An absent bridge is the expected pre-/rename state; other stat failures are diagnostic only.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      warn(`could not stat PID identity bridge cache ${cacheDir}: ${errorMessage(err)} — continuing unbound`);
    }
    return null;
  }
  const path = join(cacheDir, `pid-${ppid}.label`);
  try {
    const labelStat = lstatSync(path);
    if (!labelStat.isFile()) {
      warn(`PID identity bridge label at ${path} must be a regular file — continuing unbound`);
      return null;
    }
    if (labelStat.size > 256) {
      warn(`PID identity bridge label at ${path} exceeds 256 bytes — continuing unbound`);
      return null;
    }
    const startOverride = env.HEDDLE_PID_BRIDGE_PARENT_START_MS?.trim();
    const startMs = startOverride && /^\d+$/.test(startOverride) ? Number(startOverride) : parentProcessStartMs();
    if (startMs === null) {
      warn('PID identity bridge freshness unverifiable (ps failed) — continuing unbound');
      return null;
    }
    if (labelStat.mtimeMs < startMs - 5000) {
      warn(`PID identity bridge label at ${path} predates this session's host process — stale (recycled pid?); continuing unbound`);
      return null;
    }
    const label = readFileSync(path, 'utf8').trim();
    if (parseAddress(label)?.kind === 'agent') return { identity: label, source: 'pid-bridge' };
    warn(`PID identity bridge label at ${path} is not a fleet agent address — continuing unbound`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      warn(`could not read PID identity bridge label ${path}: ${errorMessage(err)} — continuing unbound`);
    }
  }
  return null;
}

export function resolveFleetIdentity(
  env: NodeJS.ProcessEnv, cwd: string, warn: (m: string) => void, pidBridgeWarn: (m: string) => void = warn,
  opts: { allowPidBridge?: boolean } = {},
): string | null {
  return resolveFleetBinding(env, cwd, warn, pidBridgeWarn, opts)?.identity ?? null;
}

function resolveFleetBinding(
  env: NodeJS.ProcessEnv, cwd: string, warn: (m: string) => void, pidBridgeWarn: (m: string) => void = warn,
  opts: { allowPidBridge?: boolean } = {},
): FleetBinding | null {
  // TODO(HED-65/HED-2): switch to Agent U's src/identity.ts once it lands (same order, one module).
  const bindable = (v: string | undefined): string | null => {
    const s = v?.trim();
    if (!s) return null;
    const kind = parseAddress(s)?.kind;
    if (kind === 'agent' || kind === 'child') return s;
    if (kind === 'operator') warn('refusing to bind the operator identity from an env var / .fleet-agent — use HEDDLE_COMMS_ROLE=operator + the token');
    return null;
  };
  const fromEnv = bindable(env.HEDDLE_AGENT) ?? bindable(env.FLEET_AGENT) ?? bindable(env.HEDDLE_COMMS_ADDRESS);
  if (fromEnv) return { identity: fromEnv, source: 'env' };
  let dir = cwd;
  for (;;) {
    const f = join(dir, '.fleet-agent');
    if (existsSync(f)) {
      try {
        const v = bindable(readFileSync(f, 'utf8'));
        if (v) return { identity: v, source: 'fleet-file' };
      } catch (err) {
        warn(`could not read ${f}: ${errorMessage(err)} — continuing unbound`);
      }
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return opts.allowPidBridge === true && env.HEDDLE_WORKER !== '1' ? resolvePidBridgeIdentity(env, pidBridgeWarn) : null;
}

/** Bind the comms identity from the environment (see the module doc). */
export function resolveCommsIdentity(
  env: NodeJS.ProcessEnv, cwd: string, warn: (m: string) => void, tokenPath: string = OPERATOR_TOKEN_PATH,
  pidBridgeWarn: (m: string) => void = warn,
): { identity: string | null; isOperator: boolean } {
  if (env.HEDDLE_COMMS_ROLE === 'operator') {
    // A worker, or anything a heddle dispatch stamped, is never the operator — even if it inherited
    // the operator session's environment (buildWorkerEnv strips billing vars, not comms vars).
    if (env.HEDDLE_WORKER === '1' || env.HEDDLE_COMMS_ADDRESS) {
      warn('HEDDLE_COMMS_ROLE=operator inside a worker process — refusing (workers are never the operator); binding as the worker instead');
    } else if (operatorTokenMatches(env, tokenPath)) {
      return { identity: 'operator', isOperator: true };
    } else {
      warn('HEDDLE_COMMS_ROLE=operator but the operator token is missing or does not match — refusing to bind operator (unbound)');
      return { identity: null, isOperator: false };
    }
  }
  const fleet = resolveFleetBinding(env, cwd, warn, pidBridgeWarn, { allowPidBridge: true });
  return { identity: fleet?.identity ?? null, isOperator: false };
}

function resolveCommsBinding(
  env: NodeJS.ProcessEnv, cwd: string, warn: (m: string) => void, tokenPath: string = OPERATOR_TOKEN_PATH,
  pidBridgeWarn: (m: string) => void = warn,
): { identity: string | null; isOperator: boolean; bindingSource: BindingSource | null } {
  if (env.HEDDLE_COMMS_ROLE === 'operator') {
    if (env.HEDDLE_WORKER === '1' || env.HEDDLE_COMMS_ADDRESS) {
      warn('HEDDLE_COMMS_ROLE=operator inside a worker process — refusing (workers are never the operator); binding as the worker instead');
    } else if (operatorTokenMatches(env, tokenPath)) {
      return { identity: 'operator', isOperator: true, bindingSource: 'env' };
    } else {
      warn('HEDDLE_COMMS_ROLE=operator but the operator token is missing or does not match — refusing to bind operator (unbound)');
      return { identity: null, isOperator: false, bindingSource: null };
    }
  }
  const fleet = resolveFleetBinding(env, cwd, warn, pidBridgeWarn, { allowPidBridge: true });
  return { identity: fleet?.identity ?? null, isOperator: false, bindingSource: fleet?.source ?? null };
}

/** The dispatch ledger is consulted opportunistically for lineage; never created as a side effect. */
export function openLedgerIfPresent(env: NodeJS.ProcessEnv, warn: (m: string) => void): Ledger | null {
  const path = env.HEDDLE_LEDGER_DB || DEFAULT_LEDGER_PATH;
  if (!existsSync(path)) return null;
  try { return new Ledger(path); } catch (err) { warn(`ledger unavailable: ${errorMessage(err)}`); return null; }
}

export function createCommsServer(opts: CommsServerOptions): CommsServer {
  const env = opts.env;
  const warn = opts.warn ?? ((m: string) => process.stderr.write(`heddle-comms: ${m}\n`));
  const cwd = opts.cwd ?? process.cwd();
  const log = opts.log ?? new CommsLog(env.HEDDLE_COMMS_DB || DEFAULT_COMMS_PATH);
  const ownsLedger = opts.ledger === undefined;
  const ledger = ownsLedger ? openLedgerIfPresent(env, warn) : opts.ledger;
  // The ledger is held as the narrow LineageSource the envelope layer needs; quiescence wants the
  // in-flight view, which only a real Ledger has. Resolve that once, by capability, so an injected
  // lineage-only stub reports "cannot tell" instead of a misleading zero.
  const inFlightSource: InFlightSource | null =
    ledger && typeof (ledger as { inFlight?: unknown }).inFlight === 'function' ? (ledger as InFlightSource) : null;
  const tokenPath = opts.operatorTokenPath ?? OPERATOR_TOKEN_PATH;
  let pidBridgeWarningShown = false;
  const warnPidBridgeOnce = (message: string) => {
    if (!pidBridgeWarningShown) { pidBridgeWarningShown = true; warn(message); }
  };
  let { identity: me, isOperator, bindingSource } = resolveCommsBinding(env, cwd, warn, tokenPath, warnPidBridgeOnce);
  const lazyIdentity = me === null && !isOperator;
  let identityChangeWarned = false;
  let postPinDivergenceChecked = false;
  // A LATE binding (the session started with no identity, then gained one via env/.fleet-agent/pid
  // bridge after the model could act — e.g. by writing .fleet-agent in its cwd) is never trusted to
  // carry a directive: cap EVERY lazily-bound source to agent-message, not just the pid bridge
  // (on-PR HIGH, #92). A session bound at construction (lazyIdentity=false) keeps full authority.
  const tierCap = (): 'agent-message' | null => (me !== null && (bindingSource === 'pid-bridge' || lazyIdentity)) ? 'agent-message' : null;
  const isWorker = env.HEDDLE_WORKER === '1';
  const pushEnabled = env.HEDDLE_COMMS_PUSH === '1';
  const channelLoadedProbe = opts.channelLoadedProbe ?? (() => {
    const cp = Number(env.CLAUDE_PID);
    return channelLoadedFromParentArgv(Number.isInteger(cp) && cp > 0 ? cp : process.ppid);
  });
  type PushDelivery = 'off' | 'ok' | 'suspect-channel-not-loaded';
  let channelLoaded: boolean | null;
  try {
    channelLoaded = channelLoadedProbe();
  } catch (err) {
    // Fail-open, but never SILENTLY: a probe failure is logged, not swallowed (HED-270 review).
    warn(`channel-loaded probe failed: ${errorMessage(err)}`);
    channelLoaded = null;
  }
  const pushDelivery: PushDelivery = !pushEnabled ? 'off' : (channelLoaded === false ? 'suspect-channel-not-loaded' : 'ok');
  const sessionName = env.HEDDLE_SESSION_NAME || me;
  const instanceId = env.CLAUDE_CODE_SESSION_ID || randomUUID(); // owns this process's presence row

  const mcp = new Server(
    { name: 'heddle-comms', version: '0.0.1' },
    {
      capabilities: { experimental: { 'claude/channel': {} }, tools: {} },
      instructions: CHANNEL_INSTRUCTIONS + (me
        ? ` You are ${me} (identity source: ${bindingSource}).`
        : ' (This session has NO bound comms identity. It can bind from env at startup or lazily after Claude rename from the PID bridge; check comms_whoami for the live identity and source.)'),
    },
  );
  const broker = new Broker({ log, ledger, transport: new ChannelTransport(log), onWarning: warn, ...(opts.now ? { now: opts.now } : {}), ...(opts.targetState ? { targetState: opts.targetState } : {}) });
  log.ensureDefaultRooms();
  if (me) {
    const restored = broker.restoreHeld({ sender: me });
    if (restored) warn(`restored ${restored} held message(s) posted by ${me}`);
  }


  /**
   * Ask the whole fleet to pause and park its work (HED-119). OPERATOR ONLY by design: a
   * halt-the-fleet signal any agent could raise would be a denial of service on the fleet, and the
   * only thing that proves "the human" is the token-verified operator binding.
   */
  async function requestFleetPause(reason: string | undefined): Promise<ReturnType<typeof text> | ReturnType<typeof errorText>> {
    const who = requireMe();
    if (!(isOperator && operatorStillValid())) {
      return errorText('refused: only the operator can request a fleet pause (bind HEDDLE_COMMS_ROLE=operator + the token)');
    }
    const why = reason ?? 'account rotation';
    const posted = await broker.post({
      from: who, to: BROADCAST, kind: 'status',
      tierCap: tierCap(),
      body: `FLEET PAUSE REQUESTED — ${why}. Park your work now: commit or push anything uncommitted, stop starting new dispatches, then call ack_pause with work_parked=true. Do not resume until the operator says so.`,
      // No timestamp in meta: the broker stamps ts on the row, and pause_status reads it back.
      meta: { fleetPause: { reason: why } },
    });
    return text({ ...posted, readiness: pauseReadiness(log, inFlightSource) });
  }

  /**
   * Lift the pause in force (HED-134). OPERATOR ONLY, for the same reason as requesting one: if an
   * agent could lift a pause, it could resume a fleet the human deliberately stopped.
   */
  async function resumeFleetPause(note: string | undefined): Promise<ReturnType<typeof text> | ReturnType<typeof errorText>> {
    const who = requireMe();
    if (!(isOperator && operatorStillValid())) {
      return errorText('refused: only the operator can lift a fleet pause (bind HEDDLE_COMMS_ROLE=operator + the token)');
    }
    const pause = log.latestFleetPause();
    if (!pause) return errorText('refused: no fleet pause has been requested');
    const already = log.fleetPauseResumedAt(pause.id);
    if (already) return errorText(`refused: that pause was already lifted at ${already}`);
    // The directive is the point of the broadcast — a note ADDS to it rather than replacing it, so
    // a resume never reaches the fleet as bare prose with no instruction to carry on.
    const body = note ? `${RESUME_DIRECTIVE} ${note}` : RESUME_DIRECTIVE;
    const posted = await broker.post({
      from: who, to: BROADCAST, kind: 'status', replyTo: pause.id, body,
      tierCap: tierCap(),
      meta: { fleetResume: { pauseId: pause.id } },
    });
    // A refused post appends no row, so the pause is still in force: say so instead of reporting a
    // lift that did not happen (an over-long note or an exhausted rate limit both land here).
    if (posted.outcome === 'refused') {
      return errorText(`refused: the resume broadcast was not accepted (${posted.code}) — the pause is STILL in force`);
    }
    return text({ ...posted, liftedPauseId: pause.id, readiness: pauseReadiness(log, inFlightSource) });
  }

  /** Answer the operator's pause. `workParked` is the agent's own assertion — see quiesce.ts. */
  async function ackFleetPause(workParkedArg: unknown, note: string | undefined): Promise<ReturnType<typeof text> | ReturnType<typeof errorText>> {
    const who = requireMe();
    const pause = log.latestFleetPause();
    if (!pause) return errorText('refused: no fleet pause has been requested');
    if (typeof workParkedArg !== 'boolean') {
      return errorText('refused: work_parked must be a boolean — say true only once your work is committed or parked');
    }
    const workParked = workParkedArg;
    // Bind the ack to THIS session instance: if the process is replaced under the same address
    // before rotation, readiness must not honour its predecessor's answer.
    const ackSessionId = log.session(who)?.sessionId ?? null;
    const posted = await broker.post({
      from: who, to: OPERATOR, kind: 'status', replyTo: pause.id,
      tierCap: tierCap(),
      body: note ?? (workParked ? 'paused; work parked' : 'paused; work NOT parked'),
      meta: { pauseAck: true, workParked, ackSessionId },
    });
    return text({ ...posted, pauseId: pause.id, workParked });
  }

  /** The bound identity, re-verified for the operator on every call so a token rotation bites immediately. */
  let revoked = false;
  const operatorStillValid = (): boolean => !isOperator || operatorTokenMatches(env, tokenPath);
  const refreshLazyIdentity = (): void => {
    if (!lazyIdentity) return;
    if (me && postPinDivergenceChecked) return;
    const resolved = resolveCommsBinding(env, cwd, warn, tokenPath, warnPidBridgeOnce);
    // A session that did not start as operator never gains operator authority through lazy binding.
    const candidate = resolved.isOperator ? null : resolved.identity;
    if (!me) {
      if (!candidate) return;
      me = candidate;
      bindingSource = resolved.bindingSource;
      try {
        // r3 (ledger 619): a construction-time restoreHeld({sender}) never ran for a session that
        // was unbound then — restore this sender's persisted holds at the moment it gains one.
        const restored = broker.restoreHeld({ sender: me });
        if (restored) warn(`restored ${restored} held message(s) posted by ${me}`);
      } catch (err) {
        warn(`restoreHeld after lazy bind failed: ${errorMessage(err)}`);
      }
      return;
    }
    postPinDivergenceChecked = true;
    // A vanished bridge file is not a divergence — only a DIFFERENT resolvable label warns.
    if (candidate && candidate !== me && !identityChangeWarned) {
      identityChangeWarned = true;
      warn(`comms identity changed after binding (${me} → ${candidate}) — keeping pinned identity ${me}`);
    }
  };
  const requireMe = (): string => {
    refreshLazyIdentity();
    if (!me) throw new Error('no bound comms identity: set HEDDLE_AGENT (or FLEET_AGENT / .fleet-agent), provide the Claude PID bridge label, or, for the operator, HEDDLE_COMMS_ROLE=operator + the token — before starting the session');
    if (!operatorStillValid()) { void revokeOperator(); throw new Error('operator token no longer matches (rotated?): restart the session with the current token'); }
    return me;
  };
  /** A rotation revokes the running session everywhere: presence gone, pumps stopped, tools refused. */
  async function revokeOperator(): Promise<void> {
    if (revoked) return;
    revoked = true;
    warn('operator credential revoked (token rotated) — presence unregistered, push stopped; restart with the current token');
    try { if (me && pushEnabled) log.unregisterSession(me, instanceId); } catch (err) { warn(`unregister failed: ${errorMessage(err)}`); }
  }

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    const a = (req.params.arguments ?? {}) as Record<string, unknown>;
    try {
      return await dispatchTool(req.params.name, a);
    } catch (err) {
      return errorText(`${req.params.name} failed: ${errorMessage(err)}`);
    }
  });

  async function dispatchTool(name: string, a: Record<string, unknown>) {
      switch (name) {
        case 'post_message': return text(await postMessage(a));
        case 'read_transcript': return text(readTranscript(a));
        case 'check_inbox': {
          const who = requireMe();
          return text(log.transcript({ inbox: who }, { sinceId: num(a.since_id) ?? 0, limit: num(a.limit) ?? 50 }).map(compact));
        }
        case 'mint_child': {
          const who = requireMe();
          if (isWorker) return errorText('refused: workers cannot mint children (depth 1)');
          if (who === 'operator') return errorText('refused: the operator does not mint children');
          return text(log.mintChild(who, { label: str(a.label), dispatchId: num(a.dispatch_id) }));
        }
        case 'confirm_sent': {
          const who = requireMe();
          const id = num(a.message_id);
          if (id === undefined || !Number.isInteger(id) || id < 1) return errorText('confirm_sent: message_id must be a positive integer');
          if (a.ok !== undefined && typeof a.ok !== 'boolean') return errorText('confirm_sent: ok must be a boolean');
          confirmSent(log, id, { from: who, ok: a.ok !== false, reason: str(a.reason) });
          return text({ ok: true });
        }
        case 'log_sent': {
          const who = requireMe();
          const to = requireStr(a.to, 'to');
          const kind = parseAddress(to)?.kind;
          if (kind !== 'agent' && kind !== 'child' && kind !== 'operator') {
            return errorText('log_sent mirrors a DIRECT SendMessage only (an agent, child or operator address); rooms and @all go through post_message');
          }
          return text(compact(mirrorSent(log, { from: who, to, body: requireStr(a.body, 'body'), summary: str(a.summary) })));
        }
        case 'log_received': return text(compact(mirrorReceived(log, { fromName: requireStr(a.from_name, 'from_name'), fromUds: str(a.from_uds), fromMode: str(a.from_mode), to: requireMe(), body: requireStr(a.body, 'body') })));
        case 'create_room': return text(broker.createRoom(requireMe(), requireStr(a.name, 'name'), { topic: str(a.topic), open: a.open === true }));
        case 'join_room': { const who = requireMe(); return text(broker.addMember(who, requireStr(a.room, 'room'), str(a.address) ?? who)); }
        case 'leave_room': { const who = requireMe(); return text(broker.removeMember(who, requireStr(a.room, 'room'), str(a.address) ?? who)); }
        case 'list_rooms': {
          const who = requireMe();
          return text(log.roomsFor(who).map((r) => ({ ...r, members: log.members(r.name).map((m) => m.address), floor: log.floor(r.name) })));
        }
        case 'acquire_floor': return text(broker.acquireFloor(requireMe(), requireStr(a.room, 'room'), num(a.lease_ms)));
        case 'release_floor': return text(broker.releaseFloor(requireMe(), requireStr(a.room, 'room')));
        case 'request_pause': return requestFleetPause(str(a.reason));
        case 'ack_pause': return ackFleetPause(a.work_parked, str(a.note));
        case 'resume_pause': return resumeFleetPause(str(a.note));
        case 'pause_status': {
          requireMe();
          const staleMs = num(a.stale_ms);
          return text(pauseReadiness(log, inFlightSource, staleMs === undefined ? {} : { staleMs }));
        }
        case 'comms_whoami': refreshLazyIdentity(); return text({
          identity: operatorStillValid() ? me : null, revoked: !operatorStillValid(), sessionName, worker: isWorker, operator: isOperator && operatorStillValid(), pushEnabled, pushDelivery, session: me ? log.session(me) : null,
          bindingSource, tierCap: tierCap(),
          rooms: me ? log.roomsFor(me).map((r) => r.name) : [], liveSessions: log.liveSessions(), sendMessageLimits: SENDMESSAGE_LIMITS,
        });
        default: return errorText(`unknown tool: ${name}`);
      }
  }

  async function postMessage(a: Record<string, unknown>) {
    const who = requireMe();
    const res = await broker.post({
      from: who, to: requireStr(a.to, 'to'), body: requireStr(a.body, 'body'), kind: str(a.kind) as MessageKind | undefined,
      requestedTier: (str(a.requested_tier) as Tier | undefined) ?? null, replyTo: num(a.reply_to) ?? null,
      tierCap: tierCap(),
      issue: str(a.issue) ?? null, thread: str(a.thread) ?? null, meta: { transport: 'heddle-comms' },
      mentions: validMentionsArg(a.mentions),
      holdFloor: a.hold_floor === true, releaseFloor: a.release_floor === true,
    });
    if (res.outcome === 'refused') return res;
    const rec = log.get(res.messageId);
    const targetKind = parseAddress(res.to)?.kind;
    const tactical = rec !== null && (targetKind === 'agent' || targetKind === 'child') && res.code === 'no-live-session';
    return {
      ...res,
      note: tactical
        ? 'No live heddle-comms session for the target: it can pull this from the log, or deliver it now with SendMessage using sendMessage below, then call confirm_sent.'
        : res.code === 'queued-for-channel' ? "Queued: the target's heddle-comms channel will inject it (structured <channel> event)." : undefined,
      ...(tactical && rec ? { sendMessage: sendMessageHint(rec, res.envelope, log.session(res.to)?.sessionName ?? null) } : {}),
    };
  }

  /**
   * Read policy: reading needs a bound identity; the operator reads anything; an agent reads rooms
   * it may post to, DM threads it is part of, and its own inbox — never the whole log or other
   * people's DMs (the file is shared, but the tool surface is not a fleet-wide wiretap).
   */
  function readTranscript(a: Record<string, unknown>) {
    const who = requireMe();
    const q = { sinceId: num(a.since_id), sinceTs: str(a.since_ts), thread: str(a.thread), limit: num(a.limit) ?? 50 };
    let scope;
    if (a.room) {
      const room = String(a.room);
      if (who !== 'operator' && !log.roomsFor(who).some((r) => r.name === room)) {
        throw new Error(`${who} may not read ${room} (not open, and you are not a member)`);
      }
      scope = { room };
    } else if (Array.isArray(a.pair)) {
      const pair = [String(a.pair[0]), String(a.pair[1])] as [string, string];
      if (who !== 'operator' && !pair.includes(who)) throw new Error('you may only read DM threads you are part of');
      scope = { pair };
    } else if (a.all) {
      if (who !== 'operator') throw new Error('the whole log is operator-only; use room / pair / inbox');
      scope = { all: true as const };
    } else {
      scope = { inbox: who };
    }
    return log.transcript(scope, q).map(compact);
  }

  // ------------------------------------------------------------------ lifecycle
  let stopping = false;
  let timer: NodeJS.Timeout | null = null;
  let inbound: InboundPump | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  let nudger: NodeJS.Timeout | null = null;

  async function start(transport: McpTransport): Promise<void> {
    await mcp.connect(transport);
    // One loop, never overlapping: the next cycle is scheduled only after this one finished.
    // It deliberately does not depend on an identity: a lazy-bound session may gain its sender
    // identity after startup, but its broker still owns held-message retries from the outset.
    const cycle = async () => {
      if (stopping) return;
      if (!operatorStillValid()) { await revokeOperator(); return; } // stop pumping for a revoked operator
      if (inbound) { try { await inbound.tick(); } catch (err) { warn(`inbound tick failed: ${errorMessage(err)}`); } }
      try { await broker.pump(); } catch (err) { warn(`pump failed: ${errorMessage(err)}`); }
      if (!stopping) { timer = setTimeout(cycle, 1_000); timer.unref(); }
    };
    const scheduleCycle = () => {
      timer = setTimeout(cycle, 1_000);
      timer.unref();
    };
    if (!me) { scheduleCycle(); return; }
    const startupIdentity = me;
    if (pushEnabled) {
      log.registerSession({
        address: startupIdentity, sessionId: instanceId, sessionName,
        pid: env.CLAUDE_PID ? Number(env.CLAUDE_PID) : process.ppid, socket: env.CLAUDE_CODE_MESSAGING_SOCKET ?? null, // the hosting Claude session, not this child
      });
      if (pushDelivery === 'suspect-channel-not-loaded') {
        warn(`push suspect: ${startupIdentity} was launched WITHOUT --dangerously-load-development-channels server:heddle-comms — `
          + 'Claude Code will DROP channel events silently (they still record as channel-written). '
          + PUSH_SUSPECT_RELAUNCH_REMEDY);
        try {
          const alreadyNoted = log.transcript({ pair: [startupIdentity, startupIdentity] })
            .some((row) => row.from === startupIdentity && row.to === startupIdentity && row.meta?.diagnostic === 'push-suspect');
          // A later re-break will not re-note; comms_whoami.pushDelivery remains the live warning surface.
          if (!alreadyNoted) {
            log.append({
              from: startupIdentity, to: startupIdentity,
              body: '⚠️ heddle-comms PUSH SUSPECT: this session was launched WITHOUT '
                + '--dangerously-load-development-channels server:heddle-comms. Channel events may be dropped '
                + 'silently by Claude Code (they still record as channel-written). You are effectively PULL-ONLY. '
                + PUSH_SUSPECT_RELAUNCH_REMEDY,
              meta: { diagnostic: 'push-suspect' },
            });
          }
        } catch (err) { warn(`push-suspect self-note failed: ${errorMessage(err)}`); }
      }
      inbound = new InboundPump(log, startupIdentity, (event) => {
        for (const k of Object.keys(event.meta)) if (!IDENTIFIER.test(k)) delete event.meta[k]; // Claude Code drops these silently — never send them
        return mcp.notification({ method: 'notifications/claude/channel', params: { content: event.content, meta: event.meta } });
      });
      heartbeat = setInterval(() => {
        if (!operatorStillValid()) { void revokeOperator(); return; }
        try { log.heartbeatSession(startupIdentity, instanceId); } catch (err) { warn(`heartbeat failed: ${errorMessage(err)}`); }
      }, 30_000);
      heartbeat.unref();

      // Idle-nudger (HED-137): hosted only by an operator session (static gate), and only by the
      // one that currently owns the operator presence row (dynamic check, each cycle).
      if (shouldRunNudger(isOperator, pushEnabled)) {
        const cycleMs = parseNudgeMs(env.HEDDLE_COMMS_NUDGE_MS);
        const nudgeOpts: NudgeOptions = { idleMs: cycleMs, cooldownMs: cycleMs };
        // Self-scheduling, never overlapping: the next cycle is armed only after this one's posts
        // settle, so a slow `broker.post` cannot let two cycles run at once and double-nudge.
        const nudgeCycle = async () => {
          if (stopping) return;
          if (!operatorStillValid()) { await revokeOperator(); return; }
          try {
            if (isElectedNudger(log, instanceId)) {
              for (const idle of dueForNudge(log, nudgeOpts)) {
                await broker.post({
                  from: OPERATOR, to: idle.address, kind: 'status', body: nudgeBody(idle),
                  // An automated message must never wear the human's authority: the loop lives in
                  // the operator's session, so without this demotion every nudge would be stamped
                  // `operator` and read as Maya speaking.
                  requestedTier: 'agent-message',
                  meta: { nudge: { idleMs: idle.idleMs } },
                });
              }
            }
          } catch (err) { warn(`nudge cycle failed: ${errorMessage(err)}`); }
          if (!stopping) { nudger = setTimeout(() => void nudgeCycle(), cycleMs); nudger.unref(); }
        };
        nudger = setTimeout(() => void nudgeCycle(), cycleMs);
        nudger.unref();
      }
    } else {
      warn(`push disabled (HEDDLE_COMMS_PUSH is not 1): ${startupIdentity} is pull-only — no presence row, no channel events`);
    }
    scheduleCycle();
  }

  async function stop(): Promise<void> {
    if (stopping) return;
    stopping = true;
    if (timer) clearTimeout(timer);
    if (heartbeat) clearInterval(heartbeat);
    if (nudger) clearTimeout(nudger);
    try { if (me && pushEnabled) log.unregisterSession(me, instanceId); } catch (err) { warn(`unregister failed: ${errorMessage(err)}`); }
    try { await mcp.close(); } catch (err) { warn(`mcp close failed (transport likely already gone): ${errorMessage(err)}`); }
    try { log.close(); } catch (err) { warn(`log close failed: ${errorMessage(err)}`); }
    if (ownsLedger) { try { (ledger as Ledger | null)?.close?.(); } catch (err) { warn(`ledger close failed: ${errorMessage(err)}`); } }
  }

  return { mcp, broker, log, get identity() { return me; }, isOperator, pushEnabled, start, stop };
}

// ---------------------------------------------------------------------------- tools

export const TOOLS = [
  {
    name: 'post_message',
    description: 'Post a message through the heddle comms broker (durable log + delivery discipline). `to` may be an address (K, K.1, operator), a room (#fleet), @all, @orchestrator, or a unique prefix of a known participant. The broker decides the trust tier; you may only request one. Returns the typed outcome and, for Claude targets without a live channel, the exact SendMessage payload to deliver tactically.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string' },
        body: { type: 'string' },
        kind: { type: 'string', enum: [...MESSAGE_KINDS] },
        requested_tier: { type: 'string', enum: [...TIERS], description: 'Omit for auto (highest verifiable tier).' },
        reply_to: { type: 'number' },
        issue: { type: 'string' },
        thread: { type: 'string' },
        mentions: { type: 'array', items: { type: 'string' }, maxItems: 16, description: 'Rooms: addresses to explicitly ping — each gets a targeted push-or-inbox delivery (never parsed from the body).' },
        hold_floor: { type: 'boolean', description: 'Rooms: take the floor before posting (multi-part reply).' },
        release_floor: { type: 'boolean', description: 'Rooms: release the floor after this post.' },
      },
      required: ['to', 'body'],
    },
  },
  {
    name: 'read_transcript',
    description: 'Read the durable comms log: a room you may post to, a DM pair you are part of, or your inbox (direct + @all) — the operator may also read `all`; oldest first with exclusive cursors. Defaults to your inbox.',
    inputSchema: {
      type: 'object',
      properties: {
        room: { type: 'string' }, pair: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 2 },
        inbox: { type: 'boolean', description: 'Your own inbox (requires a bound identity).' }, all: { type: 'boolean' },
        since_id: { type: 'number' }, since_ts: { type: 'string' }, thread: { type: 'string' }, limit: { type: 'number' },
      },
    },
  },
  {
    name: 'check_inbox',
    description: 'New messages addressed to you (direct + @all + room posts that mention you) since a message id. Pull model — call it when you want to know.',
    inputSchema: { type: 'object', properties: { since_id: { type: 'number' }, limit: { type: 'number' } } },
  },
  {
    name: 'mint_child',
    description: 'Mint the next child address for yourself (K → K.1, K.2 …) — an in-session subagent or a worker you run outside heddle dispatch. Refused inside a heddle worker (depth 1) and for the operator.',
    inputSchema: { type: 'object', properties: { label: { type: 'string' }, dispatch_id: { type: 'number' } } },
  },
  {
    name: 'confirm_sent',
    description: 'Record that you delivered a brokered message tactically with SendMessage (the message id came from post_message). Only the message\'s sender may confirm it.',
    inputSchema: { type: 'object', properties: { message_id: { type: 'number' }, ok: { type: 'boolean' }, reason: { type: 'string' } }, required: ['message_id'] },
  },
  {
    name: 'log_sent',
    description: 'Mirror a raw SendMessage you made WITHOUT post_message into the durable log (recorded as an untrusted agent-message).',
    inputSchema: { type: 'object', properties: { to: { type: 'string' }, body: { type: 'string' }, summary: { type: 'string' } }, required: ['to', 'body'] },
  },
  {
    name: 'log_received',
    description: 'Mirror a <cross-session-message from="uds:…" from-name="X"> you received into the durable log (recorded from the neutral `peer` address; the claimed name goes into meta).',
    inputSchema: { type: 'object', properties: { from_name: { type: 'string' }, from_uds: { type: 'string' }, from_mode: { type: 'string' }, body: { type: 'string' } }, required: ['from_name', 'body'] },
  },
  {
    name: 'create_room',
    description: 'Create a room (operator/orchestrators only; workers refused + ledgered). Rooms are #names; closed unless open=true. Idempotent for an existing name.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, topic: { type: 'string' }, open: { type: 'boolean' } }, required: ['name'] },
  },
  {
    name: 'join_room',
    description: 'Add a member to a room (operator/orchestrators only — workers cannot self-join; an orchestrator may add itself, peers, and its own children). Omit address to add yourself.',
    inputSchema: { type: 'object', properties: { room: { type: 'string' }, address: { type: 'string' } }, required: ['room'] },
  },
  {
    name: 'leave_room',
    description: 'Remove a member from a room (yourself always; others: operator/orchestrators).',
    inputSchema: { type: 'object', properties: { room: { type: 'string' }, address: { type: 'string' } }, required: ['room'] },
  },
  {
    name: 'list_rooms',
    description: 'Rooms you may post to (open rooms + closed rooms you are a member of), with members and the current floor holder.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'acquire_floor',
    description: 'Take (or renew) the floor of a room for a multi-part reply: others posting to the room are refused with floor-held until you release it or the lease (default 60 s) expires. post_message also accepts hold_floor / release_floor.',
    inputSchema: { type: 'object', properties: { room: { type: 'string' }, lease_ms: { type: 'number' } }, required: ['room'] },
  },
  {
    name: 'release_floor',
    description: 'Release the floor of a room you hold.',
    inputSchema: { type: 'object', properties: { room: { type: 'string' } }, required: ['room'] },
  },
  {
    name: 'comms_whoami',
    description: "Your bound comms identity, this session's registration, rooms, live comms sessions, and the documented limits of the tactical SendMessage layer.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'request_pause',
    description: 'OPERATOR ONLY. Ask the whole fleet to pause and park its work — the first step of a Claude account rotation, which relaunches every session. Broadcasts at operator tier and returns the current readiness.',
    inputSchema: { type: 'object', properties: { reason: { type: 'string' } } },
  },
  {
    name: 'ack_pause',
    description: "Answer the operator's pause request. Set work_parked=true ONLY once your work is committed, pushed, or otherwise safe to lose from memory — the fleet is relaunched once everyone acks, and anything you are still holding goes with it.",
    inputSchema: { type: 'object', properties: { work_parked: { type: 'boolean' }, note: { type: 'string' } }, required: ['work_parked'] },
  },
  {
    name: 'resume_pause',
    description: 'OPERATOR ONLY. Lift the fleet pause in force — call this after the rotation (or after deciding not to rotate). Until it is called the pause stays in force, and anything gating on it keeps refusing.',
    inputSchema: { type: 'object', properties: { note: { type: 'string' } } },
  },
  {
    name: 'pause_status',
    description: 'Who has acked the pause, who is still pending, who acked with work NOT parked, whose ack came from a replaced session, and how many dispatches are in flight. ready=true means every check passed INCLUDING a consulted dispatch ledger — it is never true on unverified in-flight status. stale_ms can only WIDEN the live-session window (it is clamped to the broker default).',
    inputSchema: { type: 'object', properties: { stale_ms: { type: 'number' } } },
  },
];

// ---------------------------------------------------------------------------- helpers

function compact(r: ReturnType<CommsLog['get']>) {
  if (!r) return null;
  return { id: r.id, ts: r.ts, from: r.from, to: r.to, tier: r.tier, kind: r.kind, body: r.body, replyTo: r.replyTo, thread: r.thread, issue: r.issue };
}
function str(v: unknown): string | undefined { return typeof v === 'string' && v.length ? v : undefined; }
function validMentionsArg(v: unknown): string[] | null {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v) || v.some((m) => typeof m !== 'string')) {
    throw new Error('mentions must be an array of address strings'); // fail fast — never coerce or silently drop
  }
  return v as string[];
}
function requireStr(v: unknown, name: string): string {
  if (typeof v !== 'string' || v.length === 0) throw new Error(`${name} must be a non-empty string`);
  return v;
}
function num(v: unknown): number | undefined { return typeof v === 'number' && Number.isFinite(v) ? v : undefined; }
function text(obj: unknown) { return { content: [{ type: 'text' as const, text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] }; }
function errorText(msg: string) { return { content: [{ type: 'text' as const, text: msg }], isError: true }; }
