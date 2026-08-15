import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Dispatch ledger — the durable record of every sub-task heddle routes.
 *
 * This is the data spine the dashboard, savings analytics, and routing tuning all read from,
 * so it records the DECISION (task class → provider/model/skills, and why) alongside the
 * OUTCOME (usage, duration, success). Facts are persisted; status is derived on read.
 *
 * Uses node:sqlite (built into Node 22) — no native dependency to install or rebuild.
 */

export const DEFAULT_LEDGER_PATH = join(homedir(), '.heddle', 'ledger.db');

export interface DispatchRecord {
  id?: number;
  /** Fleet identity of the dispatching orchestrator (e.g. "K", "codex-B"), if known. */
  orchestrator: string | null;
  taskClass: string;
  provider: string;
  model: string;
  /** Skill packs materialized for this worker, comma-joined. */
  skills: string | null;
  /** Linear issue this sub-task serves, e.g. "SPI-712". */
  issue: string | null;
  /** PR number once known. */
  pr: number | null;
  cwd: string;
  promptPreview: string;
  /** Provider-native resume handle, so a worker can be continued. */
  sessionId: string | null;
  ok: number;
  error: string | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  durationMs: number | null;
  /** Set when the routing table's primary choice failed and a fallback ran. */
  fellBackFrom: string | null;
  /**
   * Set when heddle itself declined to run the dispatch (no worker was spawned): a short machine
   * code such as `claude-in-session`, `depth-1`, `max-children`, `capability-denied`. `error`
   * carries the human-readable reason. Refusals are finished rows (ok=0) so they never look
   * in-flight, and they are queryable separately from worker failures.
   */
  refusal: string | null;
  startedAt: string;
  finishedAt: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS dispatches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  orchestrator TEXT,
  task_class TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  skills TEXT,
  issue TEXT,
  pr INTEGER,
  cwd TEXT NOT NULL,
  prompt_preview TEXT NOT NULL,
  session_id TEXT,
  ok INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  input_tokens INTEGER,
  cached_input_tokens INTEGER,
  output_tokens INTEGER,
  reasoning_tokens INTEGER,
  duration_ms INTEGER,
  fell_back_from TEXT,
  refusal TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_dispatches_issue ON dispatches(issue);
CREATE INDEX IF NOT EXISTS idx_dispatches_orch ON dispatches(orchestrator);
CREATE INDEX IF NOT EXISTS idx_dispatches_started ON dispatches(started_at);
`;

/**
 * Columns added after the first schema shipped. `CREATE TABLE IF NOT EXISTS` never alters an
 * existing table, so each is added with ALTER TABLE when missing — a real ledger (~/.heddle) predates
 * them. Additive only; the dashboard reads columns by name, so extra columns are safe.
 */
const MIGRATIONS: { column: string; ddl: string }[] = [
  { column: 'refusal', ddl: 'ALTER TABLE dispatches ADD COLUMN refusal TEXT' },
];

export class Ledger {
  private db: DatabaseSync;

  constructor(path: string = DEFAULT_LEDGER_PATH) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
    const have = new Set(
      (this.db.prepare('PRAGMA table_info(dispatches)').all() as { name: string }[]).map((c) => c.name),
    );
    for (const m of MIGRATIONS) if (!have.has(m.column)) this.db.exec(m.ddl);
  }

  /** Record a dispatch at start; returns the row id to finish() later. */
  start(r: Omit<DispatchRecord, 'id' | 'ok' | 'error' | 'inputTokens' | 'cachedInputTokens' |
    'outputTokens' | 'reasoningTokens' | 'durationMs' | 'finishedAt' | 'startedAt' | 'refusal'>): number {
    const stmt = this.db.prepare(`
      INSERT INTO dispatches
        (orchestrator, task_class, provider, model, skills, issue, pr, cwd, prompt_preview,
         session_id, fell_back_from, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(
      r.orchestrator, r.taskClass, r.provider, r.model, r.skills, r.issue, r.pr, r.cwd,
      r.promptPreview.slice(0, 500), r.sessionId, r.fellBackFrom, new Date().toISOString(),
    );
    return Number(info.lastInsertRowid);
  }

