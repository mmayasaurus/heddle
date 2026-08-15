import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Ledger } from '../src/ledger.js';
import { useTempResources } from './helpers.js';

describe('Ledger.refuse + refusal-column migration', () => {
  const { tempDir, trackLedger } = useTempResources('heddle-ledger-refusal-test-');
  function tempPath(): string { return join(tempDir(), 'ledger.db'); }

  function refusalRecord() {
    return { orchestrator: 'U', taskClass: 'implementation', provider: 'claude', model: 'sonnet', skills: 'worker-role', issue: null, pr: null, cwd: '/tmp/x', promptPreview: 'p', sessionId: null, fellBackFrom: null };
  }

  it('persists a refusal as a finished unsuccessful row that is never in flight', () => {
    const ledger = trackLedger(new Ledger(tempPath()));
    const id = ledger.refuse(refusalRecord(), 'claude-in-session', 'why');
    expect(ledger.recent(1)[0]).toMatchObject({ id, refusal: 'claude-in-session', error: 'why', ok: 0 });
    expect(ledger.recent(1)[0].started_at).not.toBeNull();
    expect(ledger.recent(1)[0].finished_at).not.toBeNull();
    expect(ledger.inFlight()).toEqual([]);
  });

  it('adds refusal to an old ledger without losing its pre-existing row and permits future refusals', () => {
    const path = tempPath();
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE dispatches (
        id INTEGER PRIMARY KEY AUTOINCREMENT, orchestrator TEXT, task_class TEXT NOT NULL,
        provider TEXT NOT NULL, model TEXT NOT NULL, skills TEXT, issue TEXT, pr INTEGER,
        cwd TEXT NOT NULL, prompt_preview TEXT NOT NULL, session_id TEXT,
        ok INTEGER NOT NULL DEFAULT 0, error TEXT, input_tokens INTEGER, cached_input_tokens INTEGER,
        output_tokens INTEGER, reasoning_tokens INTEGER, duration_ms INTEGER, fell_back_from TEXT,
        started_at TEXT NOT NULL, finished_at TEXT
      );
    `);
    old.prepare(`INSERT INTO dispatches (task_class, provider, model, cwd, prompt_preview, started_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run('implementation', 'claude', 'sonnet', '/tmp/x', 'p', '2026-01-01T00:00:00.000Z');
    old.close();

    const ledger = trackLedger(new Ledger(path));
    const [existing] = ledger.recent(1);
    expect(existing.refusal).toBeNull();
    ledger.close();

    const check = new DatabaseSync(path);
    const names = (check.prepare('PRAGMA table_info(dispatches)').all() as { name: string }[]).map((column) => column.name);
    check.close();
    expect(names).toContain('refusal');

    const reopened = new Ledger(path);
    trackLedger(reopened);
    expect(reopened.refuse(refusalRecord(), 'claude-in-session', 'why')).toBeTypeOf('number');
  });

  it('opens an already migrated ledger a second time without throwing', () => {
    const path = tempPath();
    const first = trackLedger(new Ledger(path));
    first.close();
    expect(() => {
      const second = new Ledger(path);
      second.close();
    }).not.toThrow();
  });
});

describe('Ledger — usage excludes refusals; migration tolerates a concurrent ALTER', () => {
  const { tempDir, trackLedger } = useTempResources('heddle-ledger-review-test-');
  function tempPath(): string { return join(tempDir(), 'ledger.db'); }

  function record(provider: string) {
    return { orchestrator: 'U', taskClass: 'implementation', provider, model: 'm1', skills: null, issue: null, pr: null, cwd: '/tmp/x', promptPreview: 'p', sessionId: null, fellBackFrom: null };
  }

  it('counts refusals separately from dispatched work in provider usage', () => {
    const ledger = new Ledger(tempPath());
    trackLedger(ledger);
    const id = ledger.start(record('codex'));
    ledger.finish(id, { ok: true, inputTokens: 100 });
    ledger.refuse(record('claude'), 'claude-in-session', 'why');
    ledger.refuse(record('claude'), 'claude-in-session', 'why');
    ledger.refuse(record('codex'), 'claude-in-session', 'why');

    const [codex, claude] = ledger.usageByProvider();
    expect(codex).toMatchObject({ provider: 'codex', dispatches: 1, succeeded: 1, refusals: 1, input_tokens: 100 });
    expect(claude).toMatchObject({ provider: 'claude', dispatches: 0, succeeded: 0, refusals: 2, input_tokens: 0 });
  });

  it('opens an already-migrated old schema and documents SQLite duplicate-column behavior', () => {
    const path = tempPath();
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE dispatches (
        id INTEGER PRIMARY KEY AUTOINCREMENT, orchestrator TEXT, task_class TEXT NOT NULL,
        provider TEXT NOT NULL, model TEXT NOT NULL, skills TEXT, issue TEXT, pr INTEGER,
        cwd TEXT NOT NULL, prompt_preview TEXT NOT NULL, session_id TEXT,
        ok INTEGER NOT NULL DEFAULT 0, error TEXT, input_tokens INTEGER, cached_input_tokens INTEGER,
        output_tokens INTEGER, reasoning_tokens INTEGER, duration_ms INTEGER, fell_back_from TEXT,
        started_at TEXT NOT NULL, finished_at TEXT
      );
    `);
    old.exec('ALTER TABLE dispatches ADD COLUMN refusal TEXT');
    old.close();

    expect(() => {
      const ledger = new Ledger(path);
      ledger.close();
    }).not.toThrow();

    const migrated = new DatabaseSync(path);
    expect(() => migrated.exec('ALTER TABLE dispatches ADD COLUMN refusal TEXT')).toThrow(/duplicate column name/i);
    migrated.close();
  });
});
