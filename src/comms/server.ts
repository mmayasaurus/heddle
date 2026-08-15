import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Transport as McpTransport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { CommsLog, DEFAULT_COMMS_PATH } from './log.js';
import { Ledger, DEFAULT_LEDGER_PATH } from '../ledger.js';
import { Broker } from './broker.js';
import type { LineageSource } from './envelope.js';
import {
  ChannelTransport, InboundPump, CHANNEL_INSTRUCTIONS, SENDMESSAGE_LIMITS, sendMessageHint, confirmSent, mirrorSent, mirrorReceived, errorMessage,
} from './bridge.js';
import { parseAddress } from './address.js';
import { TIERS, MESSAGE_KINDS, type Tier, type MessageKind } from './types.js';

/**
 * heddle-comms — the comms broker as a Claude Code CHANNEL MCP server (HED-7 / HED-73), as a
 * constructible unit so it can be tested in-process (InMemoryTransport) and shipped as a bin
 * (src/comms/channel-server.ts wires stdio + signals).
 *
 * Identity is bound ONCE at construction from the ENVIRONMENT (never chosen by the model):
 *   operator   — only via the configuration-level credential: HEDDLE_COMMS_ROLE=operator AND
 *                HEDDLE_COMMS_OPERATOR_TOKEN equal to ~/.heddle/operator.token (created once with
 *                `heddle-comms --init-operator-token`, 0600; `--rotate` invalidates the old one).
 *                A model cannot edit its own MCP config and agent sessions never see that env, so
 *                "origin-verified" = "this session was configured as the operator's". The token is
 *                re-checked on every privileged call, so a rotation takes effect immediately.
 *   agent/child — HEDDLE_AGENT → FLEET_AGENT → HEDDLE_COMMS_ADDRESS (a heddle-dispatched worker)
 *                → a `.fleet-agent` file walking up from cwd → unbound (tools that need a sender
 *                refuse). `operator` is REFUSED from these sources. HEDDLE_WORKER=1 forbids
 *                mint_child (depth 1).
 *
 * PUSH IS OPT-IN (HEDDLE_COMMS_PUSH=1): Claude Code gives a server no way to know whether it was
 * loaded as a channel and drops channel events silently when it was not, so presence (the
 * `sessions` row that makes senders get "queued-for-channel") and the inbound pump run only when
 * the launcher says the flag is on. Otherwise the session is pull-only and senders get
 * "no-live-session" (+ the SendMessage hint) — honest, never "delivered" into a void.
 */

export interface CommsServerOptions {
  env: NodeJS.ProcessEnv;
  cwd?: string;
  /** Injectable for tests; defaults open the real files (env HEDDLE_COMMS_DB / HEDDLE_LEDGER_DB). */
  log?: CommsLog;
  ledger?: LineageSource | null;
  warn?: (message: string) => void;
  /** Epoch-ms clock passed to the Broker (rate limits, holds, floor leases); injectable for tests. */
  now?: () => number;
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

const IDENTIFIER = /^[a-z0-9_]+$/;

export function operatorTokenPath(env: NodeJS.ProcessEnv): string {
  return env.HEDDLE_OPERATOR_TOKEN_PATH || join(homedir(), '.heddle', 'operator.token');
}

/**
 * Create (or, with rotate, replace) ~/.heddle/operator.token (0600). Returns what happened; the
 * token value itself is only ever in the file — never printed, never logged.
 */
export function initOperatorToken(env: NodeJS.ProcessEnv, opts: { rotate?: boolean } = {}): { path: string; action: 'created' | 'rotated' | 'kept' } {
  const path = operatorTokenPath(env);
  if (existsSync(path) && !opts.rotate) return { path, action: 'kept' };
  const action = existsSync(path) ? 'rotated' : 'created';
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, randomBytes(24).toString('hex') + '\n', { mode: 0o600 });
  return { path, action };
}

