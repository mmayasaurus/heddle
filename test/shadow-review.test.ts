import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CorpusRound, CorpusSummary } from '../scripts/bench-adversarial-review.js';
import { countHallucinatedCitations, renderShadowReport, runShadowRound, type ShadowDeps } from '../scripts/shadow-review.js';
import { useTempResources } from './helpers.js';

function round(dispatchId: number, overrides: Partial<CorpusRound> = {}): CorpusRound {
  return {
    dispatchId,
    issue: `HED-${dispatchId}`,
    repo: 'heddle',
    pr: dispatchId + 100,
    authorProvider: 'codex',
    authorModel: 'gpt-5.6',
    reviewerProvider: 'claude',
    reviewerModel: 'opus',
    findingsTotal: 3,
    findingsAccepted: 2,
    notesRaw: 'accepted F1 and F2',
    reviewedHead: 'reviewed',
    forkPoint: 'fork',
    diff: 'diff --git a/a.ts b/a.ts\n+fixed\n',
    ...overrides,
  };
}

function corpusSummary(rounds: CorpusRound[]): CorpusSummary {
  return { totalRows: rounds.length, survived: rounds.length, skipped: [], byPair: {} };
}

function testDeps(root: string, rounds: CorpusRound[], outputs: Array<{ ok: boolean; output?: string; error?: string; raw?: unknown; ledgerId?: number }> = []): ShadowDeps {
  let call = 0;
  return {
    workDir: join(root, 'work'),
    receiptDir: join(root, 'receipts'),
    now: () => new Date('2026-09-14T12:00:00.000Z'),
    buildCorpus: (out) => {
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, 'corpus.jsonl'), `${rounds.map((item) => JSON.stringify(item)).join('\n')}\n`);
      writeFileSync(join(out, 'corpus-summary.json'), JSON.stringify(corpusSummary(rounds)));
      return corpusSummary(rounds);
    },
    dispatchRunner: () => outputs[call++] ?? { ok: true, output: '' },
  };
}

