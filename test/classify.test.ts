import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the codex adapter so classify() gets a CANNED reply without a live dispatch, and the ledger so
// a classification never touches real SQLite. Both classifiers (effort=luna, assess=terra) are codex.
const { dispatchMock } = vi.hoisted(() => ({ dispatchMock: vi.fn() }));
vi.mock('../src/adapters/codex.js', () => ({
  CodexAdapter: class { dispatch = dispatchMock; },   // `new CodexAdapter()` → { dispatch: canned }
}));
vi.mock('../src/ledger.js', () => ({
  Ledger: class { recordClassification() { /* no-op */ } close() { /* no-op */ } },
}));

import { matchLabel, classifyEffort, assessResult, EFFORT_LABELS, RESULT_LABELS } from '../src/classify.js';

const EFFORT = [...EFFORT_LABELS];
const RESULT = [...RESULT_LABELS];

describe('matchLabel — classifier reply → label', () => {
  it('matches an exact single-word reply', () => {
    expect(matchLabel('high', EFFORT)).toEqual({ label: 'high', matched: true });
    expect(matchLabel('done', RESULT)).toEqual({ label: 'done', matched: true });
  });

  it('matches a label embedded in a sentence (whole-word)', () => {
    expect(matchLabel('I think this needs high effort.', EFFORT)).toEqual({ label: 'high', matched: true });
    expect(matchLabel('Verdict: needs-human, the operator must decide.', RESULT))
      .toEqual({ label: 'needs-human', matched: true });
  });

  it('tolerates hyphen/space variants of a hyphenated label', () => {
    expect(matchLabel('needs rework', RESULT)).toEqual({ label: 'needs-rework', matched: true });
    expect(matchLabel('needs-rework', RESULT)).toEqual({ label: 'needs-rework', matched: true });
    expect(matchLabel('NEEDS HUMAN', RESULT)).toEqual({ label: 'needs-human', matched: true });
  });

  it('is case-insensitive', () => {
    expect(matchLabel('MINIMAL', EFFORT)).toEqual({ label: 'minimal', matched: true });
  });

  // The core HED-20 property: a no-match returns undefined, NEVER labels[0].
  it('returns undefined (matched:false) on garbage — never labels[0] (minimal/done)', () => {
    const g1 = matchLabel("I'm not sure, could be a few things?", EFFORT);
    expect(g1).toEqual({ label: undefined, matched: false });
    expect(g1.label).not.toBe('minimal');
    const g2 = matchLabel('The worker did some stuff, hard to say.', RESULT);
    expect(g2).toEqual({ label: undefined, matched: false });
    expect(g2.label).not.toBe('done');
  });

  it('returns undefined (matched:false) on an empty / whitespace reply', () => {
    expect(matchLabel('', EFFORT)).toEqual({ label: undefined, matched: false });
    expect(matchLabel('   \n  ', RESULT)).toEqual({ label: undefined, matched: false });
  });

  it('prefers a whole-word match but still falls back to a substring', () => {
    expect(matchLabel('lower risk, so high effort is not needed — wait, high.', EFFORT))
      .toEqual({ label: 'high', matched: true });
    expect(matchLabel('minimalistic', EFFORT)).toEqual({ label: 'minimal', matched: true });
  });
});

// Guards the WIRING at classify()'s return boundary + the fallbacks — a regression re-adding
// `?? labels[0]` (effort='minimal' / result='done') would pass the pure matchLabel tests but FAIL here.
describe('classifyEffort / assessResult — no-match wiring (HED-20)', () => {
  const canned = (output: string) =>
    dispatchMock.mockResolvedValue({ ok: true, output, durationMs: 1, usage: {} });
  beforeEach(() => dispatchMock.mockReset());

  it('classifyEffort returns undefined on a garbage reply — NEVER minimal', async () => {
    canned('hmm, not sure, it could be a number of things');
    expect(await classifyEffort('implementation', 'do a thing')).toBeUndefined();
  });

  it('classifyEffort returns the matched level on a clean reply', async () => {
    canned('high');
    expect(await classifyEffort('implementation', 'do a thing')).toBe('high');
  });

  it('assessResult returns needs-human (matched:false) on a garbage reply — NEVER done', async () => {
    canned('the worker did some stuff, hard to say');
    expect(await assessResult('task', 'output', true)).toEqual({ label: 'needs-human', matched: false });
  });

  it('assessResult returns the matched verdict on a clean reply', async () => {
    canned('done');
    expect(await assessResult('task', 'output', true)).toEqual({ label: 'done', matched: true });
  });
});
