import { describe, it, expect } from 'vitest';
import { Ledger } from '../src/ledger.js';
import { dispatch, monocultureNote, formatMonocultureWarning, type MonocultureNote } from '../src/dispatch.js';
import { useTempResources, fakeAdapter, IDENTITIES } from './helpers.js';

/**
 * HED-148 part B: the monoculture warning's trailing-8h window is measured off an injectable `now`,
 * but Ledger.start() always stamps `new Date().toISOString()` and cannot backdate — so rows are
 * seeded with a controlled `started_at` via direct SQL against the same db, bypassing the public API.
 */
const NOW = new Date('2026-08-17T12:00:00.000Z');

function hoursBefore(hours: number): string {
  return new Date(NOW.getTime() - hours * 3_600_000).toISOString();
}

function seed(ledger: Ledger, row: {
  orchestrator: string; provider: string; direct: boolean; hoursAgo: number; refused?: boolean;
}): void {
  const db = (ledger as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).db;
  const taskClass = row.direct ? `direct:${row.provider}/some-model` : `some-class:${row.provider}`;
  const startedAt = hoursBefore(row.hoursAgo);
  db.prepare(`
    INSERT INTO dispatches (orchestrator, task_class, provider, model, cwd, prompt_preview, started_at, finished_at, ok, refusal)
    VALUES (?, ?, ?, 'some-model', '/tmp/x', 'seed', ?, ?, ?, ?)
  `).run(
    row.orchestrator, taskClass, row.provider, startedAt,
    row.refused ? startedAt : null, row.refused ? 0 : 1, row.refused ? 'override-reason-required' : null,
  );
}

describe('monocultureNote', () => {
  const { tempLedger } = useTempResources('heddle-monoculture-test-');

  it('fires on 5 direct codex dispatches, naming the provider and reporting both mixes', () => {
    const ledger = tempLedger();
    for (let i = 0; i < 5; i++) seed(ledger, { orchestrator: 'U', provider: 'codex', direct: true, hoursAgo: 1 });
    for (let i = 0; i < 3; i++) seed(ledger, { orchestrator: 'U', provider: 'cursor', direct: false, hoursAgo: 1 });
    for (let i = 0; i < 2; i++) seed(ledger, { orchestrator: 'U', provider: 'gemini', direct: false, hoursAgo: 1 });

    const note = monocultureNote(ledger, 'U', { now: NOW });

    expect(note).not.toBeNull();
    expect(note?.provider).toBe('codex');
    expect(note?.directCount).toBe(5);
    expect(note?.directPct).toBe(100);
    expect(note?.directMix).toEqual({ codex: 5 });
    expect(note?.classRoutedMix).toEqual({ cursor: 3, gemini: 2 });
  });

  it('stays null below the floor of 5 qualifying direct dispatches', () => {
    const ledger = tempLedger();
    for (let i = 0; i < 4; i++) seed(ledger, { orchestrator: 'U', provider: 'codex', direct: true, hoursAgo: 1 });

    expect(monocultureNote(ledger, 'U', { now: NOW })).toBeNull();
  });

  it('never fires on class-routed dispatches alone, however lopsided — class routing is the diversification lever', () => {
    const ledger = tempLedger();
    for (let i = 0; i < 10; i++) seed(ledger, { orchestrator: 'U', provider: 'codex', direct: false, hoursAgo: 1 });

    expect(monocultureNote(ledger, 'U', { now: NOW })).toBeNull();
  });

  it('stays null when the direct mix is split and no provider exceeds 60%', () => {
    const ledger = tempLedger();
    for (let i = 0; i < 3; i++) seed(ledger, { orchestrator: 'U', provider: 'codex', direct: true, hoursAgo: 1 });
    for (let i = 0; i < 3; i++) seed(ledger, { orchestrator: 'U', provider: 'cursor', direct: true, hoursAgo: 1 });

    expect(monocultureNote(ledger, 'U', { now: NOW })).toBeNull();
  });

  it('excludes rows older than the trailing 8h window', () => {
    const ledger = tempLedger();
    // Outside the window: would dominate (6 vs 5) if wrongly counted, and would name the wrong provider.
    for (let i = 0; i < 6; i++) seed(ledger, { orchestrator: 'U', provider: 'codex', direct: true, hoursAgo: 9 });
    for (let i = 0; i < 5; i++) seed(ledger, { orchestrator: 'U', provider: 'cursor', direct: true, hoursAgo: 1 });

    const note = monocultureNote(ledger, 'U', { now: NOW });

    expect(note?.provider).toBe('cursor');
    expect(note?.directCount).toBe(5);
    expect(note?.directMix).toEqual({ cursor: 5 });
  });

  it('excludes refused direct rows — a refused dispatch never ran', () => {
    const ledger = tempLedger();
    // Refused: would dominate if wrongly counted, and would name the wrong provider.
    for (let i = 0; i < 5; i++) seed(ledger, { orchestrator: 'U', provider: 'codex', direct: true, hoursAgo: 1, refused: true });
    for (let i = 0; i < 5; i++) seed(ledger, { orchestrator: 'U', provider: 'cursor', direct: true, hoursAgo: 1 });

    const note = monocultureNote(ledger, 'U', { now: NOW });

    expect(note?.provider).toBe('cursor');
    expect(note?.directCount).toBe(5);
    expect(note?.directMix).toEqual({ cursor: 5 });
  });

  it('scopes the window to the named agent — another orchestrator\'s direct rows never count', () => {
    const ledger = tempLedger();
    for (let i = 0; i < 5; i++) seed(ledger, { orchestrator: 'OTHER', provider: 'codex', direct: true, hoursAgo: 1 });

    expect(monocultureNote(ledger, 'U', { now: NOW })).toBeNull();
  });
});

