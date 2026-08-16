import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger, parsePsTable, ownerVerdict, DEFAULT_ORPHAN_MAX_AGE_MS } from '../src/ledger.js';

/**
 * Orphan hygiene (HED-90) against a TEMP database — never the operator's real ledger.
 *
 * The sweep's promise: an in-flight row closes (finished_at set, ok=0, outcome='orphaned', reason
 * in error) exactly when finish() can provably never arrive — the row is older than the age limit,
 * or its owner process is gone (pid-reuse-safe). Everything else is untouched, and dry-run never
 * mutates.
 */
function startRow(ledger: Ledger, over: Partial<Parameters<Ledger['start']>[0]> = {}): number {
  return ledger.start({
    orchestrator: 'W', taskClass: 'implementation', provider: 'codex', model: 'gpt-5.6-terra',
    skills: null, issue: 'HED-90', pr: null, cwd: '/tmp/x', promptPreview: 'sweep me maybe',
    sessionId: null, fellBackFrom: null, ...over,
  });
}

/** Rewrite a row's started_at (and optionally owner columns) to simulate history. */
function ageRow(ledger: Ledger, id: number, opts: { hoursAgo: number; ownerPid?: number | null; ownerComm?: string | null; ownerStartedAt?: number | null }): void {
  const startedAt = new Date(Date.now() - opts.hoursAgo * 3_600_000).toISOString();
  // Test-only access to the underlying handle: the public API deliberately has no "backdate" call.
  const db = (ledger as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).db;
  db.prepare('UPDATE dispatches SET started_at = ? WHERE id = ?').run(startedAt, id);
  if ('ownerPid' in opts) db.prepare('UPDATE dispatches SET owner_pid = ? WHERE id = ?').run(opts.ownerPid, id);
  if ('ownerComm' in opts) db.prepare('UPDATE dispatches SET owner_comm = ? WHERE id = ?').run(opts.ownerComm, id);
  if ('ownerStartedAt' in opts) db.prepare('UPDATE dispatches SET owner_started_at = ? WHERE id = ?').run(opts.ownerStartedAt, id);
}

function row(ledger: Ledger, id: number): Record<string, unknown> {
  const r = ledger.get(id);
  if (!r) throw new Error(`row ${id} missing`);
  return r;
}

