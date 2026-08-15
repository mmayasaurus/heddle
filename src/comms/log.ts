import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import {
  DELIVERY_OUTCOMES, MESSAGE_KINDS, PRIVILEGED_TIERS, TIERS,
  type DeliveryEvent, type DeliveryOutcome, type MessageKind, type MessageRecord, type NewDeliveryEvent,
  type NewMessage, type Participant, type ParticipantKind, type Tier, type TierDecision,
  type TranscriptQuery, type TranscriptScope,
} from './types.js';
import { BROADCAST, canSend, childAddress, parseAddress, requireAddress } from './address.js';
import { isSealed } from './seal.js';

/**
 * Comms log — the durable, append-only record of every brokered message (SPEC §9).
 *
 * This is the backbone the chatroom, the needs-human queue and the dashboard's chat pane all
 * read from, so it is deliberately boring: one row per message, written once, never edited or
 * deleted (SQLite triggers refuse UPDATE/DELETE — "append-only" is enforced by the database,
 * not by convention). Ephemeral transports (Anthropic SendMessage, WebSocket push, long-poll)
 * are mirrors of this log, never the source of truth.
 *
 * Also owns the participant registry: fleet agents/operator register themselves on first send;
 * children ("K.1", "K.2") are MINTED here by their parent — the row that later lets the envelope
 * layer verify "K really is K.2's dispatching orchestrator" (HED-5). Lineage columns are frozen
 * by a trigger once written (only last_seen/label may change), a child's address must equal
 * parent.seq (CHECK), and a dispatch-ledger row binds to at most one child.
 *
 * Same style as src/ledger.ts: node:sqlite (built into Node 22, no native dependency), WAL,
 * ~/.heddle/comms.db. Facts are persisted; anything derived (unread counts, held queues) is
 * computed on read by the layers above.
 */

export const DEFAULT_COMMS_PATH = join(homedir(), '.heddle', 'comms.db');

/** Bump when the schema changes shape; recorded as PRAGMA user_version. */
export const COMMS_SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT    NOT NULL,
  sender      TEXT    NOT NULL,
  target      TEXT    NOT NULL,
  kind        TEXT    NOT NULL DEFAULT 'chat',
  tier        TEXT    NOT NULL DEFAULT 'agent-message',
  verified    INTEGER NOT NULL DEFAULT 0,
  body        TEXT    NOT NULL,
  reply_to    INTEGER,
  issue       TEXT,
  thread      TEXT,
  dispatch_id INTEGER,
  meta        TEXT,
  CHECK (tier IN ('operator', 'orchestrator-directive', 'agent-message')),
  CHECK (verified IN (0, 1)),
  -- verified <=> privileged tier: an unverified operator/directive row cannot exist even via a
  -- raw INSERT, and an agent-message never claims verification.
  CHECK ((tier = 'agent-message' AND verified = 0) OR (tier <> 'agent-message' AND verified = 1))
);
CREATE INDEX IF NOT EXISTS idx_messages_target ON messages(target, id);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender, id);
CREATE INDEX IF NOT EXISTS idx_messages_ts     ON messages(ts);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread, id);

-- Append-only, enforced by the database: no process, however well-meaning, rewrites history.
CREATE TRIGGER IF NOT EXISTS messages_append_only_update BEFORE UPDATE ON messages
BEGIN SELECT RAISE(ABORT, 'comms log is append-only: UPDATE refused'); END;
CREATE TRIGGER IF NOT EXISTS messages_append_only_delete BEFORE DELETE ON messages
BEGIN SELECT RAISE(ABORT, 'comms log is append-only: DELETE refused'); END;
-- Every sender is a registered participant (agents/operator self-register in the same
-- transaction; children exist only once minted) — a raw INSERT cannot speak as an unminted child.
CREATE TRIGGER IF NOT EXISTS messages_sender_registered BEFORE INSERT ON messages
WHEN NOT EXISTS (SELECT 1 FROM participants WHERE address = NEW.sender)
BEGIN SELECT RAISE(ABORT, 'sender is not a registered participant'); END;

