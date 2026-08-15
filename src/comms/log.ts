import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import {
  DELIVERY_OUTCOMES, MESSAGE_KINDS, PARTICIPANT_KINDS, PRIVILEGED_TIERS, TIERS,
  type DeliveryEvent, type DeliveryOutcome, type MessageKind, type MessageRecord, type NewDeliveryEvent,
  type NewMessage, type Participant, type ParticipantKind, type Tier, type TierDecision,
  type TranscriptQuery, type TranscriptScope,
} from './types.js';
import { BROADCAST, canSend, childAddress, parseAddress, requireAddress, type ParsedAddress } from './address.js';
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

const sqlList = (xs: readonly string[]) => xs.map((x) => `'${x.replace(/'/g, "''")}'`).join(', ');

// The SQL enums are generated from the TypeScript lists so the two cannot drift.
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
  CHECK (tier IN (${sqlList(TIERS)})),
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
  CHECK (outcome IN (${sqlList(DELIVERY_OUTCOMES)}))
);
CREATE INDEX IF NOT EXISTS idx_deliveries_message ON deliveries(message_id, id);
CREATE INDEX IF NOT EXISTS idx_deliveries_target  ON deliveries(target, id);
CREATE INDEX IF NOT EXISTS idx_deliveries_sender  ON deliveries(sender, id);
CREATE TRIGGER IF NOT EXISTS deliveries_append_only_update BEFORE UPDATE ON deliveries
BEGIN SELECT RAISE(ABORT, 'delivery log is append-only: UPDATE refused'); END;
CREATE TRIGGER IF NOT EXISTS deliveries_append_only_delete BEFORE DELETE ON deliveries
BEGIN SELECT RAISE(ABORT, 'delivery log is append-only: DELETE refused'); END;

-- Live comms sessions: which participant addresses currently have a channel server attached
-- (presence, mutable — heartbeat). The bridge consults this to decide "queued for the recipient's
-- channel" vs "no live session; the recipient must pull". One live session per address.
CREATE TABLE IF NOT EXISTS sessions (
  address      TEXT PRIMARY KEY,
  session_id   TEXT,
  session_name TEXT,
  pid          INTEGER,
  socket       TEXT,
  started_at   TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL
);

