import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CommsLog, COMMS_SCHEMA_VERSION } from '../../src/comms/log.js';
import { seal } from '../../src/comms/seal.js';
import type { TierDecision } from '../../src/comms/types.js';

/**
 * CommsLog against a TEMP database — never the default ~/.heddle/comms.db (that is the fleet's
 * real conversation history). Same pattern as test/ledger.test.ts.
 */
describe('CommsLog (temp db)', () => {
  let dir: string;
  let path: string;
  let log: CommsLog;
  let tick = 0;
  // Deterministic, strictly increasing clock so `sinceTs` behaviour is testable.
  const clock = () => new Date(Date.UTC(2026, 7, 15, 12, 0, tick++)).toISOString();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'heddle-comms-test-'));
    path = join(dir, 'comms.db');
    tick = 0;
    log = new CommsLog(path, { now: clock });
  });
  afterEach(() => {
    log.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // ------------------------------------------------------------ writer

  it('appends a message with safe defaults and reads it back intact', () => {
    const rec = log.append({ from: 'K', to: '#fleet', body: 'hello fleet', meta: { transport: 'test', n: 1 } });
    expect(rec.id).toBe(1);
    expect(rec.ts).toBe('2026-08-15T12:00:00.000Z');
    expect(rec).toMatchObject({
      from: 'K', to: '#fleet', body: 'hello fleet', kind: 'chat', tier: 'agent-message', verified: false,
      replyTo: null, issue: null, dispatchId: null, meta: { transport: 'test', n: 1 },
    });
    expect(log.get(1)).toEqual(rec);
    expect(log.get(999)).toBeNull();
    expect(log.latestId()).toBe(1);
    expect(log.count()).toBe(1);
  });

  it('records reply_to / issue / thread / dispatch_id / kind when given, and threads are queryable', () => {
    const q = log.append({ from: 'K', to: 'R', body: 'question?', issue: 'HED-4', thread: 'HED-4/review-1' });
    const a = log.append({ from: 'R', to: 'K', body: 'answer.', kind: 'status', replyTo: q.id, dispatchId: 42, issue: 'HED-4', thread: 'HED-4/review-1' });
    log.append({ from: 'R', to: 'K', body: 'unrelated', thread: 'HED-4/review-2' });
    log.append({ from: 'R', to: 'K', body: 'no thread' });
    expect(a).toMatchObject({ kind: 'status', replyTo: q.id, dispatchId: 42, issue: 'HED-4', thread: 'HED-4/review-1' });
    expect(log.transcript({ pair: ['K', 'R'] }, { thread: 'HED-4/review-1' }).map((m) => m.body)).toEqual(['question?', 'answer.']);
    expect(log.transcript({ all: true }, { thread: 'HED-4/review-2' }).map((m) => m.body)).toEqual(['unrelated']);
    expect(log.get(4)?.thread).toBeNull();
  });

  it('refuses garbage before it reaches the database', () => {
    expect(() => log.append({ from: '#fleet', to: 'K', body: 'x' })).toThrow(/rooms and @all cannot send/);
    expect(() => log.append({ from: '@all', to: 'K', body: 'x' })).toThrow(/rooms and @all cannot send/);
    expect(() => log.append({ from: 'K L', to: 'R', body: 'x' })).toThrow(/invalid from address/);
    expect(() => log.append({ from: 'K', to: 'K.1.1', body: 'x' })).toThrow(/invalid to address/);
    expect(() => log.append({ from: 'K', to: 'R', body: '' })).toThrow(/non-empty/);
    expect(() => log.append({ from: 'K', to: 'R', body: 'x', kind: 'gossip' as never })).toThrow(/unknown message kind/);
    expect(() => log.append({ from: 'K', to: 'R', body: 'x', replyTo: 1.5 })).toThrow(/replyTo/);
    expect(() => log.append({ from: 'K', to: 'R', body: 'x', replyTo: 0 })).toThrow(/positive message id/);
    expect(() => log.append({ from: 'K', to: 'R', body: 'x', replyTo: 999 })).toThrow(/replyTo 999 does not exist/);
    expect(() => log.append({ from: 'K', to: 'R', body: 'x', dispatchId: 0 })).toThrow(/dispatchId must be a positive integer/);
    expect(() => log.append({ from: 'K', to: 'R', body: 'x', dispatchId: 1.5 })).toThrow(/dispatchId must be a positive integer/);
    expect(() => log.append({ from: 'K', to: 'R', body: 'x', issue: '' })).toThrow(/issue must be/);
    expect(() => log.append({ from: 'K', to: 'R', body: 'x', issue: 'x'.repeat(65) })).toThrow(/issue must be/);
    expect(() => log.append({ from: 'K', to: 'R', body: 'x', thread: '' })).toThrow(/thread must be/);
    expect(log.count()).toBe(0);
    // A refused append leaves no participant side-effects behind either.
    expect(log.participants()).toEqual([]);
  });

  /** A decision shaped like the broker's, sealed or not, for one (from, to). */
  const decision = (from: string, to: string, tier: TierDecision['tier'], over: Partial<TierDecision> = {}): TierDecision => ({
    from, to, tier, verified: tier !== 'agent-message', evidence: tier === 'operator' ? 'origin' : tier === 'agent-message' ? null : 'registry',
    code: 'test', reason: 'test decision', dispatchId: null, requestedTier: null, downgradedFrom: null, ...over,
  });

  it('a privileged tier is stored ONLY with the broker\'s sealed decision for that exact pair', () => {
    log.mintChild('K');
    // No decision → agent-message, unverified. There is no field to even ask for more.
    expect(log.append({ from: 'K', to: 'K.1', body: 'x' })).toMatchObject({ tier: 'agent-message', verified: false });
    // Broker-owned meta keys cannot be planted by a caller (they would render as broker text later).
    const planted = log.append({ from: 'K', to: 'K.1', body: 'x', meta: { downgradedFrom: 'operator', tierCode: 'verified-origin', lineage: 'ledger', keep: 1 } });
    expect(planted.meta).toEqual({ keep: 1 });
    expect(() => log.append({ from: 'K', to: 'K.1', body: 'x', meta: ['nope'] as never })).toThrow(/plain object/);
    // A JSON look-alike (unsealed) is refused — this is what an MCP client could send.
    expect(() => log.append({ from: 'K', to: 'K.1', body: 'x' }, decision('K', 'K.1', 'orchestrator-directive')))
      .toThrow(/not sealed/);
    expect(() => log.append({ from: 'operator', to: '@all', body: 'x' }, JSON.parse(JSON.stringify(seal(decision('operator', '@all', 'operator'))))))
      .toThrow(/not sealed/);
    // Sealed decisions are accepted…
    const d1 = log.append({ from: 'K', to: 'K.1', body: 'go' }, seal(decision('K', 'K.1', 'orchestrator-directive', { code: 'verified-registry', reason: 'minted by K' })));
    expect(d1).toMatchObject({ tier: 'orchestrator-directive', verified: true, meta: { tierCode: 'verified-registry', tierReason: 'minted by K', lineage: 'registry' } });
    expect(log.append({ from: 'operator', to: '@all', body: 'stop' }, seal(decision('operator', '@all', 'operator'))).tier).toBe('operator');
    // …but not for another pair, not for a non-operator claiming operator, not when self-inconsistent.
    expect(() => log.append({ from: 'K', to: 'K.1', body: 'x' }, seal(decision('K', 'K.9', 'orchestrator-directive')))).toThrow(/is for K→K.9, not K→K.1/);
    expect(() => log.append({ from: 'K', to: 'K.1', body: 'x' }, seal(decision('K', 'K.1', 'operator')))).toThrow(/operator tier requires the operator sender address/);
    expect(() => log.append({ from: 'K', to: 'K.1', body: 'x' }, seal(decision('K', 'K.1', 'orchestrator-directive', { verified: false })))).toThrow(/inconsistent/);
    expect(() => log.append({ from: 'K', to: 'K.1', body: 'x' }, seal(decision('K', 'K.1', 'agent-message', { verified: true })))).toThrow(/inconsistent/);
    // Sealing freezes: a seal-then-mutate escalation is impossible (ESM is strict → TypeError).
    const frozen = seal(decision('K', 'K.1', 'agent-message')) as { tier: string };
    expect(() => { frozen.tier = 'operator'; }).toThrow(TypeError);
    // The verifier's dispatch anchor is authoritative over the caller's.
    const anchored = () => seal(decision('K', 'K.1', 'orchestrator-directive', { evidence: 'ledger', dispatchId: 17 }));
    expect(log.append({ from: 'K', to: 'K.1', body: 'x' }, anchored()).dispatchId).toBe(17);
    expect(log.append({ from: 'K', to: 'K.1', body: 'x', dispatchId: 17 }, anchored()).dispatchId).toBe(17);
    expect(() => log.append({ from: 'K', to: 'K.1', body: 'x', dispatchId: 18 }, anchored())).toThrow(/contradicts the verified lineage/);

    // Bypass the class entirely: raw INSERTs that break verified <=> privileged are refused by the DB.
    const raw = new DatabaseSync(path);
    try {
      for (const [tier, verified] of [['orchestrator-directive', 0], ['operator', 0], ['agent-message', 1], ['root', 1]] as const) {
        expect(() => raw.prepare(
          'INSERT INTO messages (ts, sender, target, body, tier, verified) VALUES (?, ?, ?, ?, ?, ?)',
        ).run('t', 'K', 'K.1', 'spoof', tier, verified), `${tier}/${verified}`).toThrow(/CHECK constraint failed/);
      }
    } finally { raw.close(); }
    expect(log.count()).toBe(6);
  });

  it('participant lineage is frozen once written; only last_seen/label may change', () => {
    log.mintChild('K', { dispatchId: 17 }); // K.1
    log.register({ address: 'R' });
    const raw = new DatabaseSync(path);
    try {
      for (const sql of [
        "UPDATE participants SET parent = 'R' WHERE address = 'K.1'",
        'UPDATE participants SET dispatch_id = NULL WHERE address = \'K.1\'',
        'UPDATE participants SET dispatch_id = 18 WHERE address = \'K.1\'',
        "UPDATE participants SET seq = 2 WHERE address = 'K.1'",
        "UPDATE participants SET kind = 'agent' WHERE address = 'K.1'",
        "UPDATE participants SET address = 'R.1' WHERE address = 'K.1'",
        "UPDATE participants SET kind = 'child' WHERE address = 'R'",
        "UPDATE participants SET first_seen = 'rewritten' WHERE address = 'K.1'",
      ]) {
        expect(() => raw.prepare(sql).run(), sql).toThrow(/lineage is immutable/);
      }
      // Allowed: presence + label.
      raw.prepare("UPDATE participants SET last_seen = 'later', label = 'renamed' WHERE address = 'K.1'").run();
    } finally { raw.close(); }
    expect(log.participant('K.1')).toMatchObject({ parent: 'K', seq: 1, dispatchId: 17, label: 'renamed', lastSeen: 'later' });
  });

  it('the database refuses malformed lineage rows and double-bound dispatches', () => {
    log.mintChild('K', { dispatchId: 17 });
    expect(() => log.mintChild('R', { dispatchId: 17 })).toThrow(/dispatch #17 is already bound to child K.1/);
    const raw = new DatabaseSync(path);
    try {
      raw.exec('PRAGMA foreign_keys = ON');
      const ins = (address: string, kind: string, parent: string | null, seq: number | null, dispatchId: number | null) => () =>
        raw.prepare('INSERT INTO participants (address, kind, parent, seq, dispatch_id, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(address, kind, parent, seq, dispatchId, 't', 't');
      expect(ins('K.5', 'child', 'R', 5, null), 'address must equal parent.seq').toThrow(/CHECK constraint failed/);
      expect(ins('R.1', 'child', null, 1, null), 'child needs a parent').toThrow(/CHECK constraint failed/);
      expect(ins('S', 'agent', 'K', 1, null), 'agents carry no lineage').toThrow(/CHECK constraint failed/);
      expect(ins('S', 'agent', null, null, 42), 'agents carry no dispatch').toThrow(/CHECK constraint failed/);
      expect(ins('K.2', 'child', 'K', 2, 17), 'dispatch already bound').toThrow(/UNIQUE constraint failed/);
      expect(ins('Z.1', 'child', 'Z', 1, null), 'parent must exist').toThrow(/FOREIGN KEY constraint failed/);
      expect(ins('K.7', 'agent', null, null, null), 'a dotted address cannot be an agent').toThrow(/CHECK constraint failed/);
      expect(ins('X', 'operator', null, null, null), 'only "operator" is the operator').toThrow(/CHECK constraint failed/);
      // And a raw message INSERT cannot speak as anyone unregistered — incl. an unminted child.
      for (const sender of ['K.9', 'ghost']) {
        expect(() => raw.prepare("INSERT INTO messages (ts, sender, target, body) VALUES ('t', ?, 'K', 'boo')").run(sender), sender)
          .toThrow(/sender is not a registered participant/);
      }
    } finally { raw.close(); }
    expect(log.participants().map((p) => p.address)).toEqual(['K', 'K.1']);
  });

  it('is append-only: UPDATE and DELETE are refused by the database itself', () => {
    const rec = log.append({ from: 'K', to: 'R', body: 'original' });
    const raw = new DatabaseSync(path);
    try {
      expect(() => raw.prepare("UPDATE messages SET body = 'tampered' WHERE id = ?").run(rec.id)).toThrow(/append-only: UPDATE refused/);
      expect(() => raw.prepare('DELETE FROM messages WHERE id = ?').run(rec.id)).toThrow(/append-only: DELETE refused/);
    } finally { raw.close(); }
    expect(log.get(rec.id)?.body).toBe('original');
    expect(log.count()).toBe(1);
  });

  // ------------------------------------------------------------ transcript API

  function seedConversation() {
    log.mintChild('K'); // K.1
    log.append({ from: 'K', to: '#fleet', body: 'room 1' });          // 1
    log.append({ from: 'K', to: 'R', body: 'dm K→R' });                // 2
    log.append({ from: 'R', to: 'K', body: 'dm R→K' });                // 3
    log.append({ from: 'R', to: '#fleet', body: 'room 2' });          // 4
    log.append({ from: 'V', to: 'K', body: 'dm V→K' });                // 5
    log.append({ from: 'V', to: '@all', body: 'broadcast' });         // 6
    log.append({ from: 'K', to: 'K.1', body: 'to child' });            // 7
    log.append({ from: 'K.1', to: 'K', body: 'from child' });          // 8
    log.append({ from: 'K', to: '#other', body: 'other room' });      // 9
  }

  it('transcript({room}) returns only that room, oldest first, with exclusive id cursors and paging', () => {
    seedConversation();
    const all = log.transcript({ room: '#fleet' });
    expect(all.map((m) => [m.id, m.body])).toEqual([[1, 'room 1'], [4, 'room 2']]);

    expect(log.transcript({ room: '#fleet' }, { sinceId: 1 }).map((m) => m.id)).toEqual([4]);
    expect(log.transcript({ room: '#fleet' }, { sinceId: 4 })).toEqual([]);

    // Paging: limit 1, then continue from the last id.
    const page1 = log.transcript({ room: '#fleet' }, { limit: 1 });
    expect(page1.map((m) => m.id)).toEqual([1]);
    const page2 = log.transcript({ room: '#fleet' }, { limit: 1, sinceId: page1[0].id });
    expect(page2.map((m) => m.id)).toEqual([4]);
  });

  it('transcript({pair}) is the DM thread in both directions and nothing else', () => {
    seedConversation();
    expect(log.transcript({ pair: ['K', 'R'] }).map((m) => m.body)).toEqual(['dm K→R', 'dm R→K']);
    expect(log.transcript({ pair: ['R', 'K'] }).map((m) => m.body)).toEqual(['dm K→R', 'dm R→K']);
    expect(log.transcript({ pair: ['K', 'K.1'] }).map((m) => m.body)).toEqual(['to child', 'from child']);
    expect(log.transcript({ pair: ['V', 'R'] })).toEqual([]);
  });

  it('transcript({inbox}) is direct messages to me plus @all broadcasts — not rooms, not others', () => {
    seedConversation();
    expect(log.transcript({ inbox: 'K' }).map((m) => m.body)).toEqual(['dm R→K', 'dm V→K', 'broadcast', 'from child']);
    expect(log.transcript({ inbox: 'K.1' }).map((m) => m.body)).toEqual(['broadcast', 'to child']);
    expect(log.transcript({ inbox: 'V' }).map((m) => m.body)).toEqual(['broadcast']);
  });

  it('transcript({all}) with sinceTs is a strict timestamp cursor', () => {
    seedConversation();
    const everything = log.transcript({ all: true });
    expect(everything.map((m) => m.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const later = log.transcript({ all: true }, { sinceTs: everything[5].ts });
    expect(later.map((m) => m.id)).toEqual([7, 8, 9]);
    // Both cursors apply together (AND).
    expect(log.transcript({ all: true }, { sinceTs: everything[5].ts, sinceId: 8 }).map((m) => m.id)).toEqual([9]);
    // Cursors compare INSTANTS, not spellings: an offset form of the same instant behaves identically.
    const offsetForm = '2026-08-15T14:00:06+02:00'; // == 12:00:06Z == everything[5].ts (mintChild took tick 0)
    expect(new Date(offsetForm).toISOString()).toBe(everything[5].ts);
    expect(log.transcript({ all: true }, { sinceTs: offsetForm }).map((m) => m.id)).toEqual([7, 8, 9]);
    expect(log.transcript({ all: true }, { sinceTs: '2026-08-15T14:00:05.500+02:00' }).map((m) => m.id)).toEqual([6, 7, 8, 9]);
  });

  it('transcript rejects malformed scopes and cursors', () => {
    expect(() => log.transcript({ room: 'K' })).toThrow(/must be a #room/);
    expect(() => log.transcript({ inbox: '#fleet' })).toThrow(/agent\/child\/operator/);
    expect(() => log.transcript({ pair: ['K', 'nope nope'] })).toThrow(/invalid to address/);
    // A pair is a DM thread: rooms and @all are not peers (would leak room traffic as a "DM").
    expect(() => log.transcript({ pair: ['K', '#fleet'] })).toThrow(/rooms and @all are not peers/);
    expect(() => log.transcript({ pair: ['@all', 'K'] })).toThrow(/rooms and @all are not peers/);
    expect(() => log.transcript({} as never)).toThrow(/scope must be one of/);
    expect(() => log.transcript({ all: false } as never)).toThrow(/scope must be one of/);
    expect(() => log.transcript({ all: 1 } as never)).toThrow(/scope must be one of/);
    expect(() => log.transcript({ all: true }, { thread: '' })).toThrow(/thread/);
    expect(() => log.transcript({ all: true }, { sinceId: -1 })).toThrow(/sinceId/);
    expect(() => log.transcript({ all: true }, { sinceTs: 'yesterday' })).toThrow(/ISO-8601/);
    expect(() => log.transcript({ all: true }, { limit: 0 })).toThrow(/limit/);
  });

  // ------------------------------------------------------------ participants

  it('registers agents and the operator on first send, and refreshes last_seen after', () => {
    log.append({ from: 'K', to: '#fleet', body: 'a' });          // ts 12:00:00
    log.append({ from: 'operator', to: 'K', body: 'b' });        // ts 12:00:01
    log.append({ from: 'K', to: '#fleet', body: 'c' });          // ts 12:00:02
    const k = log.participant('K')!;
    expect(k).toMatchObject({ kind: 'agent', parent: null, seq: null, dispatchId: null });
    expect(k.firstSeen).toBe('2026-08-15T12:00:00.000Z');
    expect(k.lastSeen).toBe('2026-08-15T12:00:02.000Z');
    expect(log.participant('operator')?.kind).toBe('operator');
    // Targets are NOT registered by being messaged.
    expect(log.participant('#fleet')).toBeNull();
  });

  it('mints children per parent with lineage, and refuses depth > 1', () => {
    const k1 = log.mintChild('K', { dispatchId: 17, label: 'codex scaffold' });
    const k2 = log.mintChild('K');
    const r1 = log.mintChild('R', { dispatchId: 18 });
    expect(k1).toMatchObject({ address: 'K.1', kind: 'child', parent: 'K', seq: 1, dispatchId: 17, label: 'codex scaffold' });
    expect(k2).toMatchObject({ address: 'K.2', parent: 'K', seq: 2, dispatchId: null });
    expect(r1).toMatchObject({ address: 'R.1', parent: 'R', seq: 1, dispatchId: 18 });
    // Minting registers the parent as an agent.
    expect(log.participant('K')?.kind).toBe('agent');
    expect(log.participants({ parent: 'K' }).map((p) => p.address)).toEqual(['K.1', 'K.2']);

    expect(() => log.mintChild('K.1')).toThrow(/depth 1/);
    expect(() => log.mintChild('operator')).toThrow(/parent must be a fleet agent/);
    expect(() => log.mintChild('#fleet')).toThrow(/parent must be a fleet agent/);
    expect(() => log.mintChild('K', { dispatchId: 1.5 })).toThrow(/dispatchId/);
    expect(() => log.mintChild('K', { dispatchId: 0 })).toThrow(/positive integer/);
    expect(() => log.mintChild('K', { dispatchId: -3 })).toThrow(/positive integer/);
  });

  it('a child can only send once it has been minted — addresses do not fabricate lineage', () => {
    expect(() => log.append({ from: 'K.1', to: 'K', body: 'hi' })).toThrow(/must be minted/);
    log.mintChild('K');
    const rec = log.append({ from: 'K.1', to: 'K', body: 'hi' });
    expect(rec.from).toBe('K.1');
    expect(log.participant('K.1')?.lastSeen).toBe(rec.ts);
    // Sending TO an unminted child is allowed (the broker decides deliverability, the log records intent).
    expect(log.append({ from: 'K', to: 'K.9', body: 'are you there' }).to).toBe('K.9');
  });

  it('register() takes agents/operator, keeps first_seen, and refreshes label + last_seen', () => {
    const first = log.register({ address: 'S', label: 'repo-workflows lane' });
    const again = log.register({ address: 'S' });
    expect(again.firstSeen).toBe(first.firstSeen);
    expect(again.lastSeen > first.lastSeen).toBe(true);
    expect(again.label).toBe('repo-workflows lane'); // null label does not erase the old one
    expect(log.register({ address: 'S', label: 'renamed' }).label).toBe('renamed');
    expect(log.register({ address: 'operator' }).kind).toBe('operator');
    expect(() => log.register({ address: 'S.1' })).toThrow(/minted via mintChild/);
    expect(() => log.register({ address: '#fleet' })).toThrow(/register\(\) takes/);
  });

  // ------------------------------------------------------------ durability

  it('refuses to open a database whose schema version it does not understand — and never relabels it', () => {
    log.append({ from: 'K', to: 'R', body: 'v1 row' });
    log.close();
    const raw = new DatabaseSync(path);
    raw.exec('PRAGMA user_version = 99');
    raw.close();
    expect(() => new CommsLog(path)).toThrow(/schema v99; this heddle understands v1 — upgrade heddle/);
    const again = new DatabaseSync(path);
    try {
      expect((again.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(99);
      again.exec('PRAGMA user_version = 1'); // restore so afterEach can close cleanly via a fresh handle
    } finally { again.close(); }
    log = new CommsLog(path);
    expect(log.count()).toBe(1);
  });

  it('persists across close/reopen and stamps the schema version; close() is idempotent', () => {
    log.mintChild('K');
    log.append({ from: 'K.1', to: 'K', body: 'still here' });
    log.close();
    expect(() => log.close()).not.toThrow();
    log = new CommsLog(path);
    expect(log.count()).toBe(1);
    expect(log.get(1)?.body).toBe('still here');
    expect(log.participant('K.1')?.parent).toBe('K');
    const raw = new DatabaseSync(path);
    try {
      expect((raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(COMMS_SCHEMA_VERSION);
      expect((raw.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal');
    } finally { raw.close(); }
  });

  it('two writers on the same file interleave safely with monotonic ids', () => {
    const other = new CommsLog(path);
    try {
      const a = log.append({ from: 'K', to: 'R', body: 'from first handle' });
      const b = other.append({ from: 'R', to: 'K', body: 'from second handle' });
      const c = log.append({ from: 'K', to: 'R', body: 'first again' });
      expect([a.id, b.id, c.id]).toEqual([1, 2, 3]);
      expect(other.transcript({ pair: ['K', 'R'] }).map((m) => m.id)).toEqual([1, 2, 3]);
      // Child sequences are allocated under a write lock, so two handles never mint the same seq.
      expect(log.mintChild('K').address).toBe('K.1');
      expect(other.mintChild('K').address).toBe('K.2');
    } finally { other.close(); }
  });
});
