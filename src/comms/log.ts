import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import {
  MESSAGE_KINDS, PRIVILEGED_TIERS, TIERS,
  type MessageKind, type MessageRecord, type NewMessage, type Participant, type ParticipantKind,
  type Tier, type TranscriptQuery, type TranscriptScope,
} from './types.js';
import { BROADCAST, canSend, childAddress, parseAddress, requireAddress } from './address.js';

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
 * layer verify "K really is K.2's dispatching orchestrator" (HED-5).
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

-- Append-only, enforced by the database: no process, however well-meaning, rewrites history.
CREATE TRIGGER IF NOT EXISTS messages_append_only_update BEFORE UPDATE ON messages
BEGIN SELECT RAISE(ABORT, 'comms log is append-only: UPDATE refused'); END;
CREATE TRIGGER IF NOT EXISTS messages_append_only_delete BEFORE DELETE ON messages
BEGIN SELECT RAISE(ABORT, 'comms log is append-only: DELETE refused'); END;

CREATE TABLE IF NOT EXISTS participants (
  address     TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  parent      TEXT,
  seq         INTEGER,
  dispatch_id INTEGER,
  label       TEXT,
  first_seen  TEXT NOT NULL,
  last_seen   TEXT NOT NULL,
  CHECK (kind IN ('agent', 'child', 'operator')),
  UNIQUE (parent, seq)
);
CREATE INDEX IF NOT EXISTS idx_participants_parent ON participants(parent, seq);
`;

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

  constructor(path: string = DEFAULT_COMMS_PATH, opts: CommsLogOptions = {}) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    // WAL + a busy timeout: many agent processes share this file and write concurrently.
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
    this.db.exec(`PRAGMA user_version = ${COMMS_SCHEMA_VERSION};`);
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  // ---------------------------------------------------------------- writer

  /**
   * Append one message. Validates addresses/kind/tier, registers a first-time agent/operator
   * sender, refuses unminted children (their lineage would be fiction), and returns the row.
   * The tier is whatever the caller (the envelope layer) decided — a privileged tier (operator,
   * orchestrator-directive) must arrive with `verified: true`, and agent-message must not, or it
   * is refused here AND by the DB CHECK constraint.
   */
  append(msg: NewMessage): MessageRecord {
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
    const tier: Tier = msg.tier ?? 'agent-message';
    if (!TIERS.includes(tier)) throw new Error(`unknown tier ${JSON.stringify(tier)}`);
    const verified = msg.verified === true;
    if (PRIVILEGED_TIERS.includes(tier) && !verified) {
      throw new Error(`tier "${tier}" must be verified by the broker; senders cannot self-assign it`);
    }
    if (!PRIVILEGED_TIERS.includes(tier) && verified) {
      throw new Error('an agent-message cannot be marked verified');
    }
    if (msg.replyTo != null && !Number.isInteger(msg.replyTo)) {
      throw new Error('replyTo must be a message id');
    }
    const meta = msg.meta == null ? null : JSON.stringify(msg.meta);
    const ts = this.now();

    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (from.kind === 'child') {
        if (!this.participant(from.raw)) {
          throw new Error(
            `unknown child address ${JSON.stringify(from.raw)}: children must be minted by their ` +
            'parent via mintChild() before they can send',
          );
        }
        this.touch(from.raw, ts);
      } else {
        this.upsertParticipant(from.raw, from.kind === 'operator' ? 'operator' : 'agent', null, ts);
      }
      const info = this.db.prepare(`
        INSERT INTO messages (ts, sender, target, kind, tier, verified, body, reply_to, issue, dispatch_id, meta)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        ts, msg.from, msg.to, kind, tier, verified ? 1 : 0, msg.body,
        msg.replyTo ?? null, msg.issue ?? null, msg.dispatchId ?? null, meta,
      );
      this.db.exec('COMMIT');
      const rec = this.get(Number(info.lastInsertRowid));
      if (!rec) throw new Error('append succeeded but the row could not be read back');
      return rec;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
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
      requireAddress(a, 'from');
      requireAddress(b, 'to');
      where.push('((sender = ? AND target = ?) OR (sender = ? AND target = ?))');
      params.push(a, b, b, a);
    } else if ('inbox' in scope) {
      const me = requireAddress(scope.inbox, 'to');
      if (!canSend(me)) throw new Error(`transcript scope.inbox must be an agent/child/operator address`);
      where.push('(target = ? OR target = ?)');
      params.push(scope.inbox, BROADCAST);
    } else if (!('all' in scope)) {
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
      where.push('ts > ?');
      params.push(q.sinceTs);
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
    if (input.dispatchId != null && !Number.isInteger(input.dispatchId)) {
      throw new Error('dispatchId must be an integer ledger row id');
    }
    const ts = this.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.upsertParticipant(p.raw, 'agent', null, ts);
      const row = this.db.prepare(
        'SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM participants WHERE parent = ?',
      ).get(p.raw) as { seq: number };
      const seq = Number(row.seq);
      const address = childAddress(p.raw, seq);
      this.db.prepare(`
        INSERT INTO participants (address, kind, parent, seq, dispatch_id, label, first_seen, last_seen)
        VALUES (?, 'child', ?, ?, ?, ?, ?, ?)
      `).run(address, p.raw, seq, input.dispatchId ?? null, input.label ?? null, ts, ts);
      this.db.exec('COMMIT');
      return this.participant(address)!;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
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

  close(): void {
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
  verified: number; body: string; reply_to: number | null; issue: string | null;
  dispatch_id: number | null; meta: string | null;
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
    issue: r.issue, dispatchId: r.dispatch_id == null ? null : Number(r.dispatch_id), meta,
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