-- Typed delivery outcomes (SPEC §10: never a boolean). One row per attempt/decision; refusals
-- that never became a message have message_id NULL. Append-only like messages.
CREATE TABLE IF NOT EXISTS deliveries (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT    NOT NULL,
  message_id INTEGER,
  sender     TEXT    NOT NULL,
  target     TEXT    NOT NULL,
  outcome    TEXT    NOT NULL,
  code       TEXT    NOT NULL,
  reason     TEXT,
  transport  TEXT,
  attempt    INTEGER NOT NULL DEFAULT 1,
  CHECK (outcome IN ('sent', 'held', 'released', 'refused', 'failed', 'logged'))
);
CREATE INDEX IF NOT EXISTS idx_deliveries_message ON deliveries(message_id, id);
CREATE INDEX IF NOT EXISTS idx_deliveries_target  ON deliveries(target, id);
CREATE TRIGGER IF NOT EXISTS deliveries_append_only_update BEFORE UPDATE ON deliveries
BEGIN SELECT RAISE(ABORT, 'delivery log is append-only: UPDATE refused'); END;
CREATE TRIGGER IF NOT EXISTS deliveries_append_only_delete BEFORE DELETE ON deliveries
BEGIN SELECT RAISE(ABORT, 'delivery log is append-only: DELETE refused'); END;

CREATE TABLE IF NOT EXISTS participants (
  address     TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  parent      TEXT REFERENCES participants(address),
  seq         INTEGER,
  dispatch_id INTEGER,
  label       TEXT,
  first_seen  TEXT NOT NULL,
  last_seen   TEXT NOT NULL,
  CHECK (kind IN ('agent', 'child', 'operator')),
  -- A child's address IS its lineage (parent.seq); agents/operator carry no lineage columns.
  CHECK ((kind = 'child' AND parent IS NOT NULL AND seq IS NOT NULL AND address = parent || '.' || seq)
      OR (kind <> 'child' AND parent IS NULL AND seq IS NULL AND dispatch_id IS NULL)),
  -- The address form decides the kind: dotted addresses are children, nothing else may be.
  CHECK ((kind = 'child') = (instr(address, '.') > 0)),
  CHECK (kind <> 'operator' OR address = 'operator'),
  UNIQUE (parent, seq)
);
CREATE INDEX IF NOT EXISTS idx_participants_parent ON participants(parent, seq);
-- One dispatch-ledger row anchors at most one child.
CREATE UNIQUE INDEX IF NOT EXISTS idx_participants_dispatch ON participants(dispatch_id)
  WHERE dispatch_id IS NOT NULL;
-- Lineage is written once. Only last_seen/label may change afterwards — a raw UPDATE cannot
-- re-parent a child ("I am now your orchestrator") or re-point it at another dispatch.
CREATE TRIGGER IF NOT EXISTS participants_lineage_immutable BEFORE UPDATE ON participants
WHEN NEW.address <> OLD.address OR NEW.kind <> OLD.kind OR NEW.parent IS NOT OLD.parent
  OR NEW.seq IS NOT OLD.seq OR NEW.dispatch_id IS NOT OLD.dispatch_id
  OR NEW.first_seen <> OLD.first_seen
