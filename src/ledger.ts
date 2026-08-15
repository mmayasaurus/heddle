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
  /** Capabilities GRANTED to the worker (comma-joined allowlist tokens), null = default-deny only. */
  capabilities: string | null;
  /** Why this route was taken when a cap/policy check chose it (HED-67), e.g. `cap:claude 5h 92%>=90`. */
  routeReason: string | null;
  /** Account selected for the worker (HED-68 / CODEX_HOME rotation), when heddle chose one. */
  account: string | null;
  /** How `orchestrator` was determined: `bound` (process identity) or `caller` (tool/CLI argument). */
  identitySource: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/** What a dispatch must supply to start (or refuse) a row; the trailing lineage/policy fields are
 *  optional so older call sites keep compiling and simply record null. */
export type DispatchStartRecord =
  Omit<DispatchRecord, 'id' | 'ok' | 'error' | 'inputTokens' | 'cachedInputTokens' | 'outputTokens' |
    'reasoningTokens' | 'durationMs' | 'finishedAt' | 'startedAt' | 'refusal' | 'capabilities' |
    'routeReason' | 'account' | 'identitySource'> &
  Partial<Pick<DispatchRecord, 'capabilities' | 'routeReason' | 'account' | 'identitySource'>>;

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
  capabilities TEXT,
  route_reason TEXT,
  account TEXT,
  identity_source TEXT,
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
  // HED-2 / HED-67 / HED-68 (one migration batch, 2026-08-15):
  { column: 'capabilities', ddl: 'ALTER TABLE dispatches ADD COLUMN capabilities TEXT' },
  { column: 'route_reason', ddl: 'ALTER TABLE dispatches ADD COLUMN route_reason TEXT' },
  { column: 'account', ddl: 'ALTER TABLE dispatches ADD COLUMN account TEXT' },
  { column: 'identity_source', ddl: 'ALTER TABLE dispatches ADD COLUMN identity_source TEXT' },
];

/**
 * Lineage guard (HED-65): a row's identity and id are facts about who dispatched what — nothing may
 * rewrite them after the fact (finish()/refuse() never touch them). Enforced in the database so no
 * caller, including a future one, can do it by accident.
 */
const LINEAGE_TRIGGER = `
CREATE TRIGGER IF NOT EXISTS dispatches_lineage_immutable
BEFORE UPDATE OF id, orchestrator ON dispatches
BEGIN
  SELECT RAISE(ABORT, 'dispatches.id/orchestrator are immutable (lineage)');
END;
`;

export class Ledger {
  private db: DatabaseSync;

  constructor(path: string = DEFAULT_LEDGER_PATH) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    // Several heddle processes (one MCP server per orchestrator session, CLIs, the dashboard) share
    // this file; wait briefly for a writer instead of failing with SQLITE_BUSY.
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
    const have = new Set(
      (this.db.prepare('PRAGMA table_info(dispatches)').all() as { name: string }[]).map((c) => c.name),
    );
    for (const m of MIGRATIONS) if (!have.has(m.column)) this.db.exec(m.ddl);
    this.db.exec(LINEAGE_TRIGGER);
  }

  /** Record a dispatch at start; returns the row id to finish() later. */
  start(r: DispatchStartRecord): number {
    return this.insertStart(r, new Date().toISOString());
  }

  private insertStart(r: DispatchStartRecord, now: string): number {
    const info = this.db.prepare(`
      INSERT INTO dispatches
        (orchestrator, task_class, provider, model, skills, issue, pr, cwd, prompt_preview,
         session_id, fell_back_from, capabilities, route_reason, account, identity_source, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      r.orchestrator, r.taskClass, r.provider, r.model, r.skills, r.issue, r.pr, r.cwd,
      r.promptPreview.slice(0, 500), r.sessionId, r.fellBackFrom, r.capabilities ?? null,
      r.routeReason ?? null, r.account ?? null, r.identitySource ?? null, now,
    );
    return Number(info.lastInsertRowid);
  }

  private insertRefusal(r: DispatchStartRecord, refusal: string, reason: string, now: string): number {
    const info = this.db.prepare(`
      INSERT INTO dispatches
        (orchestrator, task_class, provider, model, skills, issue, pr, cwd, prompt_preview,
         session_id, fell_back_from, refusal, capabilities, route_reason, account, identity_source,
         ok, error, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
    `).run(
      r.orchestrator, r.taskClass, r.provider, r.model, r.skills, r.issue, r.pr, r.cwd,
      r.promptPreview.slice(0, 500), r.sessionId, r.fellBackFrom, refusal, r.capabilities ?? null,
      r.routeReason ?? null, r.account ?? null, r.identitySource ?? null, reason, now, now,
    );
    return Number(info.lastInsertRowid);
  }

  /**
   * In-flight dispatches attributed to one orchestrator (NULL = the anonymous bucket), ignoring
   * rows older than `staleAfterMs` — an orphaned row (HED-19) must not hold a slot forever.
   */
  inFlightCount(orchestrator: string | null, staleAfterMs: number, now = Date.now()): number {
    const cutoff = new Date(now - staleAfterMs).toISOString();
    const row = this.db.prepare(
      'SELECT COUNT(*) AS n FROM dispatches WHERE orchestrator IS ? AND finished_at IS NULL AND started_at >= ?',
    ).get(orchestrator, cutoff) as { n: number };
    return Number(row.n);
  }

  /**
   * Start a row ONLY if the orchestrator is under its concurrency cap; otherwise record a
   * `max-children` refusal instead. Count + insert run in one IMMEDIATE transaction so two
   * concurrent dispatches (even from different heddle processes) cannot both squeeze under the cap.
   */
  startUnderCap(
    r: DispatchStartRecord, cap: { max: number; staleAfterMs: number },
  ): { id: number; refused: false } | { id: number; refused: true; inFlight: number; reason: string } {
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const inFlight = this.inFlightCount(r.orchestrator, cap.staleAfterMs);
      if (inFlight >= cap.max) {
        const who = r.orchestrator ?? '(unbound/anonymous)';
        const reason = `orchestrator ${who} already has ${inFlight} worker(s) in flight ` +
          `(cap ${cap.max}, policy.structural_caps.max_children_per_orchestrator); wait for one to ` +
          `finish, or close orphaned rows (heddle workers --stale / heddle ledger finish <id>).`;
        const id = this.insertRefusal(r, 'max-children', reason, now);
        this.db.exec('COMMIT');
        return { id, refused: true, inFlight, reason };
      }
      const id = this.insertStart(r, now);
      this.db.exec('COMMIT');
      return { id, refused: false };
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* not in a transaction */ }
      throw err;
    }
  }

  /**
   * Record a dispatch heddle REFUSED to run (policy/structural cap): a finished row, ok=0, with the
   * refusal code and reason, so the decision is auditable and never shows as in-flight.
   */
  refuse(r: DispatchStartRecord, refusal: string, reason: string): number {
    return this.insertRefusal(r, refusal, reason, new Date().toISOString());
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

  /** In-flight rows started more than `olderThanMs` ago — orphans to close (heddle workers --stale). */
  staleInFlight(olderThanMs: number, now = Date.now()): Record<string, unknown>[] {
    const cutoff = new Date(now - olderThanMs).toISOString();
    return this.db.prepare(
      'SELECT * FROM dispatches WHERE finished_at IS NULL AND started_at < ? ORDER BY id DESC',
    ).all(cutoff) as Record<string, unknown>[];
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
