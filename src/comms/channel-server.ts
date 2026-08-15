#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CommsLog, DEFAULT_COMMS_PATH } from './log.js';
import { Ledger, DEFAULT_LEDGER_PATH } from '../ledger.js';
import { Broker } from './broker.js';
import { ChannelTransport, InboundPump, CHANNEL_INSTRUCTIONS, SENDMESSAGE_LIMITS, sendMessageHint, confirmSent, mirrorSent, mirrorReceived, errorMessage } from './bridge.js';
import { parseAddress } from './address.js';
import { TIERS, MESSAGE_KINDS, type Tier, type MessageKind } from './types.js';

/**
 * heddle-comms — the comms broker as a Claude Code CHANNEL MCP server (HED-7).
 *
 * One process per Claude Code session, spawned by Claude Code from .mcp.json:
 *   { "mcpServers": { "heddle-comms": { "command": "heddle-comms" } } }
 * Push delivery (channel events) needs the session started with
 *   claude --dangerously-load-development-channels server:heddle-comms
 * (channels are a research preview; custom channels are allowlisted per entry). Without the flag
 * the server still works as a plain MCP server: the tools below (pull model), no push.
 *
 * Identity is bound ONCE at startup from the process environment (never chosen by the model):
 *   HEDDLE_AGENT → FLEET_AGENT → HEDDLE_COMMS_ADDRESS (a heddle-dispatched worker) → a
 *   `.fleet-agent` file walking up from cwd → unbound (tools that need a sender refuse).
 * Only agent/child addresses bind here — `operator` needs the operator surface (HED-65), never an
 * env var an agent session could set. A worker (HEDDLE_WORKER=1) may not mint children — depth 1.
 *
 * PUSH IS OPT-IN: Claude Code gives a server no way to know whether it was loaded as a channel,
 * and it drops channel events silently when it was not. So presence (the `sessions` row that
 * makes senders get "queued-for-channel") and the inbound pump run only when the launcher says
 * the flag is on: HEDDLE_COMMS_PUSH=1. Without it this session is pull-only and senders are told
 * "no-live-session" (+ the SendMessage hint) — honest, never "delivered" into a void.
 */

const log = new CommsLog(process.env.HEDDLE_COMMS_DB || DEFAULT_COMMS_PATH);
const ledger = openLedgerIfPresent();
const me = resolveCommsIdentity();
const isWorker = process.env.HEDDLE_WORKER === '1';
const pushEnabled = process.env.HEDDLE_COMMS_PUSH === '1';
const sessionName = process.env.HEDDLE_SESSION_NAME || me;
const warn = (msg: string) => process.stderr.write(`heddle-comms: ${msg}\n`);

const mcp = new Server(
  { name: 'heddle-comms', version: '0.0.1' },
  {
    capabilities: { experimental: { 'claude/channel': {} }, tools: {} },
    instructions: CHANNEL_INSTRUCTIONS + (me ? ` You are ${me}.` : ' (This session has NO bound comms identity — post_message will refuse until HEDDLE_AGENT / FLEET_AGENT / .fleet-agent is set.)'),
  },
);

const broker = new Broker({ log, ledger, transport: new ChannelTransport(log), onWarning: warn });
// A restart must not orphan messages that were held at a permission gate before it — but only the
// ones THIS identity posted (one broker per session on a shared db).
if (me) {
  const restored = broker.restoreHeld({ sender: me });
  if (restored) warn(`restored ${restored} held message(s) posted by ${me}`);
}

// ---------------------------------------------------------------------------- tools

