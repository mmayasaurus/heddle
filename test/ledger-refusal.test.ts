import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Ledger } from '../src/ledger.js';

describe('Ledger.refuse + refusal-column migration', () => {
  const dirs: string[] = [];
  const ledgers: Ledger[] = [];

  afterEach(() => {
    for (const ledger of ledgers) ledger.close();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
    ledgers.length = 0;
  });

  function tempPath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'heddle-ledger-refusal-test-'));
    dirs.push(dir);
    return join(dir, 'ledger.db');
  }

  function refusalRecord() {
    return { orchestrator: 'U', taskClass: 'implementation', provider: 'claude', model: 'sonnet', skills: 'worker-role', issue: null, pr: null, cwd: '/tmp/x', promptPreview: 'p', sessionId: null, fellBackFrom: null };
  }

  it('persists a refusal as a finished unsuccessful row that is never in flight', () => {
    const ledger = new Ledger(tempPath());
    ledgers.push(ledger);
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

    const ledger = new Ledger(path);
    const [existing] = ledger.recent(1);
    expect(existing.refusal).toBeNull();
    ledger.close();

    const check = new DatabaseSync(path);
    const names = (check.prepare('PRAGMA table_info(dispatches)').all() as { name: string }[]).map((column) => column.name);
    check.close();
    expect(names).toContain('refusal');

    const reopened = new Ledger(path);
    ledgers.push(reopened);
    expect(reopened.refuse(refusalRecord(), 'claude-in-session', 'why')).toBeTypeOf('number');
  });

  it('opens an already migrated ledger a second time without throwing', () => {
    const path = tempPath();
    const first = new Ledger(path);
    first.close();
    expect(() => {
      const second = new Ledger(path);
      second.close();
    }).not.toThrow();
  });
});