function receipts(path: string): Array<Record<string, unknown>> {
  const file = join(path, 'receipts.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>) : [];
}

describe('shadow review', () => {
  const { tempDir } = useTempResources('heddle-shadow-review-');

  it('selects the next-newest unscored corpus round and idles without a receipt when all are scored', () => {
    const root = tempDir();
    const rounds = [round(30), round(20), round(10)];
    const deps = testDeps(root, rounds, [{ ok: true, output: 'candidate' }, { ok: false, error: 'judge unavailable' }]);
    mkdirSync(deps.receiptDir!, { recursive: true });
    writeFileSync(join(deps.receiptDir!, 'receipts.jsonl'), `${JSON.stringify({ dispatchId: 30, status: 'scored' })}\n`);

    expect(runShadowRound({}, deps)).toMatchObject({ status: 'skipped', dispatchId: 20, reason: 'judge-failed:judge unavailable' });

    const allScored = testDeps(root, rounds);
    writeFileSync(join(allScored.receiptDir!, 'receipts.jsonl'), rounds.map((item) => JSON.stringify({ dispatchId: item.dispatchId, status: 'scored' })).join('\n') + '\n');
    expect(runShadowRound({}, allScored)).toEqual({ status: 'skipped', reason: 'no-qualifying-round' });
    expect(receipts(allScored.receiptDir!)).toHaveLength(3);
  });

  it('forces a requested dispatch id, refuses an already-scored id without a duplicate, and reports no-such-round when absent', () => {
    const root = tempDir();
    const deps = testDeps(root, [round(30), round(20)], [{ ok: false, error: 'judge unavailable' }]);

    expect(runShadowRound({ dispatchId: 20 }, deps)).toMatchObject({ status: 'skipped', dispatchId: 20, reason: 'local-declined:judge unavailable' });
    expect(runShadowRound({ dispatchId: 999 }, deps)).toEqual({ status: 'skipped', dispatchId: 999, reason: 'no-such-round' });

    // qodo #1: a forced id already in the scored receipts is refused (not re-scored → no duplicate diff).
    const scoredRoot = tempDir();
    const scored = testDeps(scoredRoot, [round(30), round(20)]);
    mkdirSync(scored.receiptDir!, { recursive: true });
    writeFileSync(join(scored.receiptDir!, 'receipts.jsonl'), `${JSON.stringify({ dispatchId: 30, status: 'scored' })}\n`);
    expect(runShadowRound({ dispatchId: 30 }, scored)).toEqual({ status: 'skipped', dispatchId: 30, reason: 'already-scored' });
    expect(receipts(scored.receiptDir!).filter((receipt) => receipt.status === 'scored')).toHaveLength(1);
  });

  it('records local ram-pressure and reachability declines without scoring', () => {
    const root = tempDir();
    const pressure = testDeps(root, [round(30)], [{ ok: false, error: 'local: ram-pressure level 2 >= 2, declined' }]);
    expect(runShadowRound({}, pressure)).toMatchObject({ status: 'skipped', reason: 'local-declined:local: ram-pressure level 2 >= 2, declined' });
    expect(receipts(pressure.receiptDir!)[0]).toMatchObject({ status: 'skipped', reason: expect.stringContaining('ram-pressure') });

    const unreachable = testDeps(tempDir(), [round(31)], [{ ok: false, error: 'local: LM Studio not reachable at http://localhost:1234/v1 (/v1/models)' }]);
    expect(runShadowRound({}, unreachable)).toMatchObject({ status: 'skipped', reason: expect.stringContaining('not reachable') });
  });

  it('scores a judged round, records the actual local model, and writes nothing during dry runs', () => {
    const root = tempDir();
    const judge = JSON.stringify({
      roundId: 30,
      candidateFindings: [
        { idx: 1, class: 'TP', matchesAcceptedIncumbent: true, rationale: 'same defect' },
        { idx: 2, class: 'FP', matchesAcceptedIncumbent: false, rationale: 'unsupported' },
        { idx: 3, class: 'NOVEL', matchesAcceptedIncumbent: false, rationale: 'new concern' },
      ],
      acceptedIncumbentMatchedCount: 1,
    });
    // The candidate output cites a.ts:1; round(30)'s diff has no +++/@@ hunk, so the citation is hallucinated
    // — this proves dispatchScoreReceipt runs the post-check against the REAL selected.diff and persists it.
    const deps = testDeps(root, [round(30)], [{ ok: true, output: 'F1: high, a.ts:1, off-by-one', raw: { model: 'loaded-local-model' }, ledgerId: 1500 }, { ok: true, output: judge, ledgerId: 1501 }]);

    expect(runShadowRound({}, deps)).toMatchObject({ status: 'scored', dispatchId: 30, tp: 1, fp: 1, novel: 1, acceptedMatched: 1, recall: 0.5, precision: 0.5 });
    expect(receipts(deps.receiptDir!)[0]).toMatchObject({ status: 'scored', candidateModel: 'loaded-local-model', candidateLedgerId: 1500, judgeLedgerId: 1501, tp: 1, fp: 1, novel: 1, acceptedMatched: 1, hallucinatedCitations: 1, recall: 0.5, precision: 0.5 });

    const dry = testDeps(tempDir(), [round(30)], [{ ok: true, output: 'candidate' }, { ok: true, output: judge }]);
    expect(runShadowRound({ dryRun: true }, dry)).toMatchObject({ status: 'scored' });
    expect(receipts(dry.receiptDir!)).toEqual([]);
  });

  it('renders the four-gate promotion bar (count/days/relative precision/hallucination), pairs, and skips', () => {
    const report = renderShadowReport([
      { status: 'scored', dispatchId: 1, issue: 'HED-1', pr: 1, repo: 'heddle', authorProvider: 'codex', reviewerProvider: 'claude', reviewerModel: 'opus', candidateProvider: 'local', candidateModel: 'local', findingsTotal: 2, tp: 2, fp: 1, novel: 1, acceptedMatched: 1, findingsAccepted: 2, recall: 0.5, precision: 2 / 3, at: '2026-09-14T12:00:00.000Z' },
      { status: 'scored', dispatchId: 2, issue: 'HED-2', pr: 2, repo: 'heddle', authorProvider: 'codex', reviewerProvider: 'codex', reviewerModel: 'gpt-5.6-sol', candidateProvider: 'local', candidateModel: 'local', findingsTotal: 2, tp: 1, fp: 0, novel: 2, acceptedMatched: 2, findingsAccepted: 2, recall: 1, precision: 1, at: '2026-09-19T12:00:00.000Z' },
      { status: 'skipped', reason: 'local-declined:ram-pressure', at: '2026-09-14T12:00:00.000Z' },
      { status: 'skipped', reason: 'local-declined:ram-pressure', at: '2026-09-14T12:00:00.000Z' },
    ]);

    // recall (75%) is reported but flagged NOT a gate; the bar is count/days/relative-precision/hallucination.
    expect(report).toContain('2 rounds scored, 3 novel, recall 75.0% (informational — NOT a promotion gate)');
    expect(report).toContain('diffs: 2/20');
    expect(report).toContain('calendar days elapsed: 5.0/5');
    // gate precision = confirmed-real/raised: local tp/(tp+fp+novel)=3/7=42.9% vs cloud accepted/raised=4/4=100% → below.
    expect(report).toContain('precision (confirmed-real/raised, same diffs — the gate): local 42.9% vs cloud 100.0%');
    expect(report).toContain('context: local excl. NOVEL = 75.0%');
    expect(report).toContain('hallucinated citations surviving file:line check: pending');
    expect(report).toContain('claude/opus');
    expect(report).toContain('codex/gpt-5.6-sol');
    expect(report).toContain('local-declined:ram-pressure (2)');
  });

  it('rejects a self-contradictory judge (matched > 0 with no TP finding) as score-failed, writing no receipt (qodo #3)', () => {
    const root = tempDir();
    const contradictory = JSON.stringify({
      roundId: 30,
      candidateFindings: [{ idx: 1, class: 'NOVEL', matchesAcceptedIncumbent: false, rationale: 'nothing actually matched' }],
      acceptedIncumbentMatchedCount: 2,
    });
    const deps = testDeps(root, [round(30)], [{ ok: true, output: 'candidate' }, { ok: true, output: contradictory }]);
    expect(runShadowRound({}, deps)).toMatchObject({ status: 'skipped', dispatchId: 30, reason: expect.stringContaining('score-failed') });
    expect(receipts(deps.receiptDir!).filter((receipt) => receipt.status === 'scored')).toHaveLength(0);
  });

  it('deduplicates scored receipts by dispatch id, and keeps the hallucination gate pending until every round is checked (qodo #1, #2)', () => {
    const base = { issue: 'HED-1', pr: 1, repo: 'heddle' as const, authorProvider: 'codex', reviewerProvider: 'claude', reviewerModel: 'opus', candidateProvider: 'local' as const, candidateModel: 'local', findingsTotal: 2, findingsAccepted: 2, tp: 1, fp: 0, novel: 0, acceptedMatched: 1, recall: 0.5, precision: 1, at: '2026-09-14T12:00:00.000Z', status: 'scored' as const };

    // dedup: two receipts with the SAME dispatchId count as one distinct diff.
    const deduped = renderShadowReport([{ ...base, dispatchId: 7 }, { ...base, dispatchId: 7 }]);
    expect(deduped).toContain('1 rounds scored');
    expect(deduped).toContain('diffs: 1/20');

    // hallucination gate KNOWN for only SOME rounds → stays pending with checked/total (never a false pass).
    const partial = renderShadowReport([{ ...base, dispatchId: 1, hallucinatedCitations: 0 }, { ...base, dispatchId: 2 }]);
    expect(partial).toContain('hallucinated citations surviving file:line check: pending — 1/2 rounds checked');

    // hallucination gate KNOWN for ALL rounds → concrete count + pass tick.
    const complete = renderShadowReport([{ ...base, dispatchId: 1, hallucinatedCitations: 0 }, { ...base, dispatchId: 2, hallucinatedCitations: 0 }]);
    expect(complete).toContain('hallucinated citations surviving file:line check: 0 ✓');
  });

  it('is dormant: injected execution touches only work and receipt directories', () => {
    const root = tempDir();
    const deps = testDeps(root, [round(30)], [{ ok: false, error: 'local: LM Studio not reachable' }]);
    const result = runShadowRound({}, deps);

    expect(result.status).toBe('skipped');
    expect(existsSync(join(root, 'Library', 'LaunchAgents', 'com.heddle.shadow-review.plist'))).toBe(false);
    expect(existsSync(join(root, 'routing.yaml'))).toBe(false);
    expect(existsSync(join(root, 'lanes.yaml'))).toBe(false);
  });
});

describe('countHallucinatedCitations (HED-568 gate-4 post-check)', () => {
  // A one-file unified diff whose NEW side is the half-open range [newStart, newStart + newCount).
  const diffFoo = (newStart: number, newCount: number): string =>
    `diff --git a/src/foo.ts b/src/foo.ts\n--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1,${newCount} +${newStart},${newCount} @@\n ctx\n+added\n ctx\n`;

  it('(a) counts 0 for a citation to a real file on a line inside a hunk range', () => {
    expect(countHallucinatedCitations('F1: high, src/foo.ts:2, off-by-one', diffFoo(1, 3))).toBe(0);
  });

  it('(b) counts a citation to a file absent from the diff as hallucinated', () => {
    expect(countHallucinatedCitations('F1: high, src/bar.ts:2, phantom file', diffFoo(1, 3))).toBe(1);
  });

  it('(c) counts a real file cited at a line outside every hunk range as hallucinated', () => {
    expect(countHallucinatedCitations('F1: med, src/foo.ts:99, line not in any hunk', diffFoo(1, 3))).toBe(1);
  });

  it('(d) resolves an overlapping range citation and flags one entirely outside', () => {
    // new-side range [12, 15) — lines 12,13,14.
    const diff = 'diff --git a/src/foo.ts b/src/foo.ts\n--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -10,3 +12,3 @@\n ctx\n+added\n ctx\n';
    expect(countHallucinatedCitations('F1: low, src/foo.ts:10-14, spans into the hunk', diff)).toBe(0);
    expect(countHallucinatedCitations('F1: low, src/foo.ts:20-25, entirely past the hunk', diff)).toBe(1);
  });

  it('(e) dedupes distinct hallucinations by path:startLine (1 valid + a duplicated invalid pair → 1)', () => {
    const output = 'F1: high, src/foo.ts:2, real\nF2: med, src/gone.ts:7, fabricated\nF3: low, src/gone.ts:7, fabricated again';
    expect(countHallucinatedCitations(output, diffFoo(1, 3))).toBe(1);
  });

  it('(f) counts 0 for empty output or output with no parseable citation', () => {
    expect(countHallucinatedCitations('', diffFoo(1, 3))).toBe(0);
    expect(countHallucinatedCitations('No file references here — VERDICT: 0 findings', diffFoo(1, 3))).toBe(0);
  });

  it('(g) resolves a basename-only citation against a diffed nested path (lenient prefix)', () => {
    expect(countHallucinatedCitations('F1: high, foo.ts:3, basename resolves to src/foo.ts', diffFoo(1, 3))).toBe(0);
  });
});