/** Does the presented credential match the operator token file right now? Constant-time; never logs the values. */
export function operatorTokenMatches(env: NodeJS.ProcessEnv): boolean {
  const presented = (env.HEDDLE_COMMS_OPERATOR_TOKEN ?? '').trim();
  const path = operatorTokenPath(env);
  if (!presented || !existsSync(path)) return false;
  const expected = readFileSync(path, 'utf8').trim();
  const a = Buffer.from(presented), b = Buffer.from(expected);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

/** Bind the comms identity from the environment (see the module doc). */
export function resolveCommsIdentity(env: NodeJS.ProcessEnv, cwd: string, warn: (m: string) => void): { identity: string | null; isOperator: boolean } {
  if (env.HEDDLE_COMMS_ROLE === 'operator') {
    if (operatorTokenMatches(env)) return { identity: 'operator', isOperator: true };
    warn('HEDDLE_COMMS_ROLE=operator but the operator token is missing or does not match — refusing to bind operator (unbound)');
    return { identity: null, isOperator: false };
  }
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
  if (fromEnv) return { identity: fromEnv, isOperator: false };
  let dir = cwd;
  for (;;) {
    const f = join(dir, '.fleet-agent');
    if (existsSync(f)) {
      try {
        const v = bindable(readFileSync(f, 'utf8'));
        if (v) return { identity: v, isOperator: false };
      } catch (err) {
        warn(`could not read ${f}: ${errorMessage(err)} — continuing unbound`);
      }
    }
    const up = dirname(dir);
    if (up === dir) return { identity: null, isOperator: false };
    dir = up;
  }
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
  const ledger = opts.ledger === undefined ? openLedgerIfPresent(env, warn) : opts.ledger;
  const { identity: me, isOperator } = resolveCommsIdentity(env, cwd, warn);
  const isWorker = env.HEDDLE_WORKER === '1';
  const pushEnabled = env.HEDDLE_COMMS_PUSH === '1';
  const sessionName = env.HEDDLE_SESSION_NAME || me;

  const mcp = new Server(
    { name: 'heddle-comms', version: '0.0.1' },
    {
      capabilities: { experimental: { 'claude/channel': {} }, tools: {} },
      instructions: CHANNEL_INSTRUCTIONS + (me ? ` You are ${me}.` : ' (This session has NO bound comms identity — post_message will refuse until HEDDLE_AGENT / FLEET_AGENT / .fleet-agent is set.)'),
    },
  );
  const broker = new Broker({ log, ledger, transport: new ChannelTransport(log), onWarning: warn, ...(opts.now ? { now: opts.now } : {}) });
  log.ensureDefaultRooms();
  if (me) {
    const restored = broker.restoreHeld({ sender: me });
    if (restored) warn(`restored ${restored} held message(s) posted by ${me}`);
  }

  /** The bound identity, re-verified for the operator on every call so a token rotation bites immediately. */
  const requireMe = (): string => {
    if (!me) throw new Error('no bound comms identity: set HEDDLE_AGENT (or FLEET_AGENT / .fleet-agent) — or, for the operator, HEDDLE_COMMS_ROLE=operator + the token — before starting the session');
    if (isOperator && !operatorTokenMatches(env)) throw new Error('operator token no longer matches (rotated?): restart the session with the current token');
    return me;
  };

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    const a = (req.params.arguments ?? {}) as Record<string, unknown>;
    try {
      switch (req.params.name) {
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
          confirmSent(log, id, { from: who, ok: a.ok !== false, reason: str(a.reason) });
          return text({ ok: true });
        }
        case 'log_sent': return text(compact(mirrorSent(log, { from: requireMe(), to: requireStr(a.to, 'to'), body: requireStr(a.body, 'body'), summary: str(a.summary) })));
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
        case 'comms_whoami': return text({
          identity: me, sessionName, worker: isWorker, operator: isOperator, pushEnabled, session: me ? log.session(me) : null,
          rooms: me ? log.roomsFor(me).map((r) => r.name) : [], liveSessions: log.liveSessions(), sendMessageLimits: SENDMESSAGE_LIMITS,
        });
        default: return errorText(`unknown tool: ${req.params.name}`);
      }
    } catch (err) {
      return errorText(`${req.params.name} failed: ${errorMessage(err)}`);
    }
  });

  async function postMessage(a: Record<string, unknown>) {
    const who = requireMe();
    const res = await broker.post({
      from: who, to: requireStr(a.to, 'to'), body: requireStr(a.body, 'body'), kind: str(a.kind) as MessageKind | undefined,
      requestedTier: (str(a.requested_tier) as Tier | undefined) ?? null, replyTo: num(a.reply_to) ?? null,
      issue: str(a.issue) ?? null, thread: str(a.thread) ?? null, meta: { transport: 'heddle-comms' },
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

  function readTranscript(a: Record<string, unknown>) {
    const q = { sinceId: num(a.since_id), sinceTs: str(a.since_ts), thread: str(a.thread), limit: num(a.limit) ?? 50 };
    let scope;
    if (a.room) scope = { room: String(a.room) };
    else if (Array.isArray(a.pair)) scope = { pair: [String(a.pair[0]), String(a.pair[1])] as [string, string] };
    else if (a.inbox) scope = { inbox: requireMe() };
    else scope = { all: true as const };
    return log.transcript(scope, q).map(compact);
  }

  // ------------------------------------------------------------------ lifecycle
  let stopping = false;
  let timer: NodeJS.Timeout | null = null;
  let inbound: InboundPump | null = null;
  let heartbeat: NodeJS.Timeout | null = null;

  async function start(transport: McpTransport): Promise<void> {
    await mcp.connect(transport);
    if (!me) return;
    if (pushEnabled) {
      log.registerSession({
        address: me, sessionId: env.CLAUDE_CODE_SESSION_ID ?? null, sessionName,
        pid: env.CLAUDE_PID ? Number(env.CLAUDE_PID) : process.pid, socket: env.CLAUDE_CODE_MESSAGING_SOCKET ?? null,
      });
      inbound = new InboundPump(log, me, (event) => {
        for (const k of Object.keys(event.meta)) if (!IDENTIFIER.test(k)) delete event.meta[k]; // Claude Code drops these silently — never send them
        return mcp.notification({ method: 'notifications/claude/channel', params: { content: event.content, meta: event.meta } });
      });
      heartbeat = setInterval(() => { try { log.heartbeatSession(me); } catch (err) { warn(`heartbeat failed: ${errorMessage(err)}`); } }, 30_000);
      heartbeat.unref();
    } else {
      warn(`push disabled (HEDDLE_COMMS_PUSH is not 1): ${me} is pull-only — no presence row, no channel events`);
    }
    // One loop, never overlapping: the next cycle is scheduled only after this one finished.
    const cycle = async () => {
      if (stopping) return;
      if (inbound) { try { await inbound.tick(); } catch (err) { warn(`inbound tick failed: ${errorMessage(err)}`); } }
      try { await broker.pump(); } catch (err) { warn(`pump failed: ${errorMessage(err)}`); }
      if (!stopping) { timer = setTimeout(cycle, 1_000); timer.unref(); }
    };
    timer = setTimeout(cycle, 1_000);
    timer.unref();
  }

  async function stop(): Promise<void> {
    if (stopping) return;
    stopping = true;
    if (timer) clearTimeout(timer);
    if (heartbeat) clearInterval(heartbeat);
    try { if (me && pushEnabled) log.unregisterSession(me); } catch (err) { warn(`unregister failed: ${errorMessage(err)}`); }
    try { await mcp.close(); } catch { /* transport already gone */ }
    try { log.close(); } catch (err) { warn(`log close failed: ${errorMessage(err)}`); }
    try { (ledger as Ledger | null)?.close?.(); } catch (err) { warn(`ledger close failed: ${errorMessage(err)}`); }
  }

  return { mcp, broker, log, identity: me, isOperator, pushEnabled, start, stop };
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
        hold_floor: { type: 'boolean', description: 'Rooms: take the floor before posting (multi-part reply).' },
        release_floor: { type: 'boolean', description: 'Rooms: release the floor after this post.' },
      },
      required: ['to', 'body'],
    },
  },
  {
    name: 'read_transcript',
    description: 'Read the durable comms log: a room, a DM pair, your inbox (direct + @all), or everything; oldest first with exclusive cursors.',
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
    description: 'New messages addressed to you (direct + @all) since a message id. Pull model — call it when you want to know.',
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
];

// ---------------------------------------------------------------------------- helpers

function compact(r: ReturnType<CommsLog['get']>) {
  if (!r) return null;
  return { id: r.id, ts: r.ts, from: r.from, to: r.to, tier: r.tier, kind: r.kind, body: r.body, replyTo: r.replyTo, thread: r.thread, issue: r.issue };
}
function str(v: unknown): string | undefined { return typeof v === 'string' && v.length ? v : undefined; }
function requireStr(v: unknown, name: string): string {
  if (typeof v !== 'string' || v.length === 0) throw new Error(`${name} must be a non-empty string`);
  return v;
}
function num(v: unknown): number | undefined { return typeof v === 'number' && Number.isFinite(v) ? v : undefined; }
function text(obj: unknown) { return { content: [{ type: 'text' as const, text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] }; }
function errorText(msg: string) { return { content: [{ type: 'text' as const, text: msg }], isError: true }; }