  /**
   * Record a dispatch heddle REFUSED to run (policy/structural cap): a finished row, ok=0, with the
   * refusal code and reason, so the decision is auditable and never shows as in-flight.
   */
  refuse(
    r: Omit<DispatchRecord, 'id' | 'ok' | 'error' | 'inputTokens' | 'cachedInputTokens' |
      'outputTokens' | 'reasoningTokens' | 'durationMs' | 'finishedAt' | 'startedAt' | 'refusal'>,
    refusal: string, reason: string,
  ): number {
    const now = new Date().toISOString();
    const info = this.db.prepare(`
      INSERT INTO dispatches
        (orchestrator, task_class, provider, model, skills, issue, pr, cwd, prompt_preview,
         session_id, fell_back_from, refusal, ok, error, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
    `).run(
      r.orchestrator, r.taskClass, r.provider, r.model, r.skills, r.issue, r.pr, r.cwd,
      r.promptPreview.slice(0, 500), r.sessionId, r.fellBackFrom, refusal, reason, now, now,
    );
    return Number(info.lastInsertRowid);
  }

  finish(id: number, outcome: {
    ok: boolean; error?: string; sessionId?: string; durationMs?: number;
    inputTokens?: number; cachedInputTokens?: number; outputTokens?: number; reasoningTokens?: number;
  }): void {
    this.db.prepare(`
      UPDATE dispatches SET ok = ?, error = ?, session_id = COALESCE(?, session_id),
        duration_ms = ?, input_tokens = ?, cached_input_tokens = ?, output_tokens = ?,
        reasoning_tokens = ?, finished_at = ?
      WHERE id = ?
    `).run(
      outcome.ok ? 1 : 0, outcome.error ?? null, outcome.sessionId ?? null,
      outcome.durationMs ?? null, outcome.inputTokens ?? null, outcome.cachedInputTokens ?? null,
      outcome.outputTokens ?? null, outcome.reasoningTokens ?? null,
      new Date().toISOString(), id,
    );
  }

  recent(limit = 20, issue?: string): Record<string, unknown>[] {
    const sql = issue
      ? 'SELECT * FROM dispatches WHERE issue = ? ORDER BY id DESC LIMIT ?'
      : 'SELECT * FROM dispatches ORDER BY id DESC LIMIT ?';
    const stmt = this.db.prepare(sql);
    return (issue ? stmt.all(issue, limit) : stmt.all(limit)) as Record<string, unknown>[];
  }

  /** In-flight = started, never finished. The roster's "what's running" source. */
  inFlight(): Record<string, unknown>[] {
    return this.db.prepare(
      'SELECT * FROM dispatches WHERE finished_at IS NULL ORDER BY id DESC',
    ).all() as Record<string, unknown>[];
  }

  /** Aggregate usage by provider — the raw material for the savings stat. */
  usageByProvider(sinceIso?: string): Record<string, unknown>[] {
    const where = sinceIso ? 'WHERE started_at >= ?' : '';
    const stmt = this.db.prepare(`
      SELECT provider,
             COUNT(*) AS dispatches,
             SUM(ok) AS succeeded,
             SUM(COALESCE(input_tokens,0)) AS input_tokens,
             SUM(COALESCE(cached_input_tokens,0)) AS cached_tokens,
             SUM(COALESCE(output_tokens,0)) AS output_tokens,
             SUM(COALESCE(duration_ms,0)) AS duration_ms
      FROM dispatches ${where}
      GROUP BY provider ORDER BY dispatches DESC
    `);
    return (sinceIso ? stmt.all(sinceIso) : stmt.all()) as Record<string, unknown>[];
  }

  close(): void {
    this.db.close();
  }
}
