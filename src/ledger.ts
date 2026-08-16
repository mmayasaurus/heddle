import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { makePsProbe, type OwnerProbe } from './ledger-ps.js';

// Re-exported so consumers/tests keep one import surface for ledger concerns.
export { parsePsTable, ownerVerdict, type OwnerProbe, type PsEntry } from './ledger-ps.js';

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
  /** Failure reason on ok=0; on ok=1 a `cleanup-warning:`-prefixed note means the work succeeded
   *  but post-run restore had a problem (non-fatal by convention). */
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
  /** pid of the process that recorded this dispatch. start() and finish() always run in the same
   *  process, so this pid being provably gone means finish() can never arrive (HED-90). */
  ownerPid: number | null;
  /** Executable basename of that process (node/bun) — informational, and the liveness fallback
   *  when a process start time is unavailable (HED-87's ps-comm pattern). */
  ownerComm: string | null;
  /** Epoch ms the owner process started (now − process.uptime()). The primary pid-reuse-safe
   *  identity: a pid recycled to a NEW process cannot have this start time. */
  ownerStartedAt: number | null;
  /** null for normal rows; 'orphaned' when the hygiene sweep closed the row (HED-90). */
  outcome: string | null;
}

/** What a dispatch must supply to start (or refuse) a row; the trailing lineage/policy fields are
 *  optional so older call sites keep compiling and simply record null. */