describe('formatMonocultureWarning', () => {
  it('renders one line with both mixes, each sorted by count descending', () => {
    const note: MonocultureNote = {
      provider: 'codex', directCount: 5, directPct: 100,
      directMix: { codex: 5 },
      classRoutedMix: { cursor: 3, gemini: 2 },
    };

    expect(formatMonocultureWarning(note)).toBe(
      'monoculture-warning: direct dispatches are 100% codex over 8h ' +
      '(direct: 5 codex; class-routed: 3 cursor, 2 gemini) — ' +
      'this route has a task class; dispatch by class to spread load',
    );
  });

  it('sorts a multi-provider direct mix by count descending and shows "none" for an empty class-routed mix', () => {
    const note: MonocultureNote = {
      provider: 'codex', directCount: 8, directPct: 62.5,
      directMix: { codex: 5, cursor: 2, gemini: 1 },
      classRoutedMix: {},
    };

    expect(formatMonocultureWarning(note)).toBe(
      'monoculture-warning: direct dispatches are 63% codex over 8h ' +
      '(direct: 5 codex, 2 cursor, 1 gemini; class-routed: none) — ' +
      'this route has a task class; dispatch by class to spread load',
    );
  });
});

// The unit tests above pin the mix MATH; these prove dispatch() actually WIRES it — fires the stderr
// warning on an admitted lopsided direct dispatch, and stays quiet when the agent is diverse. Without
// this, the wiring at dispatch.ts could be deleted and every test above would still pass (grok, HED-148 review).
describe('dispatch() monoculture wiring', () => {
  const { tempLedger, tempDir } = useTempResources('heddle-monoculture-dispatch-');

  const seedDirect = (ledger: Ledger, providers: string[]): void => {
    const db = (ledger as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).db;
    // dispatch() measures the window against REAL time (unlike monocultureNote's injectable `now`), so
    // seed the qualifying direct rows inside the real trailing 8h.
    const recent = new Date(Date.now() - 3_600_000).toISOString();
    for (const provider of providers) {
      db.prepare(`INSERT INTO dispatches (orchestrator, task_class, provider, model, cwd, prompt_preview, started_at, finished_at, ok, refusal)
        VALUES ('U', ?, ?, 'm', '/tmp/x', 'seed', ?, ?, 1, NULL)`).run(`direct:${provider}/m`, provider, recent, recent);
    }
  };

  const captureStderr = async (fn: () => Promise<void>): Promise<string> => {
    const originalWrite = process.stderr.write;
    const lines: string[] = [];
    process.stderr.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try { await fn(); } finally { process.stderr.write = originalWrite; }
    return lines.join('');
  };

  const directCodex = (ledger: Ledger) => dispatch(
    { provider: 'codex', model: 'gpt-5.6-terra', prompt: 'x', cwd: tempDir(), identity: IDENTITIES.unbound, orchestrator: 'U',
      overrideReason: 'benchmarking a terra latency regression specific to this workload' },
    ledger, () => fakeAdapter(undefined, { readAgents: false }).adapter,
  );

  it('fires the stderr warning when admitting a direct dispatch for a lopsided agent', async () => {
    const ledger = tempLedger();
    seedDirect(ledger, ['codex', 'codex', 'codex', 'codex', 'codex']);
    let admitted = false;
    const out = await captureStderr(async () => { admitted = (await directCodex(ledger)).ok; });
    expect(admitted).toBe(true); // a REAL reason is admitted; the warning is advisory on an accepted dispatch
    expect(out).toContain('monoculture-warning');
    expect(out).toContain('100% codex');
  });

  it('stays quiet when the agent is diverse across direct picks (top provider not over 60%)', async () => {
    const ledger = tempLedger();
    seedDirect(ledger, ['codex', 'codex', 'cursor', 'cursor', 'cursor']); // cursor 3/5 = 60%, not > 60%
    const out = await captureStderr(async () => { await directCodex(ledger); });
    expect(out).not.toContain('monoculture-warning');
  });
});
