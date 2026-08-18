import { describe, it, expect } from 'vitest';
import { Ledger } from '../src/ledger.js';
import { monocultureNote, formatMonocultureWarning, type MonocultureNote } from '../src/dispatch.js';
import { useTempResources } from './helpers.js';

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
