import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Ledger } from '../src/ledger.js';

describe('Ledger — caps, lineage trigger, migration batch', () => {
  const dirs: string[] = [];
  const ledgers: Ledger[] = [];
  afterEach(() => { for (const ledger of ledgers) ledger.close(); for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); dirs.length = 0; ledgers.length = 0; });
  const cap = { max: 2, staleAfterMs: 3 * 60 * 60 * 1000 };
  function path(): string { const dir = mkdtempSync(join(tmpdir(), 'heddle-ledger-caps-test-')); dirs.push(dir); return join(dir, 'ledger.db'); }
  function record(orchestrator: string | null = 'A') {
    return { orchestrator, taskClass: 'bulk-mechanical', provider: 'codex', model: 'm', skills: null, issue: null, pr: null, cwd: '/tmp/x', promptPreview: 'p', sessionId: null, fellBackFrom: null };
  }

  it('atomically records a finished max-children refusal once an orchestrator reaches its cap', () => {
    const ledger = new Ledger(path()); ledgers.push(ledger);
    const first = ledger.startUnderCap(record(), cap);
    const second = ledger.startUnderCap(record(), cap);
    const third = ledger.startUnderCap(record(), cap);
    expect(first).toMatchObject({ refused: false });
    expect(second).toMatchObject({ refused: false });
    expect(second.id).toBeGreaterThan(first.id);
    expect(third).toMatchObject({ refused: true, inFlight: 2 });
    if (third.refused) expect(third.reason).toContain('cap 2');
    expect(ledger.recent(1)[0]).toMatchObject({ refusal: 'max-children', ok: 0 });
    expect(ledger.recent(1)[0].finished_at).not.toBeNull();
    expect(ledger.inFlight()).toHaveLength(2);
  });

  it('counts anonymous and named orchestrators in independent cap buckets', () => {
    const ledger = new Ledger(path()); ledgers.push(ledger);
    ledger.start(record('A'));
    ledger.start(record(null));
    ledger.start(record(null));
    expect(ledger.inFlightCount(null, cap.staleAfterMs)).toBe(2);
    expect(ledger.inFlightCount('A', cap.staleAfterMs)).toBe(1);
    expect(ledger.startUnderCap(record(null), cap)).toMatchObject({ refused: true, inFlight: 2 });
  });

  it('enforces immutable id and orchestrator lineage while allowing outcome updates', () => {
    const dbPath = path();
    const ledger = new Ledger(dbPath); ledgers.push(ledger);
    const id = ledger.start(record('A'));
    const raw = new DatabaseSync(dbPath);
    expect(() => raw.prepare("UPDATE dispatches SET orchestrator='B' WHERE id=?").run(id)).toThrow(/immutable/);
    expect(() => raw.prepare('UPDATE dispatches SET id=999 WHERE id=?').run(id)).toThrow(/immutable/);
    raw.prepare("UPDATE dispatches SET error='manual' WHERE id=?").run(id);
    raw.close();
    ledger.finish(id, { ok: true });
    expect(ledger.recent(1)[0]).toMatchObject({ id, orchestrator: 'A', ok: 1 });
  });

  it('returns only old unfinished rows from staleInFlight without removing them from inFlight', () => {
    const dbPath = path();
    const ledger = new Ledger(dbPath); ledgers.push(ledger);
    const oldId = ledger.start(record());
    ledger.start(record());
    const raw = new DatabaseSync(dbPath);
    raw.prepare("UPDATE dispatches SET started_at='2020-01-01T00:00:00.000Z' WHERE id=?").run(oldId);
    raw.close();
    expect(ledger.staleInFlight(60 * 60 * 1000)).toHaveLength(1);
    expect(ledger.staleInFlight(60 * 60 * 1000)[0].id).toBe(oldId);
    expect(ledger.inFlight()).toHaveLength(2);
  });

  it('migrates all policy columns and the lineage trigger onto an old ledger idempotently', () => {
    const dbPath = path();
    const old = new DatabaseSync(dbPath);
    old.exec(`CREATE TABLE dispatches (
      id INTEGER PRIMARY KEY AUTOINCREMENT, orchestrator TEXT, task_class TEXT NOT NULL,
      provider TEXT NOT NULL, model TEXT NOT NULL, skills TEXT, issue TEXT, pr INTEGER,
      cwd TEXT NOT NULL, prompt_preview TEXT NOT NULL, session_id TEXT, ok INTEGER NOT NULL DEFAULT 0,
      error TEXT, input_tokens INTEGER, cached_input_tokens INTEGER, output_tokens INTEGER,
      reasoning_tokens INTEGER, duration_ms INTEGER, fell_back_from TEXT, started_at TEXT NOT NULL, finished_at TEXT
    );`);
    old.prepare('INSERT INTO dispatches (task_class, provider, model, cwd, prompt_preview, started_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('bulk-mechanical', 'codex', 'm', '/tmp/x', 'p', '2026-01-01T00:00:00.000Z');
    old.close();
    const ledger = new Ledger(dbPath); ledgers.push(ledger);
    const names = new DatabaseSync(dbPath);
    const columns = (names.prepare('PRAGMA table_info(dispatches)').all() as { name: string }[]).map((column) => column.name);
    const triggers = (names.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as { name: string }[]).map((trigger) => trigger.name);
    names.close();
    expect(columns).toEqual(expect.arrayContaining(['refusal', 'capabilities', 'route_reason', 'account', 'identity_source']));
    expect(ledger.recent(1)[0]).toMatchObject({ refusal: null, capabilities: null, route_reason: null, account: null, identity_source: null });
    expect(triggers).toContain('dispatches_lineage_immutable');
    ledger.close(); ledgers.pop();
    expect(() => { const reopened = new Ledger(dbPath); reopened.close(); }).not.toThrow();
  });

  it('records optional policy and lineage fields only when supplied', () => {
    const ledger = new Ledger(path()); ledgers.push(ledger);
    ledger.start({ ...record(), capabilities: 'net', routeReason: 'cap:test', account: 'acct2', identitySource: 'bound' });
    expect(ledger.recent(1)[0]).toMatchObject({ capabilities: 'net', route_reason: 'cap:test', account: 'acct2', identity_source: 'bound' });
    ledger.start(record());
    expect(ledger.recent(1)[0]).toMatchObject({ capabilities: null, route_reason: null, account: null, identity_source: null });
  });
});