export type DispatchStartRecord =
  Omit<DispatchRecord, 'id' | 'ok' | 'error' | 'inputTokens' | 'cachedInputTokens' | 'outputTokens' |
    'reasoningTokens' | 'durationMs' | 'finishedAt' | 'startedAt' | 'refusal' | 'capabilities' |
    'routeReason' | 'account' | 'identitySource' |
    // Derived/sweep-owned, never caller-provided: the owner identity is stamped by insertStart
    // itself; `outcome` is written only by the orphan sweep (HED-90).
    'ownerPid' | 'ownerComm' | 'ownerStartedAt' | 'outcome'> &
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
CREATE TABLE IF NOT EXISTS reviews (
  dispatch_id INTEGER PRIMARY KEY REFERENCES dispatches(id),
  author_provider TEXT,
  author_model TEXT,
  author_dispatch_id INTEGER,
  reviewer_provider TEXT NOT NULL,
  reviewer_model TEXT NOT NULL,
  mandate_ok INTEGER,
  findings_total INTEGER,
  findings_accepted INTEGER,
  notes TEXT,
  created_at TEXT NOT NULL,
  outcome_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_reviews_pair ON reviews(author_provider, reviewer_provider);
CREATE INDEX IF NOT EXISTS idx_dispatches_issue ON dispatches(issue);
CREATE INDEX IF NOT EXISTS idx_dispatches_orch ON dispatches(orchestrator);
CREATE INDEX IF NOT EXISTS idx_dispatches_started ON dispatches(started_at);
CREATE INDEX IF NOT EXISTS idx_dispatches_finished ON dispatches(finished_at);
`;

/**
 * Add every missing column. `existing` is the column set observed BEFORE the ALTERs — several heddle
 * processes may open a pre-migration ledger at once (MCP servers, CLIs, the dashboard); if another
 * one added a column between our check and our ALTER, SQLite says "duplicate column name" — that is
 * success, not failure. Exported so the race path itself is testable (pass a stale `existing`).
 */
export function applyLedgerMigrations(db: DatabaseSync, existing: Set<string>): { applied: string[]; alreadyPresent: string[] } {
  const applied: string[] = [];
  const alreadyPresent: string[] = [];
  for (const m of MIGRATIONS) {
    if (existing.has(m.column)) continue;
    try {
      db.exec(m.ddl);
      applied.push(m.column);
    } catch (err) {
      if (!/duplicate column name/i.test(err instanceof Error ? err.message : String(err))) throw err;
      alreadyPresent.push(m.column); // a concurrent opener won the race — fine
    }
  }
  return { applied, alreadyPresent };
}

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
  // HED-90 (orphan hygiene, 2026-08-16):
  { column: 'owner_pid', ddl: 'ALTER TABLE dispatches ADD COLUMN owner_pid INTEGER' },
  { column: 'owner_comm', ddl: 'ALTER TABLE dispatches ADD COLUMN owner_comm TEXT' },
  { column: 'owner_started_at', ddl: 'ALTER TABLE dispatches ADD COLUMN owner_started_at INTEGER' },
  { column: 'outcome', ddl: 'ALTER TABLE dispatches ADD COLUMN outcome TEXT' },
];

/**
 * Lineage guard (HED-65): a row's identity and id are facts about who dispatched what — nothing may
 * rewrite them after the fact (finish()/refuse() never touch them). Enforced in the database so no
 * caller, including a future one, can do it by accident.
 */
const LINEAGE_TRIGGER = `
CREATE TRIGGER IF NOT EXISTS dispatches_lineage_immutable
BEFORE UPDATE OF id, orchestrator, identity_source ON dispatches
BEGIN
  SELECT RAISE(ABORT, 'dispatches.id/orchestrator/identity_source are immutable (lineage)');
END;
`;

/** Trigger bodies are frozen at CREATE; drop the v1 (id, orchestrator only) body so the widened one applies. */
const LINEAGE_TRIGGER_DROP_V1 = "DROP TRIGGER IF EXISTS dispatches_lineage_immutable;";

/** One in-flight row the sweep would close, and why. */
export interface OrphanCandidate {
  id: number;
  startedAt: string;
  reason: string;
}

/** Nothing heddle dispatches legitimately runs this long (worker budgets are minutes). */
export const DEFAULT_ORPHAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** One-decimal hours (floor): 24.1h must never display as "24h (limit 24h)". */
function hours(ms: number): string {
  return (Math.floor(ms / 360_000) / 10).toFixed(1);
}

/**
 * Why one in-flight row is an orphan, or null when it isn't:
 *   - its owner is provably gone (pid-reuse-safe start-time verdict), or
 *   - it exceeded the age limit AND the owner is not demonstrably alive — age alone never
 *     overrides a POSITIVE liveness verdict (a legitimately long-running dispatch is no orphan).
 */
function orphanReason(
  row: Record<string, unknown>,
  probe: OwnerProbe,
  maxAgeMs: number,
  now: Date,
): string | null {
  const ageMs = now.getTime() - Date.parse(String(row.started_at ?? ''));
  const ownerPid = row.owner_pid == null ? null : Number(row.owner_pid);
  const ownerStartedAt = row.owner_started_at == null ? null : Number(row.owner_started_at);
  // true = same process instance still running · false = provably gone · null = unknown
  const alive = ownerPid == null ? null : probe(ownerPid, ownerStartedAt);
  if (alive === false) {
    return `owner process ${ownerPid} (${row.owner_comm ?? '?'}) is gone`;
  }
  if (alive !== true && Number.isFinite(ageMs) && ageMs > maxAgeMs) {
    return `in-flight for ${hours(ageMs)}h (limit ${hours(maxAgeMs)}h) and owner ${
      ownerPid == null ? 'unrecorded' : 'liveness unknown'}`;
  }
  return null;
}

export class Ledger {
  private db: DatabaseSync;

  constructor(path: string = DEFAULT_LEDGER_PATH) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    // Several heddle processes (one MCP server per orchestrator session, CLIs, the dashboard) share
    // this file; wait briefly for a writer instead of failing with SQLITE_BUSY. Set FIRST so it also
    // covers the WAL switch and the migration window below (check, then ALTER).
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;'); // reviews.dispatch_id must be a real dispatch
    // One IMMEDIATE transaction around schema + migrations + trigger: concurrent openers of a
    // pre-migration db serialize here instead of interleaving ALTERs (busy_timeout covers the wait;
    // duplicate-column tolerance in applyLedgerMigrations covers a winner that got there first).
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(SCHEMA);
      const have = new Set(
        (this.db.prepare('PRAGMA table_info(dispatches)').all() as { name: string }[]).map((c) => c.name),
      );
      applyLedgerMigrations(this.db, have);
      this.db.exec(LINEAGE_TRIGGER_DROP_V1);
      this.db.exec(LINEAGE_TRIGGER);
      this.db.exec('COMMIT');
    } catch (err) {
      // ROLLBACK itself can only fail when no transaction is active (the original error already
      // aborted it) — the original error is the signal and propagates either way.
      try { this.db.exec('ROLLBACK'); } catch { /* not in a transaction */ }
      throw err;
    }
  }

  /** Record a dispatch at start; returns the row id to finish() later. */
  start(r: DispatchStartRecord): number {
    return this.insertStart(r, new Date().toISOString());
  }

  private insertStart(r: DispatchStartRecord, now: string): number {
    // start() and finish() always run in this same process, so its identity is the row's owner:
    // if this pid is later provably gone, finish() can never arrive and the row is an orphan.
    const info = this.db.prepare(`
      INSERT INTO dispatches
        (orchestrator, task_class, provider, model, skills, issue, pr, cwd, prompt_preview,
         session_id, fell_back_from, capabilities, route_reason, account, identity_source,
         started_at, owner_pid, owner_comm, owner_started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      r.orchestrator, r.taskClass, r.provider, r.model, r.skills, r.issue, r.pr, r.cwd,
      r.promptPreview.slice(0, 500), r.sessionId, r.fellBackFrom, r.capabilities ?? null,
      r.routeReason ?? null, r.account ?? null, r.identitySource ?? null, now,
      process.pid, basename(process.execPath), Math.round(Date.now() - process.uptime() * 1000),
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
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // Stamped AFTER the lock is held: a wait on a writer must not make this row look older (and
      // possibly "stale") than it is.
      const now = new Date().toISOString();
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
        reasoning_tokens = ?, finished_at = ?, outcome = NULL
      WHERE id = ?
    `).run(
      outcome.ok ? 1 : 0, outcome.error ?? null, outcome.sessionId ?? null,
      outcome.durationMs ?? null, outcome.inputTokens ?? null, outcome.cachedInputTokens ?? null,
      outcome.outputTokens ?? null, outcome.reasoningTokens ?? null,
      new Date().toISOString(), id,
    );
  }

  /**
   * Manual close of an ORPHANED row (heddle ledger finish): only succeeds while the row is still in
   * flight, atomically — a worker's own finish() (real outcome) is never overwritten by it, and a
   * manual close never races a completing worker into two writers. Returns false when nothing was
   * closed (no such row, or already finished).
   */
  /** The account a session last ran under — resume affinity: a claude session lives inside ONE
   *  config dir, so resuming it must reuse that account, not a fresh headroom pick (PR #12). */
  sessionAccount(sessionId: string): string | null {
    const row = this.db.prepare(
      'SELECT account FROM dispatches WHERE session_id = ? ORDER BY id DESC LIMIT 1',
    ).get(sessionId) as { account: string | null } | undefined;
    return row?.account ?? null;
  }

  closeIfInFlight(id: number, error: string, opts: { outcome?: string; now?: Date } = {}): boolean {
    const info = this.db.prepare(`
      UPDATE dispatches SET ok = 0, error = ?, outcome = COALESCE(?, outcome), finished_at = ?
      WHERE id = ? AND finished_at IS NULL
    `).run(error, opts.outcome ?? null, (opts.now ?? new Date()).toISOString(), id);
    return Number(info.changes) > 0;
  }

  recent(limit = 20, issue?: string): Record<string, unknown>[] {
    const sql = issue
      ? 'SELECT * FROM dispatches WHERE issue = ? ORDER BY id DESC LIMIT ?'
      : 'SELECT * FROM dispatches ORDER BY id DESC LIMIT ?';
    const stmt = this.db.prepare(sql);
    return (issue ? stmt.all(issue, limit) : stmt.all(limit)) as Record<string, unknown>[];
  }

  // ---- Adversarial reviews (HED-3) ------------------------------------------------------------

  /** Record that a dispatch is an adversarial review: who wrote the code, who reviewed it. */
  recordReview(r: {
    dispatchId: number; authorProvider: string | null; authorModel: string | null; authorDispatchId: number | null;
    reviewerProvider: string; reviewerModel: string;
  }): void {
    if (r.authorDispatchId !== null && (!Number.isInteger(r.authorDispatchId) || r.authorDispatchId <= 0)) {
      throw new Error(`review for #${r.dispatchId}: author_dispatch_id must be a positive integer (got ${r.authorDispatchId})`);
    }
    // Upsert that never wipes mandate_ok / findings / notes / outcome_at (INSERT OR REPLACE would).
    this.db.prepare(`
      INSERT INTO reviews
        (dispatch_id, author_provider, author_model, author_dispatch_id, reviewer_provider, reviewer_model, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(dispatch_id) DO UPDATE SET
        author_provider = excluded.author_provider, author_model = excluded.author_model,
        author_dispatch_id = excluded.author_dispatch_id, reviewer_provider = excluded.reviewer_provider,
        reviewer_model = excluded.reviewer_model
    `).run(r.dispatchId, r.authorProvider, r.authorModel, r.authorDispatchId, r.reviewerProvider, r.reviewerModel, new Date().toISOString());
  }

  /** The read-only mandate check result (null = could not judge, e.g. not a git repo). */
  setReviewMandate(dispatchId: number, mandateOk: boolean | null): void {
    this.db.prepare('UPDATE reviews SET mandate_ok = ? WHERE dispatch_id = ?')
      .run(mandateOk === null ? null : mandateOk ? 1 : 0, dispatchId);
  }

  /** The follow-up: how many of the reviewer's findings the author accepted (the score that tunes reviewer pairs). */
  recordReviewOutcome(dispatchId: number, o: { findingsTotal: number; findingsAccepted: number; notes?: string }): boolean {
    if (!Number.isInteger(o.findingsTotal) || !Number.isInteger(o.findingsAccepted) || o.findingsTotal < 0 ||
        o.findingsAccepted < 0 || o.findingsAccepted > o.findingsTotal) {
      throw new Error(`review outcome for #${dispatchId}: findings_accepted (${o.findingsAccepted}) must be 0..findings_total (${o.findingsTotal})`);
    }
    // Scoring an IN-FLIGHT review is always a mistake (the findings don't exist yet); re-scoring a
    // finished one is a legitimate correction and stays allowed.
    const dispatchRow = this.db.prepare('SELECT finished_at FROM dispatches WHERE id = ?').get(dispatchId) as { finished_at: string | null } | undefined;
    if (dispatchRow && dispatchRow.finished_at === null) {
      throw new Error(`review outcome for #${dispatchId}: the review dispatch is still in flight — score it after it finishes`);
    }
    const info = this.db.prepare(
      'UPDATE reviews SET findings_total = ?, findings_accepted = ?, notes = ?, outcome_at = ? WHERE dispatch_id = ?',
    ).run(o.findingsTotal, o.findingsAccepted, o.notes ?? null, new Date().toISOString(), dispatchId);
    return Number(info.changes) > 0;
  }

  getReview(dispatchId: number): Record<string, unknown> | null {
    return (this.db.prepare('SELECT * FROM reviews WHERE dispatch_id = ?').get(dispatchId) as Record<string, unknown> | undefined) ?? null;
  }

  /** Per author→reviewer provider pair: reviews, scored reviews, findings, accepted, acceptance rate, mandate violations. */
  reviewPairStats(): Record<string, unknown>[] {
    return this.db.prepare(`
      SELECT author_provider, reviewer_provider,
             COUNT(*) AS reviews,
             SUM(CASE WHEN outcome_at IS NOT NULL THEN 1 ELSE 0 END) AS scored,
             SUM(COALESCE(findings_total, 0)) AS findings_total,
             SUM(COALESCE(findings_accepted, 0)) AS findings_accepted,
             CASE WHEN SUM(COALESCE(findings_total, 0)) > 0
                  THEN ROUND(1.0 * SUM(COALESCE(findings_accepted, 0)) / SUM(COALESCE(findings_total, 0)), 3)
                  ELSE NULL END AS acceptance_rate,
             SUM(CASE WHEN mandate_ok = 0 THEN 1 ELSE 0 END) AS mandate_violations
      FROM reviews
      GROUP BY author_provider, reviewer_provider
      ORDER BY reviews DESC, acceptance_rate DESC
    `).all() as Record<string, unknown>[];
  }

  /** Recent reviews joined with their dispatch rows (newest first). */
  recentReviews(limit = 20): Record<string, unknown>[] {
    return this.db.prepare(`
      SELECT r.*, d.model AS reviewer_model_run, d.ok, d.issue, d.started_at, d.duration_ms
      FROM reviews r JOIN dispatches d ON d.id = r.dispatch_id
      ORDER BY r.dispatch_id DESC LIMIT ?
    `).all(limit) as Record<string, unknown>[];
  }

  /** In-flight = started, never finished. The roster's "what's running" source. */
  inFlight(): Record<string, unknown>[] {
    return this.db.prepare(
      'SELECT * FROM dispatches WHERE finished_at IS NULL ORDER BY id DESC',
    ).all() as Record<string, unknown>[];
  }

  /**
   * Orphan hygiene (HED-90): close in-flight rows whose finish() can provably never arrive, so the
   * ledger's "running" view stays honest. A row is an orphan when
   *   (a) it is older than `maxAgeMs` (default 24h) — nothing heddle dispatches runs that long — OR
   *   (b) its recorded owner process is gone: the pid no longer exists, or exists but is no longer
   *       the recorded executable (pid-reuse-safe ps-comm check, HED-87 pattern).
   * Closing writes finished_at, ok=0, outcome='orphaned' and the reason into error — guarded by
   * `finished_at IS NULL`, so a real finish() racing the sweep always wins. `dryRun` computes the
   * same candidates and mutates nothing.
   *
   * `isOwnerAlive` is injectable for tests; the default probes ps once for all candidate pids.
   * A `null` verdict (ps unavailable) is UNKNOWN — such rows are left alone rather than guessed at.
   */
  sweepOrphans(opts: {
    maxAgeMs?: number;
    dryRun?: boolean;
    now?: Date;
    isOwnerAlive?: OwnerProbe;
  } = {}): { candidates: OrphanCandidate[]; closed: number } {
    const maxAgeMs = opts.maxAgeMs ?? DEFAULT_ORPHAN_MAX_AGE_MS;
    const now = opts.now ?? new Date();
    const rows = this.inFlight();
    const probe = opts.isOwnerAlive ?? makePsProbe(rows);
    const candidates: OrphanCandidate[] = [];
    for (const row of rows) {
      const reason = orphanReason(row, probe, maxAgeMs, now);
      if (reason !== null) {
        candidates.push({ id: Number(row.id), startedAt: String(row.started_at ?? ''), reason });
      }
    }
    let closed = 0;
    if (!opts.dryRun) {
      for (const c of candidates) {
        if (this.closeIfInFlight(c.id, `orphan sweep: ${c.reason}`, { outcome: 'orphaned', now })) closed++;
      }
    }
    return { candidates, closed };
  }


  /** In-flight rows started more than `olderThanMs` ago — orphans to close (heddle workers --stale). */
  staleInFlight(olderThanMs: number, now = Date.now()): Record<string, unknown>[] {
    const cutoff = new Date(now - olderThanMs).toISOString();
    return this.db.prepare(
      'SELECT * FROM dispatches WHERE finished_at IS NULL AND started_at < ? ORDER BY id DESC',
    ).all(cutoff) as Record<string, unknown>[];
  }

  /**
   * Aggregate usage by provider — the raw material for the savings stat. Refusals (no worker was
   * spawned) are NOT dispatches: they are excluded from `dispatches`/`succeeded`/tokens and reported
   * separately as `refusals`, so a stream of claude-in-session refusals cannot masquerade as failed
   * Claude runs in success rates or savings math.
   */
  usageByProvider(sinceIso?: string): Record<string, unknown>[] {
    const where = sinceIso ? 'WHERE started_at >= ?' : '';
    const stmt = this.db.prepare(`
      SELECT provider,
             SUM(CASE WHEN refusal IS NULL THEN 1 ELSE 0 END) AS dispatches,
             SUM(CASE WHEN refusal IS NULL THEN ok ELSE 0 END) AS succeeded,
             SUM(CASE WHEN refusal IS NOT NULL THEN 1 ELSE 0 END) AS refusals,
             SUM(CASE WHEN refusal IS NULL THEN COALESCE(input_tokens,0) ELSE 0 END) AS input_tokens,
             SUM(CASE WHEN refusal IS NULL THEN COALESCE(cached_input_tokens,0) ELSE 0 END) AS cached_tokens,
             SUM(CASE WHEN refusal IS NULL THEN COALESCE(output_tokens,0) ELSE 0 END) AS output_tokens,
             SUM(CASE WHEN refusal IS NULL THEN COALESCE(duration_ms,0) ELSE 0 END) AS duration_ms
      FROM dispatches ${where}
      GROUP BY provider ORDER BY dispatches DESC
    `);
    return (sinceIso ? stmt.all(sinceIso) : stmt.all()) as Record<string, unknown>[];
  }

  /** One dispatch row by id, or null. Read-only lookup — the comms broker verifies lineage with it. */
  get(id: number): Record<string, unknown> | null {
    const row = this.db.prepare('SELECT * FROM dispatches WHERE id = ?').get(id);
    return (row as Record<string, unknown> | undefined) ?? null;
  }

  close(): void {
    this.db.close();
  }
}