describe('Ledger.sweepOrphans (temp db)', () => {
  let dir: string;
  let ledger: Ledger;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'heddle-sweep-test-'));
    ledger = new Ledger(join(dir, 'ledger.db'));
  });
  afterEach(() => {
    ledger?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('closes a row older than the age limit: outcome=orphaned, ok=0, reason recorded, gone from inFlight', () => {
    const ghost = startRow(ledger);
    ageRow(ledger, ghost, { hoursAgo: 25, ownerPid: null, ownerComm: null });

    const { candidates, closed } = ledger.sweepOrphans({ isOwnerAlive: () => true });

    expect(closed).toBe(1);
    expect(candidates.map((c) => c.id)).toEqual([ghost]);
    expect(candidates[0].reason).toMatch(/in-flight for 25\.0h \(limit 24\.0h\) and owner unrecorded/);
    const r = row(ledger, ghost);
    expect(r.outcome).toBe('orphaned');
    expect(r.ok).toBe(0);
    expect(String(r.error)).toContain('orphan sweep: in-flight for 25.0h');
    expect(r.finished_at).toBeTruthy();
    expect(ledger.inFlight()).toEqual([]);
  });

  it('closes a young row whose owner process is provably gone, with the pid in the reason', () => {
    const dead = startRow(ledger);
    ageRow(ledger, dead, { hoursAgo: 1, ownerPid: 4242, ownerComm: 'node' });

    const { candidates, closed } = ledger.sweepOrphans({ isOwnerAlive: (pid) => (pid === 4242 ? false : true) });

    expect(closed).toBe(1);
    expect(candidates[0].reason).toBe('owner process 4242 (node) is gone');
    expect(row(ledger, dead).outcome).toBe('orphaned');
  });

  it('leaves a genuinely-running young row untouched (owner alive)', () => {
    const live = startRow(ledger); // owner = this test process, recorded by start()
    ageRow(ledger, live, { hoursAgo: 1 });

    const { candidates, closed } = ledger.sweepOrphans({ isOwnerAlive: () => true });

    expect(closed).toBe(0);
    expect(candidates).toEqual([]);
    const r = row(ledger, live);
    expect(r.finished_at).toBeNull();
    expect(r.outcome).toBeNull();
    expect(ledger.inFlight().map((x) => x.id)).toEqual([live]);
  });

  it('treats unknown liveness (ps unavailable → null) as NOT an orphan', () => {
    const unknown = startRow(ledger);
    ageRow(ledger, unknown, { hoursAgo: 1, ownerPid: 4242, ownerComm: 'node' });

    const { closed } = ledger.sweepOrphans({ isOwnerAlive: () => null });

    expect(closed).toBe(0);
    expect(row(ledger, unknown).finished_at).toBeNull();
  });

  it('rows recorded before the owner columns existed (pid null) close only via the age rule', () => {
    const preMigration = startRow(ledger);
    ageRow(ledger, preMigration, { hoursAgo: 2, ownerPid: null, ownerComm: null });
    // Young + no pid: nothing provable — stays.
    expect(ledger.sweepOrphans({ isOwnerAlive: () => false }).closed).toBe(0);
    // Old + no pid: the age rule closes it (this is exactly Maya's ghost RUNNING(3) rows).
    ageRow(ledger, preMigration, { hoursAgo: 30 });
    expect(ledger.sweepOrphans({ isOwnerAlive: () => null }).closed).toBe(1);
  });

  it('dry-run lists the same candidates and mutates nothing', () => {
    const ghost = startRow(ledger);
    // Null owner: this test process (the stamped owner) is alive, which would rightly veto the
    // age rule — the dry-run contract is what's under test here.
    ageRow(ledger, ghost, { hoursAgo: 48, ownerPid: null });

    const dry = ledger.sweepOrphans({ dryRun: true });

    expect(dry.candidates.map((c) => c.id)).toEqual([ghost]);
    expect(dry.closed).toBe(0);
    const r = row(ledger, ghost);
    expect(r.finished_at).toBeNull();
    expect(r.outcome).toBeNull();
    expect(ledger.inFlight().map((x) => x.id)).toEqual([ghost]);
    // The real sweep afterwards closes exactly what dry-run predicted.
    expect(ledger.sweepOrphans().closed).toBe(1);
  });

  it('a finish() that lands between candidate selection and close always wins', () => {
    const racing = startRow(ledger);
    ageRow(ledger, racing, { hoursAgo: 48 });
    // Simulate the race: the worker's finish() lands first; the sweep's close is guarded by
    // finished_at IS NULL, so it must not overwrite the real outcome.
    ledger.finish(racing, { ok: true, durationMs: 5, outputTokens: 7 });

    const { candidates, closed } = ledger.sweepOrphans();

    expect(closed).toBe(0);
    expect(candidates).toEqual([]); // finished rows are not even candidates
    const r = row(ledger, racing);
    expect(r.ok).toBe(1);
    expect(r.outcome).toBeNull();
    expect(r.output_tokens).toBe(7);
  });

  it('respects a custom max age (owner unknown — a live owner would veto age entirely)', () => {
    const shortLived = startRow(ledger);
    ageRow(ledger, shortLived, { hoursAgo: 3 });
    expect(ledger.sweepOrphans({ isOwnerAlive: () => null }).closed).toBe(0);
    expect(ledger.sweepOrphans({ maxAgeMs: 2 * 3_600_000, isOwnerAlive: () => null }).closed).toBe(1);
    expect(String(row(ledger, shortLived).error)).toContain('limit 2.0h');
  });

  it('start() records this process as the owner (pid + executable basename)', () => {
    const id = startRow(ledger);
    const r = row(ledger, id);
    expect(r.owner_pid).toBe(process.pid);
    expect(typeof r.owner_comm).toBe('string');
    expect((r.owner_comm as string).length).toBeGreaterThan(0);
    const recordedStart = Number(r.owner_started_at);
    expect(Math.abs(recordedStart - (Date.now() - process.uptime() * 1000))).toBeLessThan(5_000);
    expect(DEFAULT_ORPHAN_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe('Ledger.sweepOrphans round-2 semantics (temp db)', () => {
  let dir: string;
  let ledger: Ledger;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'heddle-sweep2-test-'));
    ledger = new Ledger(join(dir, 'ledger.db'));
  });
  afterEach(() => {
    ledger?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('age never overrides a POSITIVE liveness verdict — a long-running dispatch with a live owner stays', () => {
    const marathon = startRow(ledger);
    ageRow(ledger, marathon, { hoursAgo: 30 });
    const { closed, candidates } = ledger.sweepOrphans({ isOwnerAlive: () => true });
    expect(closed).toBe(0);
    expect(candidates).toEqual([]);
    expect(row(ledger, marathon).finished_at).toBeNull();
    // …but with the owner UNKNOWN, the same old row does close.
    expect(ledger.sweepOrphans({ isOwnerAlive: () => null }).closed).toBe(1);
    expect(String(row(ledger, marathon).error)).toContain('owner liveness unknown');
  });

  it('a real finish() after a sweep close would define the terminal record: outcome clears', () => {
    const lazarus = startRow(ledger);
    ageRow(ledger, lazarus, { hoursAgo: 48, ownerPid: null });
    expect(ledger.sweepOrphans({ isOwnerAlive: () => null }).closed).toBe(1);
    expect(row(ledger, lazarus).outcome).toBe('orphaned');
    // The worker was actually alive all along and reports in late.
    ledger.finish(lazarus, { ok: true, durationMs: 9, outputTokens: 3 });
    const r = row(ledger, lazarus);
    expect(r.ok).toBe(1);
    expect(r.outcome).toBeNull();
    expect(r.output_tokens).toBe(3);
  });

  it('the probe receives the recorded owner identity (pid, comm, start time)', () => {
    const id = startRow(ledger);
    ageRow(ledger, id, { hoursAgo: 1, ownerPid: 777, ownerComm: 'node', ownerStartedAt: 123_456 });
    const seen: unknown[] = [];
    ledger.sweepOrphans({ isOwnerAlive: (pid, comm, startedAt) => { seen.push([pid, comm, startedAt]); return true; } });
    expect(seen).toEqual([[777, 'node', 123_456]]);
  });
});

describe('ownerVerdict + parsePsTable (pid-reuse-safe owner identity)', () => {
  const PS = ' 4242 Thu Aug 15 19:59:47 2026 /usr/local/bin/node\n  977 Mon Jan  5 08:00:00 2026 /sbin/launchd\n';
  const T4242 = Date.parse('Thu Aug 15 19:59:47 2026');

  it('a listed pid with a MATCHING start time is the owner — regardless of how ps names the executable', () => {
    const table = parsePsTable(PS);
    expect(ownerVerdict(table.get(4242), 'node', T4242)).toBe(true);
    expect(ownerVerdict(table.get(4242), 'node', T4242 + 10_000)).toBe(true); // within slop
    // Same pid, DIFFERENT start time = a recycled pid (a new process cannot share the old start).
    expect(ownerVerdict(table.get(4242), 'node', T4242 - 3_600_000)).toBe(false);
    // Comm representation quirks (MainThread, truncation) don't matter when start times decide.
    expect(ownerVerdict({ startedAtMs: T4242, comm: 'MainThread' }, 'node', T4242)).toBe(true);
  });

  it('falls back to executable-name comparison when a start time is missing, tolerating 15-char truncation', () => {
    expect(ownerVerdict({ startedAtMs: null, comm: '/usr/local/bin/node' }, 'node', null)).toBe(true);
    expect(ownerVerdict({ startedAtMs: null, comm: 'bun' }, 'node', null)).toBe(false); // reused by something else
    // Linux comm truncates to 15 chars: 'my-single-file-heddle' reports as 'my-single-file-'.
    expect(ownerVerdict({ startedAtMs: null, comm: 'my-single-file-' }, 'my-single-file-heddle', null)).toBe(true);
    // No comm recorded (pre-migration): any listed executable is accepted.
    expect(ownerVerdict({ startedAtMs: null, comm: 'whatever' }, null, null)).toBe(true);
    // Not listed at all = gone.
    expect(ownerVerdict(undefined, 'node', T4242)).toBe(false);
  });

  it('parsePsTable reads pid, ctime start and space-containing executables; garbage lines are skipped', () => {
    const table = parsePsTable(PS + 'garbage\n 12 not a date at all with spaces\n');
    expect(table.get(977)?.comm).toBe('/sbin/launchd');
    expect(table.get(977)?.startedAtMs).toBe(Date.parse('Mon Jan  5 08:00:00 2026'.replace(/\s+/g, ' ')));
    expect(table.get(12)?.startedAtMs).toBeNull();
    expect(table.has(4242)).toBe(true);
  });
});