-- Rooms (SPEC §9): membership is owned by humans / orchestrator config, never self-joined by
-- workers; open rooms (#fleet) accept posts from any registered participant. The floor is a
-- short lease so a multi-part reply is not interleaved — and a crashed holder cannot lock a room.
CREATE TABLE IF NOT EXISTS rooms (
  name       TEXT PRIMARY KEY,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  topic      TEXT,
  open       INTEGER NOT NULL DEFAULT 0,
  CHECK (open IN (0, 1))
);
CREATE TABLE IF NOT EXISTS room_members (
  room     TEXT NOT NULL REFERENCES rooms(name),
  address  TEXT NOT NULL,
  added_by TEXT NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (room, address)
);
CREATE TABLE IF NOT EXISTS room_floor (
  room       TEXT PRIMARY KEY REFERENCES rooms(name),
  holder     TEXT NOT NULL,
  since      TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS participants (
  address     TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  parent      TEXT REFERENCES participants(address),
  seq         INTEGER,
  dispatch_id INTEGER,
  label       TEXT,
  first_seen  TEXT NOT NULL,
  last_seen   TEXT NOT NULL,
  CHECK (kind IN (${sqlList(PARTICIPANT_KINDS)})),
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

/** A session whose heartbeat is older than this is treated as gone. */
export const DEFAULT_SESSION_STALE_MS = 90_000;

export interface SessionInput {
  address: string;
  sessionId?: string | null;
  /** The name SendMessage/ListAgents know the session by (fleet convention: the fleet id). */
  sessionName?: string | null;
  pid?: number | null;
  /** The session's inbox socket path (uds:…), when Claude Code exported one. */
  socket?: string | null;
}

export interface SessionRecord {
  address: string;
  sessionId: string | null;
  sessionName: string | null;
  pid: number | null;
  socket: string | null;
  startedAt: string;
  heartbeatAt: string;
}

export const DEFAULT_ROOM = '#fleet';
export const DEFAULT_FLOOR_LEASE_MS = 60_000;
/** Nobody can lock a room for longer than this in one lease (renewals extend from `now`). */
export const MAX_FLOOR_LEASE_MS = 10 * 60_000;

export interface RoomRecord {
  name: string;
  createdBy: string;
  createdAt: string;
  topic: string | null;
  /** Any registered participant may post (#fleet); closed rooms are members-only. */
  open: boolean;
}

export interface RoomMember {
  room: string;
  address: string;
  addedBy: string;
  addedAt: string;
}

export interface FloorRecord {
  room: string;
  holder: string;
  since: string;
  expiresAt: string;
}

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
    const from = validateNewMessage(msg);
    const kind: MessageKind = msg.kind ?? 'chat';
    const meta = scrubCallerMeta(msg.meta);
    if (decision === undefined) {
      return this.insert(msg, from, kind, 'agent-message', false, msg.dispatchId ?? null, meta);
    }
    const applied = applyDecision(msg, from, decision, meta);
    return this.insert(msg, from, kind, applied.tier, applied.verified, applied.dispatchId, applied.meta);
  }

  private insert(
    msg: NewMessage, from: ParsedAddress, kind: MessageKind, tier: Tier,
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
    scopeClause(scope, where, params);
    cursorClauses(q, where, params);
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

  /** Participants whose address starts with `prefix`, sorted — the resolver's lookup (no full scan). */
  participantsWithPrefix(prefix: string): Participant[] {
    if (typeof prefix !== 'string' || prefix.length === 0) return [];
    // Range seek on the primary key (prefix ≤ address < prefix + max char) — indexed, no scan.
    const rows = this.db.prepare('SELECT * FROM participants WHERE address >= ? AND address < ? ORDER BY address')
      .all(prefix, prefix + '\uffff');
    return (rows as unknown as PRow[]).map(toParticipant);
  }

  /** All participants, optionally only the children of one parent. */
  participants(filter: { parent?: string } = {}): Participant[] {
    const rows = filter.parent != null
      ? this.db.prepare('SELECT * FROM participants WHERE parent = ? ORDER BY seq ASC').all(filter.parent)
      : this.db.prepare('SELECT * FROM participants ORDER BY first_seen ASC, address ASC').all();
    return (rows as unknown as PRow[]).map(toParticipant);
  }

  // ---------------------------------------------------------------- rooms

  /** Create a room (idempotent for the same name — returns the existing one). Governance is the broker's job. */
  createRoom(input: { name: string; by: string; topic?: string | null; open?: boolean }): RoomRecord {
    const parsed = requireAddress(input.name, 'to');
    if (parsed.kind !== 'room') throw new Error(`rooms are #names, got ${JSON.stringify(input.name)}`);
    if (!canSend(requireAddress(input.by, 'from'))) throw new Error('a room is created by an agent or the operator');
    const ts = this.now();
    // Concurrency-safe idempotency: two servers starting on a fresh shared db both "create" #fleet.
    this.db.prepare('INSERT INTO rooms (name, created_by, created_at, topic, open) VALUES (?, ?, ?, ?, ?) ON CONFLICT(name) DO NOTHING')
      .run(input.name, input.by, ts, input.topic ?? null, input.open ? 1 : 0);
    return this.room(input.name)!;
  }

  /** The default rooms every deployment has (#fleet, open). Safe to call at every startup. */
  ensureDefaultRooms(by = 'operator'): RoomRecord[] {
    return [this.createRoom({ name: DEFAULT_ROOM, by, topic: 'the whole fleet — announcements, open questions, cross-lane coordination', open: true })];
  }

  room(name: string): RoomRecord | null {
    const row = this.db.prepare('SELECT * FROM rooms WHERE name = ?').get(name) as unknown as RRow | undefined;
    return row ? toRoom(row) : null;
  }

  rooms(): RoomRecord[] {
    return (this.db.prepare('SELECT * FROM rooms ORDER BY name').all() as unknown as RRow[]).map(toRoom);
  }

  addMember(input: { room: string; address: string; by: string }): RoomMember {
    if (!this.room(input.room)) throw new Error(`no such room ${input.room}`);
    if (!canSend(requireAddress(input.address, 'to'))) throw new Error('members are agents, children or the operator');
    requireAddress(input.by, 'from');
    const ts = this.now();
    this.db.prepare(`
      INSERT INTO room_members (room, address, added_by, added_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(room, address) DO NOTHING
    `).run(input.room, input.address, input.by, ts);
    return this.member(input.room, input.address)!;
  }

  removeMember(room: string, address: string): boolean {
    const info = this.db.prepare('DELETE FROM room_members WHERE room = ? AND address = ?').run(room, address);
    return Number(info.changes) > 0;
  }

  member(room: string, address: string): RoomMember | null {
    const row = this.db.prepare('SELECT * FROM room_members WHERE room = ? AND address = ?').get(room, address) as unknown as MRow | undefined;
    return row ? toMember(row) : null;
  }

  members(room: string): RoomMember[] {
    return (this.db.prepare('SELECT * FROM room_members WHERE room = ? ORDER BY added_at, address').all(room) as unknown as MRow[]).map(toMember);
  }

  /** Rooms `address` may post to: open rooms plus the closed ones it is a member of (operator: all). */
  roomsFor(address: string): RoomRecord[] {
    if (address === 'operator') return this.rooms();
    return (this.db.prepare(`
      SELECT r.* FROM rooms r WHERE r.open = 1 OR EXISTS (SELECT 1 FROM room_members m WHERE m.room = r.name AND m.address = ?)
      ORDER BY r.name
    `).all(address) as unknown as RRow[]).map(toRoom);
  }

  /** Current floor holder of a room, if the lease has not expired. */
  floor(room: string): FloorRecord | null {
    const row = this.db.prepare('SELECT * FROM room_floor WHERE room = ?').get(room) as unknown as FRow | undefined;
    if (!row) return null;
    const f = toFloor(row);
    return Date.parse(f.expiresAt) > Date.parse(this.now()) ? f : null;
  }

  /**
   * Take (or renew) the floor of a room. Succeeds when the floor is free, expired, or already
   * held by `holder`; returns null when another holder's lease is live (caller reads `floor()`).
   */
  acquireFloor(room: string, holder: string, leaseMs = DEFAULT_FLOOR_LEASE_MS): FloorRecord | null {
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error('leaseMs must be a positive number');
    if (leaseMs > MAX_FLOOR_LEASE_MS) throw new Error(`leaseMs must be at most ${MAX_FLOOR_LEASE_MS} ms`);
    if (!this.room(room)) throw new Error(`no such room ${room}`);
    const now = this.now();
    let out: FloorRecord | null = null;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.floor(room);
      if (current && current.holder !== holder) { this.db.exec('COMMIT'); return null; }
      // A renewal never shortens a longer lease the holder already has.
      const proposed = Date.parse(now) + leaseMs;
      const expires = new Date(current && current.holder === holder ? Math.max(proposed, Date.parse(current.expiresAt)) : proposed).toISOString();
      this.db.prepare(`
        INSERT INTO room_floor (room, holder, since, expires_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(room) DO UPDATE SET holder = excluded.holder, since = CASE WHEN room_floor.holder = excluded.holder THEN room_floor.since ELSE excluded.since END, expires_at = excluded.expires_at
      `).run(room, holder, now, expires);
      this.db.exec('COMMIT');
      out = this.floor(room);
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return out;
  }

  /** Release the floor if `holder` holds it. Returns whether anything was released. */
  releaseFloor(room: string, holder: string): boolean {
    const info = this.db.prepare('DELETE FROM room_floor WHERE room = ? AND holder = ?').run(room, holder);
    return Number(info.changes) > 0;
  }

  // ---------------------------------------------------------------- sessions (presence)

  /** Announce that a channel server is attached for `address` (upsert; refreshes the heartbeat). */
  registerSession(input: SessionInput): SessionRecord {
    const parsed = requireAddress(input.address, 'from');
    if (!canSend(parsed)) throw new Error(`sessions are for agent/child/operator addresses, got ${JSON.stringify(input.address)}`);
    const ts = this.now();
    this.db.prepare(`
      INSERT INTO sessions (address, session_id, session_name, pid, socket, started_at, heartbeat_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(address) DO UPDATE SET
        session_id = excluded.session_id, session_name = excluded.session_name, pid = excluded.pid,
        socket = excluded.socket, started_at = excluded.started_at, heartbeat_at = excluded.heartbeat_at
    `).run(input.address, input.sessionId ?? null, input.sessionName ?? null, input.pid ?? null, input.socket ?? null, ts, ts);
    return this.session(input.address)!;
  }

  heartbeatSession(address: string): void {
    this.db.prepare('UPDATE sessions SET heartbeat_at = ? WHERE address = ?').run(this.now(), address);
  }

  unregisterSession(address: string): void {
    this.db.prepare('DELETE FROM sessions WHERE address = ?').run(address);
  }

  session(address: string): SessionRecord | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE address = ?').get(address) as unknown as SRow | undefined;
    return row ? toSession(row) : null;
  }

  /** The session for `address` if its heartbeat is fresher than `staleMs`, else null. */
  liveSession(address: string, staleMs = DEFAULT_SESSION_STALE_MS): SessionRecord | null {
    requireStaleMs(staleMs);
    const s = this.session(address);
    if (!s) return null;
    return Date.parse(this.now()) - Date.parse(s.heartbeatAt) <= staleMs ? s : null;
  }

  liveSessions(staleMs = DEFAULT_SESSION_STALE_MS): SessionRecord[] {
    requireStaleMs(staleMs);
    const cutoff = new Date(Date.parse(this.now()) - staleMs).toISOString();
    return (this.db.prepare('SELECT * FROM sessions WHERE heartbeat_at >= ? ORDER BY address').all(cutoff) as unknown as SRow[]).map(toSession);
  }

  // ---------------------------------------------------------------- deliveries

  /** Record one typed delivery outcome (sent / held / released / refused / failed / logged). */
  recordDelivery(ev: NewDeliveryEvent): DeliveryEvent {
    const attempt = validateDeliveryEvent(ev);
    if (ev.messageId != null && !this.db.prepare('SELECT 1 FROM messages WHERE id = ?').get(ev.messageId)) {
      throw new Error(`delivery for message ${ev.messageId}, which does not exist`);
    }
    const info = this.db.prepare(`
      INSERT INTO deliveries (ts, message_id, sender, target, outcome, code, reason, transport, attempt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(this.now(), ev.messageId ?? null, ev.from, ev.to, ev.outcome, ev.code, ev.reason ?? null, ev.transport ?? null, attempt);
    return this.delivery(Number(info.lastInsertRowid))!;
  }

  /**
   * Holds still owed a release or a timeout: `held` events with no later resolving event for the
   * same (message, target) — resolving = `released`, `sent`, `logged` (broadcast → inbox), or
   * `failed`/`hold-timeout`. (A later `failed` with another code is a transient transport failure:
   * the entry is still held.)
   */
  openHolds(): DeliveryEvent[] {
    const rows = this.db.prepare(`
      SELECT d.* FROM deliveries d
      WHERE d.outcome = 'held' AND NOT EXISTS (
        SELECT 1 FROM deliveries e
        WHERE e.message_id = d.message_id AND e.target = d.target AND e.id > d.id
          AND (e.outcome IN ('released', 'sent', 'logged') OR (e.outcome = 'failed' AND e.code = 'hold-timeout'))
      )
      ORDER BY d.id ASC
    `).all();
    return (rows as unknown as DRow[]).map(toDelivery);
  }

  /** The highest message id this identity's channel has written (`sent`/`channel-written`), or null. */
  lastChannelWrite(address: string): number | null {
    const row = this.db.prepare(
      "SELECT MAX(message_id) AS id FROM deliveries WHERE target = ? AND transport = 'channel' AND outcome = 'sent'",
    ).get(address) as { id: number | null };
    return row.id == null ? null : Number(row.id);
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

function requireStaleMs(v: number): void {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error('staleMs must be a finite, non-negative number of milliseconds');
}

// ------------------------------------------------------------------ delivery helpers

/** Shape + invariant checks for a delivery event; returns the attempt number to store. */
function validateDeliveryEvent(ev: NewDeliveryEvent): number {
  if (!DELIVERY_OUTCOMES.includes(ev.outcome)) throw new Error(`unknown delivery outcome ${JSON.stringify(ev.outcome)}`);
  if (typeof ev.code !== 'string' || !/^[a-z0-9-]{1,64}$/.test(ev.code)) throw new Error('delivery code must be a short kebab-case token');
  if (ev.messageId != null && (!Number.isInteger(ev.messageId) || ev.messageId < 1)) throw new Error('messageId must be a positive id');
  const attempt = ev.attempt ?? 1;
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error('attempt must be a positive integer');
  // Invariants: a refusal never has a message row (nothing was accepted); every other outcome is
  // ABOUT an existing message.
  if (ev.outcome === 'refused' && ev.messageId != null) throw new Error('a refused delivery cannot reference a message (nothing was accepted)');
  if (ev.outcome !== 'refused' && ev.messageId == null) throw new Error(`a ${ev.outcome} delivery must reference the message it is about`);
  return attempt;
}

// ------------------------------------------------------------------ transcript helpers

function scopeClause(scope: TranscriptScope, where: string[], params: (string | number)[]): void {
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
    if (!canSend(requireAddress(scope.inbox, 'to'))) throw new Error('transcript scope.inbox must be an agent/child/operator address');
    where.push('(target = ? OR target = ?)');
    params.push(scope.inbox, BROADCAST);
  } else if (!('all' in scope) || scope.all !== true) {
    throw new Error('transcript scope must be one of { room }, { pair }, { inbox }, { all: true }');
  }
}

function cursorClauses(q: TranscriptQuery, where: string[], params: (string | number)[]): void {
  if (q.sinceId != null) {
    if (!Number.isInteger(q.sinceId) || q.sinceId < 0) throw new Error('sinceId must be a non-negative integer');
    where.push('id > ?');
    params.push(q.sinceId);
  }
  if (q.sinceTs != null) {
    if (typeof q.sinceTs !== 'string' || Number.isNaN(Date.parse(q.sinceTs))) throw new Error('sinceTs must be an ISO-8601 timestamp');
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
}

// ------------------------------------------------------------------ append helpers

/** Shape/grammar checks for a new message; returns the parsed sender. Throws on the first problem. */
function validateNewMessage(msg: NewMessage): ParsedAddress {
  const from = requireAddress(msg.from, 'from');
  if (!canSend(from)) throw new Error(`invalid from address ${JSON.stringify(msg.from)}: rooms and @all cannot send`);
  requireAddress(msg.to, 'to');
  if (typeof msg.body !== 'string' || msg.body.length === 0) throw new Error('message body must be a non-empty string');
  const kind = msg.kind ?? 'chat';
  if (!MESSAGE_KINDS.includes(kind)) throw new Error(`unknown message kind ${JSON.stringify(kind)}`);
  requirePositiveInt(msg.replyTo, 'replyTo must be a positive message id');
  requirePositiveInt(msg.dispatchId, 'dispatchId must be a positive integer ledger row id');
  requireBoundedString(msg.issue, 64, 'issue');
  requireBoundedString(msg.thread, 128, 'thread');
  return from;
}

function requirePositiveInt(v: number | null | undefined, message: string): void {
  if (v != null && (!Number.isInteger(v) || v < 1)) throw new Error(message);
}

function requireBoundedString(v: string | null | undefined, max: number, name: string): void {
  if (v != null && (typeof v !== 'string' || v.length === 0 || v.length > max)) {
    throw new Error(`${name} must be a non-empty string (max ${max} chars)`);
  }
}

/** Caller meta minus the broker-owned keys (those are written only from a sealed decision). */
function scrubCallerMeta(meta: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (meta == null) return null;
  if (typeof meta !== 'object' || Array.isArray(meta)) throw new Error('meta must be a plain object');
  return Object.fromEntries(Object.entries(meta).filter(([k]) => !RESERVED_META_KEYS.includes(k)));
}

/**
 * Check a sealed decision against the message and fold it in: tier/verified from the decision,
 * the verifier's dispatch anchor authoritative, decision facts written into meta.
 */
function applyDecision(
  msg: NewMessage, from: ParsedAddress, decision: TierDecision, meta: Record<string, unknown> | null,
): { tier: Tier; verified: boolean; dispatchId: number | null; meta: Record<string, unknown> } {
  if (!isSealed(decision)) throw new Error('tier decisions must come from the broker (decideTier); this one is not sealed');
  if (decision.from !== msg.from || decision.to !== msg.to) {
    throw new Error(`tier decision is for ${decision.from}→${decision.to}, not ${msg.from}→${msg.to}`);
  }
  if (!TIERS.includes(decision.tier)) throw new Error(`unknown tier ${JSON.stringify(decision.tier)}`);
  const verified = decision.verified === true;
  if (PRIVILEGED_TIERS.includes(decision.tier) !== verified) {
    throw new Error(`inconsistent tier decision: ${decision.tier} with verified=${String(decision.verified)}`);
  }
  if (decision.tier === 'operator' && from.kind !== 'operator') {
    throw new Error(`operator tier requires the operator sender address, not ${msg.from}`);
  }
  let dispatchId = msg.dispatchId ?? null;
  if (decision.dispatchId != null) {
    if (dispatchId != null && dispatchId !== decision.dispatchId) {
      throw new Error(`dispatchId ${dispatchId} contradicts the verified lineage (#${decision.dispatchId})`);
    }
    dispatchId = decision.dispatchId;
  }
  const m: Record<string, unknown> = { ...meta, tierCode: decision.code, tierReason: decision.reason };
  if (decision.evidence) m.lineage = decision.evidence;
  if (decision.requestedTier) m.requestedTier = decision.requestedTier;
  if (decision.downgradedFrom) m.downgradedFrom = decision.downgradedFrom;
  return { tier: decision.tier, verified, dispatchId, meta: m };
}

// ------------------------------------------------------------------ row mapping

interface Row {
  id: number; ts: string; sender: string; target: string; kind: string; tier: string;
  verified: number; body: string; reply_to: number | null; issue: string | null; thread: string | null;
  dispatch_id: number | null; meta: string | null;
}

interface RRow { name: string; created_by: string; created_at: string; topic: string | null; open: number }
interface MRow { room: string; address: string; added_by: string; added_at: string }
interface FRow { room: string; holder: string; since: string; expires_at: string }
function toRoom(r: RRow): RoomRecord { return { name: r.name, createdBy: r.created_by, createdAt: r.created_at, topic: r.topic, open: r.open === 1 }; }
function toMember(r: MRow): RoomMember { return { room: r.room, address: r.address, addedBy: r.added_by, addedAt: r.added_at }; }
function toFloor(r: FRow): FloorRecord { return { room: r.room, holder: r.holder, since: r.since, expiresAt: r.expires_at }; }

interface SRow {
  address: string; session_id: string | null; session_name: string | null; pid: number | null;
  socket: string | null; started_at: string; heartbeat_at: string;
}

function toSession(r: SRow): SessionRecord {
  return {
    address: r.address, sessionId: r.session_id, sessionName: r.session_name,
    pid: r.pid == null ? null : Number(r.pid), socket: r.socket, startedAt: r.started_at, heartbeatAt: r.heartbeat_at,
  };
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