BEGIN SELECT RAISE(ABORT, 'participant lineage is immutable: only last_seen/label may change'); END;
`;

/**
 * Meta keys the broker owns. They describe the tier decision and are written ONLY from a sealed
 * decision — whatever a caller puts under these names is dropped, so a sender cannot plant a
 * fake `downgradedFrom` / `tierCode` that would later render as broker-looking header text.
 */
export const RESERVED_META_KEYS: readonly string[] =
  ['tierCode', 'tierReason', 'lineage', 'requestedTier', 'downgradedFrom'];

export interface CommsLogOptions {
  /** Clock override for deterministic tests; must return ISO-8601. */
  now?: () => string;
}

export interface RegisterInput {
  address: string;
  label?: string | null;
}

export interface MintChildInput {
  /** Dispatch-ledger row of the worker, when heddle dispatched it. */
  dispatchId?: number | null;
  label?: string | null;
}

export class CommsLog {
  private db: DatabaseSync;
  private now: () => string;
  private closed = false;

  constructor(path: string = DEFAULT_COMMS_PATH, opts: CommsLogOptions = {}) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    // Set up on a local handle; `this.db` is assigned only once the connection is fully usable, so a
    // constructor failure never leaves a half-initialised object (and closes what it opened).
    const db = new DatabaseSync(path);
    try {
      // WAL + a busy timeout: many agent processes share this file and write concurrently.
      db.exec('PRAGMA journal_mode = WAL;');
      db.exec('PRAGMA busy_timeout = 5000;');
      db.exec('PRAGMA foreign_keys = ON;');
      // Never clobber a version we do not understand: a newer heddle may have migrated this file
      // (many processes share it), and an older shape needs an explicit migration, not relabelling.
      const found = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
      if (found > COMMS_SCHEMA_VERSION) {
        throw new Error(`comms db ${path} is schema v${found}; this heddle understands v${COMMS_SCHEMA_VERSION} — upgrade heddle`);
      }
      if (found !== 0 && found !== COMMS_SCHEMA_VERSION) {
        throw new Error(`comms db ${path} is schema v${found}; no migration to v${COMMS_SCHEMA_VERSION} exists`);
      }
      db.exec(SCHEMA); // idempotent (IF NOT EXISTS) — creates a fresh db, no-op on a current one
      if (found === 0) db.exec(`PRAGMA user_version = ${COMMS_SCHEMA_VERSION};`);
    } catch (err) {
      db.close();
      throw err;
    }
    this.db = db;
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  // ---------------------------------------------------------------- writer

  /**
   * Append one message. Validates addresses/kind, registers a first-time agent/operator sender,
   * refuses unminted children (their lineage would be fiction), and returns the row.
   *
   * Without a `decision` the row is `agent-message` / unverified — always safe. A privileged tier
   * can ONLY be stored by passing the broker's own sealed TierDecision for this exact (from, to):
   * a JSON look-alike is refused (not sealed), a decision for another pair is refused, and an
   * `operator` decision is additionally refused unless `from` really is the operator address.
   * The DB CHECK (verified <=> privileged) backs all of this up against raw INSERTs.
   */
  append(msg: NewMessage, decision?: TierDecision): MessageRecord {
    const from = requireAddress(msg.from, 'from');
    if (!canSend(from)) {
      throw new Error(`invalid from address ${JSON.stringify(msg.from)}: rooms and @all cannot send`);
    }
    requireAddress(msg.to, 'to');
    if (typeof msg.body !== 'string' || msg.body.length === 0) {
      throw new Error('message body must be a non-empty string');
    }
    const kind: MessageKind = msg.kind ?? 'chat';
    if (!MESSAGE_KINDS.includes(kind)) throw new Error(`unknown message kind ${JSON.stringify(kind)}`);
    if (msg.replyTo != null && (!Number.isInteger(msg.replyTo) || msg.replyTo < 1)) {
      throw new Error('replyTo must be a positive message id');
    }
    if (msg.dispatchId != null && (!Number.isInteger(msg.dispatchId) || msg.dispatchId < 1)) {
      throw new Error('dispatchId must be a positive integer ledger row id');
    }
    if (msg.issue != null && (typeof msg.issue !== 'string' || msg.issue.length === 0 || msg.issue.length > 64)) {
      throw new Error('issue must be a non-empty string (max 64 chars)');
    }
    if (msg.thread != null && (typeof msg.thread !== 'string' || msg.thread.length === 0 || msg.thread.length > 128)) {
      throw new Error('thread must be a non-empty string (max 128 chars)');
    }

    let tier: Tier = 'agent-message';
    let verified = false;
    let dispatchId = msg.dispatchId ?? null;
    let metaObj: Record<string, unknown> | null = null;
    if (msg.meta != null) {
      if (typeof msg.meta !== 'object' || Array.isArray(msg.meta)) throw new Error('meta must be a plain object');
      metaObj = Object.fromEntries(Object.entries(msg.meta).filter(([k]) => !RESERVED_META_KEYS.includes(k)));
    }
    if (decision !== undefined) {
      if (!isSealed(decision)) {
        throw new Error('tier decisions must come from the broker (decideTier); this one is not sealed');
      }
      if (decision.from !== msg.from || decision.to !== msg.to) {
        throw new Error(`tier decision is for ${decision.from}→${decision.to}, not ${msg.from}→${msg.to}`);
      }
      if (!TIERS.includes(decision.tier)) throw new Error(`unknown tier ${JSON.stringify(decision.tier)}`);
      const privileged = PRIVILEGED_TIERS.includes(decision.tier);
      if (privileged !== (decision.verified === true)) {
        throw new Error(`inconsistent tier decision: ${decision.tier} with verified=${String(decision.verified)}`);
      }
      if (decision.tier === 'operator' && from.kind !== 'operator') {
        throw new Error(`operator tier requires the operator sender address, not ${msg.from}`);
      }
      tier = decision.tier;
      verified = decision.verified === true;
      // The verifier's dispatch anchor is authoritative; a caller value may only agree with it.
      if (decision.dispatchId != null) {
        if (dispatchId != null && dispatchId !== decision.dispatchId) {
          throw new Error(`dispatchId ${dispatchId} contradicts the verified lineage (#${decision.dispatchId})`);
        }
        dispatchId = decision.dispatchId;
      }
      const m = metaObj ?? {};
      m.tierCode = decision.code;
      m.tierReason = decision.reason;
      if (decision.evidence) m.lineage = decision.evidence;
      if (decision.requestedTier) m.requestedTier = decision.requestedTier;
      if (decision.downgradedFrom) m.downgradedFrom = decision.downgradedFrom;
      return this.insert(msg, from, kind, tier, verified, dispatchId, m);
    }
    return this.insert(msg, from, kind, tier, verified, dispatchId, metaObj);
  }

  private insert(
    msg: NewMessage, from: ReturnType<typeof requireAddress>, kind: MessageKind, tier: Tier,
    verified: boolean, dispatchId: number | null, metaObj: Record<string, unknown> | null,
  ): MessageRecord {
    const meta = metaObj == null ? null : JSON.stringify(metaObj);
    const ts = this.now();

    let id: number;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (from.kind === 'child') {
        if (this.participant(from.raw)?.kind !== 'child') {
          throw new Error(
            `unknown child address ${JSON.stringify(from.raw)}: children must be minted by their ` +
            'parent via mintChild() before they can send',
          );
        }
        this.touch(from.raw, ts);
      } else {
        this.upsertParticipant(from.raw, from.kind === 'operator' ? 'operator' : 'agent', null, ts);
      }
      if (msg.replyTo != null && !this.db.prepare('SELECT 1 FROM messages WHERE id = ?').get(msg.replyTo)) {
        throw new Error(`replyTo ${msg.replyTo} does not exist (the log is append-only — a dangling reply would be permanent)`);
      }
      const info = this.db.prepare(`
        INSERT INTO messages (ts, sender, target, kind, tier, verified, body, reply_to, issue, thread, dispatch_id, meta)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        ts, msg.from, msg.to, kind, tier, verified ? 1 : 0, msg.body,
        msg.replyTo ?? null, msg.issue ?? null, msg.thread ?? null, dispatchId, meta,
      );
      id = Number(info.lastInsertRowid);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    // Read back only after the transaction is fully committed — never inside the ROLLBACK guard.
    const rec = this.get(id);
    if (!rec) throw new Error('append committed but the row could not be read back');
    return rec;
  }

  // ---------------------------------------------------------------- reader

  get(id: number): MessageRecord | null {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Row | undefined;
    return row ? toRecord(row) : null;
  }

  /** Highest message id so far (0 when empty) — the natural "since" cursor to start from. */
  latestId(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM messages').get() as { id: number };
    return Number(row.id);
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number };
    return Number(row.n);
  }

  /**
   * Read a slice of the log, oldest first. `scope` picks the conversation (room, DM pair, an
   * address's inbox, or everything); `since*` are exclusive cursors. Page by passing the last
   * returned id back as `sinceId`.
   */
  transcript(scope: TranscriptScope, q: TranscriptQuery = {}): MessageRecord[] {
    const where: string[] = [];
    const params: (string | number)[] = [];

    if ('room' in scope) {
      const room = requireAddress(scope.room, 'to');
      if (room.kind !== 'room') throw new Error(`transcript scope.room must be a #room, got ${JSON.stringify(scope.room)}`);
      where.push('target = ?');
      params.push(scope.room);
    } else if ('pair' in scope) {
      const [a, b] = scope.pair;
      if (!canSend(requireAddress(a, 'from')) || !canSend(requireAddress(b, 'to'))) {
        throw new Error('transcript scope.pair must name two agent/child/operator addresses (a DM thread — rooms and @all are not peers)');
      }
      where.push('((sender = ? AND target = ?) OR (sender = ? AND target = ?))');
      params.push(a, b, b, a);
    } else if ('inbox' in scope) {
      const me = requireAddress(scope.inbox, 'to');
      if (!canSend(me)) throw new Error(`transcript scope.inbox must be an agent/child/operator address`);
      where.push('(target = ? OR target = ?)');
      params.push(scope.inbox, BROADCAST);
    } else if (!('all' in scope) || scope.all !== true) {
      throw new Error('transcript scope must be one of { room }, { pair }, { inbox }, { all: true }');
    }

    if (q.sinceId != null) {
      if (!Number.isInteger(q.sinceId) || q.sinceId < 0) throw new Error('sinceId must be a non-negative integer');
      where.push('id > ?');
      params.push(q.sinceId);
    }
    if (q.sinceTs != null) {
      if (typeof q.sinceTs !== 'string' || Number.isNaN(Date.parse(q.sinceTs))) {
        throw new Error('sinceTs must be an ISO-8601 timestamp');
      }
      // Compare instants, not spellings: stored ts are canonical UTC "Z" strings, so canonicalise
      // the cursor the same way (an offset form like +02:00 would otherwise sort lexically).
      where.push('ts > ?');
      params.push(new Date(q.sinceTs).toISOString());
    }
    if (q.thread != null) {
      if (typeof q.thread !== 'string' || q.thread.length === 0) throw new Error('thread must be a non-empty string');
      where.push('thread = ?');
      params.push(q.thread);
    }
    const limit = q.limit ?? 200;
    if (!Number.isInteger(limit) || limit <= 0) throw new Error('limit must be a positive integer');
    params.push(limit);

    const sql = `SELECT * FROM messages ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id ASC LIMIT ?`;
    return (this.db.prepare(sql).all(...params) as unknown as Row[]).map(toRecord);
  }

  // ---------------------------------------------------------------- participants

  /** Register (or refresh) a fleet agent or the operator. Children are minted, not registered. */
  register(input: RegisterInput): Participant {
    const parsed = requireAddress(input.address, 'from');
    if (parsed.kind !== 'agent' && parsed.kind !== 'operator') {
      throw new Error(
        `register() takes a fleet agent or "operator" address, got ${JSON.stringify(input.address)}` +
        (parsed.kind === 'child' ? ' — children are minted via mintChild()' : ''),
      );
    }
    const ts = this.now();
    this.upsertParticipant(parsed.raw, parsed.kind, input.label ?? null, ts);
    return this.participant(parsed.raw)!;
  }

  /**
   * Mint the next child address for `parent` ("K" → "K.1", "K.2", …) and record its lineage.
   * The parent must be a fleet agent (children are one level deep — workers don't dispatch
   * workers). This row is what later proves the parent's authority over the child.
   */
  mintChild(parent: string, input: MintChildInput = {}): Participant {
    const p = requireAddress(parent, 'from');
    if (p.kind !== 'agent') {
      throw new Error(
        `mintChild(): parent must be a fleet agent address, got ${JSON.stringify(parent)}` +
        (p.kind === 'child' ? ' — children cannot mint children (depth 1)' : ''),
      );
    }
    if (input.dispatchId != null && (!Number.isInteger(input.dispatchId) || input.dispatchId < 1)) {
      throw new Error('dispatchId must be a positive integer ledger row id');
    }
    const ts = this.now();
    let minted: string;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.upsertParticipant(p.raw, 'agent', null, ts);
      const row = this.db.prepare(
        'SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM participants WHERE parent = ?',
      ).get(p.raw) as { seq: number };
      const seq = Number(row.seq);
      const address = childAddress(p.raw, seq);
      if (input.dispatchId != null) {
        const taken = this.db.prepare('SELECT address FROM participants WHERE dispatch_id = ?')
          .get(input.dispatchId) as { address: string } | undefined;
        if (taken) throw new Error(`dispatch #${input.dispatchId} is already bound to child ${taken.address}`);
      }
      this.db.prepare(`
        INSERT INTO participants (address, kind, parent, seq, dispatch_id, label, first_seen, last_seen)
        VALUES (?, 'child', ?, ?, ?, ?, ?, ?)
      `).run(address, p.raw, seq, input.dispatchId ?? null, input.label ?? null, ts, ts);
      this.db.exec('COMMIT');
      minted = address;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return this.participant(minted)!;
  }

  participant(address: string): Participant | null {
    const row = this.db.prepare('SELECT * FROM participants WHERE address = ?').get(address) as PRow | undefined;
    return row ? toParticipant(row) : null;
  }

  /** All participants, optionally only the children of one parent. */
  participants(filter: { parent?: string } = {}): Participant[] {
    const rows = filter.parent != null
      ? this.db.prepare('SELECT * FROM participants WHERE parent = ? ORDER BY seq ASC').all(filter.parent)
      : this.db.prepare('SELECT * FROM participants ORDER BY first_seen ASC, address ASC').all();
    return (rows as unknown as PRow[]).map(toParticipant);
  }

  // ---------------------------------------------------------------- deliveries

  /** Record one typed delivery outcome (sent / held / released / refused / failed / logged). */
  recordDelivery(ev: NewDeliveryEvent): DeliveryEvent {
    if (!DELIVERY_OUTCOMES.includes(ev.outcome)) throw new Error(`unknown delivery outcome ${JSON.stringify(ev.outcome)}`);
    if (typeof ev.code !== 'string' || !/^[a-z0-9-]{1,64}$/.test(ev.code)) throw new Error('delivery code must be a short kebab-case token');
    if (ev.messageId != null && (!Number.isInteger(ev.messageId) || ev.messageId < 1)) throw new Error('messageId must be a positive id');
    const attempt = ev.attempt ?? 1;
    if (!Number.isInteger(attempt) || attempt < 1) throw new Error('attempt must be a positive integer');
    const info = this.db.prepare(`
      INSERT INTO deliveries (ts, message_id, sender, target, outcome, code, reason, transport, attempt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(this.now(), ev.messageId ?? null, ev.from, ev.to, ev.outcome, ev.code, ev.reason ?? null, ev.transport ?? null, attempt);
    return this.delivery(Number(info.lastInsertRowid))!;
  }

  delivery(id: number): DeliveryEvent | null {
    const row = this.db.prepare('SELECT * FROM deliveries WHERE id = ?').get(id) as unknown as DRow | undefined;
    return row ? toDelivery(row) : null;
  }

  /** Delivery events, oldest first; filter by message, target or sender; `sinceId` exclusive. */
  deliveries(filter: { messageId?: number; target?: string; sender?: string; sinceId?: number; limit?: number } = {}): DeliveryEvent[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.messageId != null) { where.push('message_id = ?'); params.push(filter.messageId); }
    if (filter.target != null) { where.push('target = ?'); params.push(filter.target); }
    if (filter.sender != null) { where.push('sender = ?'); params.push(filter.sender); }
    if (filter.sinceId != null) { where.push('id > ?'); params.push(filter.sinceId); }
    const limit = filter.limit ?? 200;
    if (!Number.isInteger(limit) || limit <= 0) throw new Error('limit must be a positive integer');
    params.push(limit);
    const sql = `SELECT * FROM deliveries ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id ASC LIMIT ?`;
    return (this.db.prepare(sql).all(...params) as unknown as DRow[]).map(toDelivery);
  }

  /** Idempotent: closing twice is a no-op, so teardown paths can call it defensively. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  // ---------------------------------------------------------------- internals

  private upsertParticipant(address: string, kind: ParticipantKind, label: string | null, ts: string): void {
    this.db.prepare(`
      INSERT INTO participants (address, kind, parent, seq, dispatch_id, label, first_seen, last_seen)
      VALUES (?, ?, NULL, NULL, NULL, ?, ?, ?)
      ON CONFLICT(address) DO UPDATE SET
        last_seen = excluded.last_seen,
        label = COALESCE(excluded.label, participants.label)
    `).run(address, kind, label, ts, ts);
  }

  private touch(address: string, ts: string): void {
    this.db.prepare('UPDATE participants SET last_seen = ? WHERE address = ?').run(ts, address);
  }
}

// ------------------------------------------------------------------ row mapping

interface Row {
  id: number; ts: string; sender: string; target: string; kind: string; tier: string;
  verified: number; body: string; reply_to: number | null; issue: string | null; thread: string | null;
  dispatch_id: number | null; meta: string | null;
}

interface DRow {
  id: number; ts: string; message_id: number | null; sender: string; target: string; outcome: string;
  code: string; reason: string | null; transport: string | null; attempt: number;
}

function toDelivery(r: DRow): DeliveryEvent {
  return {
    id: Number(r.id), ts: r.ts, messageId: r.message_id == null ? null : Number(r.message_id),
    from: r.sender, to: r.target, outcome: r.outcome as DeliveryOutcome, code: r.code, reason: r.reason,
    transport: r.transport, attempt: Number(r.attempt),
  };
}

interface PRow {
  address: string; kind: string; parent: string | null; seq: number | null;
  dispatch_id: number | null; label: string | null; first_seen: string; last_seen: string;
}

function toRecord(r: Row): MessageRecord {
  let meta: Record<string, unknown> | null = null;
  if (r.meta != null) {
    try { meta = JSON.parse(r.meta) as Record<string, unknown>; } catch { meta = { _unparsable: r.meta }; }
  }
  return {
    id: Number(r.id), ts: r.ts, from: r.sender, to: r.target,
    kind: r.kind as MessageKind, tier: r.tier as Tier, verified: r.verified === 1,
    body: r.body, replyTo: r.reply_to == null ? null : Number(r.reply_to),
    issue: r.issue, thread: r.thread ?? null, dispatchId: r.dispatch_id == null ? null : Number(r.dispatch_id), meta,
  };
}

function toParticipant(r: PRow): Participant {
  return {
    address: r.address, kind: r.kind as ParticipantKind, parent: r.parent,
    seq: r.seq == null ? null : Number(r.seq),
    dispatchId: r.dispatch_id == null ? null : Number(r.dispatch_id),
    label: r.label, firstSeen: r.first_seen, lastSeen: r.last_seen,
  };
}

/** Re-exported for callers that want to sanity-check an address without a DB. */
export { parseAddress };