const tools = [
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
    description: 'Mint the next child address for yourself (K → K.1, K.2 …) — an in-session subagent or a worker you run outside heddle dispatch. Refused inside a heddle worker (depth 1).',
    inputSchema: { type: 'object', properties: { label: { type: 'string' }, dispatch_id: { type: 'number' } } },
  },
  {
    name: 'confirm_sent',
    description: 'Record that you delivered a brokered message tactically with SendMessage (the message id came from post_message).',
    inputSchema: { type: 'object', properties: { message_id: { type: 'number' }, ok: { type: 'boolean' }, reason: { type: 'string' } }, required: ['message_id'] },
  },
  {
    name: 'log_sent',
    description: 'Mirror a raw SendMessage you made WITHOUT post_message into the durable log (recorded as an untrusted agent-message).',
    inputSchema: { type: 'object', properties: { to: { type: 'string' }, body: { type: 'string' }, summary: { type: 'string' } }, required: ['to', 'body'] },
  },
  {
    name: 'log_received',
    description: 'Mirror a <cross-session-message from="uds:…" from-name="X"> you received into the durable log.',
    inputSchema: { type: 'object', properties: { from_name: { type: 'string' }, from_uds: { type: 'string' }, from_mode: { type: 'string' }, body: { type: 'string' } }, required: ['from_name', 'body'] },
  },
  {
    name: 'comms_whoami',
    description: 'Your bound comms identity, this session\'s registration, live comms sessions, and the documented limits of the tactical SendMessage layer.',
    inputSchema: { type: 'object', properties: {} },
  },
];

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

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
      case 'comms_whoami': return text({
        identity: me, sessionName, worker: isWorker, session: me ? log.session(me) : null,
        liveSessions: log.liveSessions(), sendMessageLimits: SENDMESSAGE_LIMITS,
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
  });
  if (res.outcome === 'refused') return res;
  const rec = log.get(res.messageId);
  const targetKind = parseAddress(res.to)?.kind;
  const tactical = rec !== null && (targetKind === 'agent' || targetKind === 'child') && res.code === 'no-live-session';
  return {
    ...res,
    note: tactical
      ? 'No live heddle-comms session for the target: it can pull this from the log, or deliver it now with SendMessage using sendMessage below, then call confirm_sent.'
      : res.code === 'queued-for-channel' ? 'Queued: the target\'s heddle-comms channel will inject it (structured <channel> event).' : undefined,
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

// ---------------------------------------------------------------------------- session + pumps

let stopping = false;
const bye = () => {
  if (stopping) return;
  stopping = true;
  try { if (me && pushEnabled) log.unregisterSession(me); } catch (err) { warn(`unregister failed: ${errorMessage(err)}`); }
  try { log.close(); } catch (err) { warn(`log close failed: ${errorMessage(err)}`); }
  try { ledger?.close(); } catch (err) { warn(`ledger close failed: ${errorMessage(err)}`); }
  process.exit(0);
};
process.on('SIGTERM', bye); process.on('SIGINT', bye); process.stdin.on('close', bye);

if (me) {
  // Holds this identity posted are released by THIS process (also in pull-only mode) — one loop,
  // never overlapping: the next cycle is scheduled only after this one finished.
  let inbound: InboundPump | null = null;
  if (pushEnabled) {
    log.registerSession({
      address: me, sessionId: process.env.CLAUDE_CODE_SESSION_ID ?? null, sessionName,
      pid: process.env.CLAUDE_PID ? Number(process.env.CLAUDE_PID) : process.ppid, socket: process.env.CLAUDE_CODE_MESSAGING_SOCKET ?? null,
    });
    inbound = new InboundPump(log, me, (event) => mcp.notification({ method: 'notifications/claude/channel', params: { content: event.content, meta: event.meta } }));
    const heartbeat = setInterval(() => { try { log.heartbeatSession(me); } catch (err) { warn(`heartbeat failed: ${errorMessage(err)}`); } }, 30_000);
    heartbeat.unref();
  } else {
    warn(`push disabled (HEDDLE_COMMS_PUSH is not 1): ${me} is pull-only — no presence row, no channel events`);
  }
  const cycle = async () => {
    if (stopping) return;
    if (inbound) { try { await inbound.tick(); } catch (err) { warn(`inbound tick failed: ${errorMessage(err)}`); } }
    try { await broker.pump(); } catch (err) { warn(`pump failed: ${errorMessage(err)}`); }
    setTimeout(cycle, 1_000).unref();
  };
  setTimeout(cycle, 1_000).unref();
}

await mcp.connect(new StdioServerTransport());

// ---------------------------------------------------------------------------- helpers

function resolveCommsIdentity(): string | null {
  // TODO(HED-65/HED-2): switch to Agent U's src/identity.ts once it lands (same order, one module).
  const bindable = (v: string | undefined): string | null => {
    const s = v?.trim();
    if (!s) return null;
    const kind = parseAddress(s)?.kind;
    if (kind === 'agent' || kind === 'child') return s;
    if (kind === 'operator') warn('refusing to bind the operator identity from an env var / .fleet-agent — the operator surface binds it (HED-65)');
    return null;
  };
  const fromEnv = bindable(process.env.HEDDLE_AGENT) ?? bindable(process.env.FLEET_AGENT) ?? bindable(process.env.HEDDLE_COMMS_ADDRESS);
  if (fromEnv) return fromEnv;
  let dir = process.cwd();
  for (;;) {
    const f = join(dir, '.fleet-agent');
    if (existsSync(f)) {
      const v = bindable(readFileSync(f, 'utf8'));
      if (v) return v;
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** The dispatch ledger is consulted opportunistically for lineage; never create it as a side effect. */
function openLedgerIfPresent(): Ledger | null {
  const path = process.env.HEDDLE_LEDGER_DB || DEFAULT_LEDGER_PATH;
  if (!existsSync(path)) return null;
  try { return new Ledger(path); } catch (err) { warn(`ledger unavailable: ${(err as Error).message}`); return null; }
}

function requireMe(): string {
  if (!me) throw new Error('no bound comms identity: set HEDDLE_AGENT (or FLEET_AGENT / .fleet-agent) before starting the session');
  return me;
}

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
