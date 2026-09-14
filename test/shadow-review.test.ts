import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CorpusRound, CorpusSummary } from '../scripts/bench-adversarial-review.js';
import { renderShadowReport, runShadowRound, type ShadowDeps } from '../scripts/shadow-review.js';
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

  it('forces a requested dispatch id and records no-such-round when it is absent', () => {
    const root = tempDir();
    const deps = testDeps(root, [round(30), round(20)], [{ ok: false, error: 'judge unavailable' }]);

    expect(runShadowRound({ dispatchId: 20 }, deps)).toMatchObject({ status: 'skipped', dispatchId: 20, reason: 'local-declined:judge unavailable' });
    expect(runShadowRound({ dispatchId: 999 }, deps)).toEqual({ status: 'skipped', dispatchId: 999, reason: 'no-such-round' });
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
    const deps = testDeps(root, [round(30)], [{ ok: true, output: 'candidate', raw: { model: 'loaded-local-model' }, ledgerId: 1500 }, { ok: true, output: judge, ledgerId: 1501 }]);

    expect(runShadowRound({}, deps)).toMatchObject({ status: 'scored', dispatchId: 30, tp: 1, fp: 1, novel: 1, acceptedMatched: 1, recall: 0.5, precision: 0.5 });
    expect(receipts(deps.receiptDir!)[0]).toMatchObject({ status: 'scored', candidateModel: 'loaded-local-model', candidateLedgerId: 1500, judgeLedgerId: 1501, tp: 1, fp: 1, novel: 1, acceptedMatched: 1, recall: 0.5, precision: 0.5 });

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
