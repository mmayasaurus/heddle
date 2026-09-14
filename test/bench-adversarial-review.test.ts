import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  aggregateScoredRounds,
  asJudgeResult,
  buildCandidatePrompt,
  extractJudgeJson,
  reconstructReviewedDiff,
  summarizeCorpus,
  type CorpusRound,
  type GhRunner,
  type GitRunner,
  type ScoredRound,
} from '../scripts/bench-adversarial-review.js';
import { useTempResources } from './helpers.js';

function round(overrides: Partial<CorpusRound> = {}): CorpusRound {
  return {
    dispatchId: 41,
    issue: 'HED-41',
    repo: 'heddle',
    pr: 99,
    authorProvider: 'codex',
    authorModel: 'gpt-5',
    reviewerProvider: 'cursor',
    reviewerModel: 'grok',
    findingsTotal: 3,
    findingsAccepted: 2,
    notesRaw: 'accepted F1 and F2',
    reviewedHead: 'aaaaaaaaa',
    forkPoint: 'ffffffff0',
    diff: 'diff --git a/src/a.ts b/src/a.ts\n+@@ -1 +1 @@\n+-old\n++new\n',
    ...overrides,
  };
}

describe('adversarial review bench harness', () => {
  const { tempDir } = useTempResources('heddle-adv-review-prompt-');

  it('aggregates recall, precision, and novel findings by author-to-reviewer pair', () => {
    const rounds: ScoredRound[] = [
      { ...round(), tp: 2, fp: 1, novel: [{ idx: 4, rationale: 'visible missing bounds check' }], acceptedMatched: 2 },
      { ...round({ dispatchId: 42, findingsAccepted: 4 }), tp: 1, fp: 0, novel: [], acceptedMatched: 3 },
      { ...round({ dispatchId: 43, authorProvider: 'claude', reviewerProvider: 'codex', findingsAccepted: 1 }), tp: 0, fp: 2, novel: [{ idx: 1, rationale: 'a second novel concern' }], acceptedMatched: 0 },
    ];

    const result = aggregateScoredRounds('glm-5.3', rounds, { totalRows: 5, survived: 3, skipped: [], byPair: {} });

    expect(result.totals).toMatchObject({ rounds: 3, tp: 3, fp: 3, novel: 2, acceptedMatched: 5, findingsAccepted: 7, recall: 5 / 7, precision: 0.5 });
    expect(result.byPair['codex:cursor']).toMatchObject({ rounds: 2, tp: 3, fp: 1, novel: 1, acceptedMatched: 5, findingsAccepted: 6, recall: 5 / 6, precision: 0.75 });
    expect(result.byPair['claude:codex']).toMatchObject({ rounds: 1, tp: 0, fp: 2, novel: 1, acceptedMatched: 0, findingsAccepted: 1, recall: 0, precision: 0 });
  });

  it('extracts the judge JSON object from fenced or prose-wrapped output', () => {
    const json = '{"roundId":41,"candidateFindings":[{"idx":1,"class":"TP","matchesAcceptedIncumbent":true,"rationale":"same defect"}],"acceptedIncumbentMatchedCount":1}';
    expect(extractJudgeJson(`Judge result:\n\n\`\`\`json\n${json}\n\`\`\``)).toEqual(JSON.parse(json));
    expect(extractJudgeJson(`I found this: ${json}\nThanks.`)).toEqual(JSON.parse(json));
  });

  it('prefers the roundId object over a non-answer object emitted before it', () => {
    const real = '{"roundId":41,"candidateFindings":[],"acceptedIncumbentMatchedCount":0}';
    // A leading, parseable object that lacks roundId (an example/scratch object) must not shadow the answer.
    expect(extractJudgeJson(`For example: {"idx":1,"class":"TP"}\nActual: ${real}`)).toEqual(JSON.parse(real));
  });

  it('rejects a judge finding whose TP class disagrees with matchesAcceptedIncumbent', () => {
    const bad = { roundId: 41, candidateFindings: [{ idx: 1, class: 'TP', matchesAcceptedIncumbent: false, rationale: 'x' }], acceptedIncumbentMatchedCount: 0 };
    expect(() => asJudgeResult(bad, round())).toThrow(/class TP must match matchesAcceptedIncumbent/);
    const good = { roundId: 41, candidateFindings: [{ idx: 1, class: 'NOVEL', matchesAcceptedIncumbent: false, rationale: 'x' }], acceptedIncumbentMatchedCount: 0 };
    expect(asJudgeResult(good, round()).candidateFindings).toHaveLength(1);
    const badIdx = { roundId: 41, candidateFindings: [{ idx: 0, class: 'NOVEL', matchesAcceptedIncumbent: false, rationale: 'x' }], acceptedIncumbentMatchedCount: 0 };
    expect(() => asJudgeResult(badIdx, round())).toThrow(/finding 1 is invalid/);
  });

  it('reconstructs the pre-fix diff at the last commit before the review started', () => {
    const started = '2026-09-14T00:38:47.938Z';
    const gh: GhRunner = () => JSON.stringify({
      mergeCommit: { oid: 'mergeoid0' },
      commits: [
        { oid: 'preA00000', committedDate: '2026-09-14T00:10:00Z' },
        { oid: 'preB00000', committedDate: '2026-09-14T00:34:33Z' }, // last commit before the review
        { oid: 'fix000000', committedDate: '2026-09-14T01:16:43Z' }, // post-review fix, must be excluded
      ],
    });
    const calls: string[][] = [];
    const git: GitRunner = (_root, args) => {
      calls.push([...args]);
      if (args[0] === 'rev-list') return 'mergeoid0 p1main000 p2branch0\n';
      if (args[0] === 'merge-base') return 'forkpoint0\n';
      if (args[0] === 'diff') return 'diff --git a/x b/x\n+pre-fix\n';
      return '';
    };
    const result = reconstructReviewedDiff(99, 'heddle', started, gh, git);
    expect(result).toEqual({ diff: 'diff --git a/x b/x\n+pre-fix\n', reviewedHead: 'preB00000', forkPoint: 'forkpoint0' });
    // The diff is taken against the fork point and the pre-review HEAD — never the merged branch tip.
    expect(calls).toContainEqual(['merge-base', 'p1main000', 'p2branch0']);
    expect(calls).toContainEqual(['diff', 'forkpoint0', 'preB00000']);
  });

  it('skips a round whose merge commit is not a 2-parent merge (squash/rebase)', () => {
    const gh: GhRunner = () => JSON.stringify({ mergeCommit: { oid: 'squash000' }, commits: [{ oid: 'c1', committedDate: '2026-09-14T00:10:00Z' }] });
    const git: GitRunner = (_root, args) => (args[0] === 'rev-list' ? 'squash000 onlyparent\n' : '');
    expect(reconstructReviewedDiff(99, 'heddle', '2026-09-14T00:38:47.938Z', gh, git)).toEqual({ skip: 'non-merge-commit(1p)' });
  });

  it('counts corpus rows per author-to-reviewer pair in the summary', () => {
    const summary = summarizeCorpus(4, [round(), round({ dispatchId: 42 }), round({ dispatchId: 43, authorProvider: 'claude', reviewerProvider: 'codex' })], [
      { dispatchId: 44, issue: 'HED-44', reason: 'ambiguous-pr-map' },
    ]);

    expect(summary).toEqual({
      totalRows: 4,
      survived: 3,
      skipped: [{ dispatchId: 44, issue: 'HED-44', reason: 'ambiguous-pr-map' }],
      byPair: { 'claude:codex': 1, 'codex:cursor': 2 },
    });
  });

  it('writes an inline-only candidate prompt with the reconstructed diff', () => {
    const dir = tempDir();
    const path = buildCandidatePrompt(dir, round());
    const prompt = readFileSync(path, 'utf8');

    expect(prompt).toContain('You have NO repository access and NO code-discovery tools');
    expect(prompt).toContain('VERDICT: <n> findings (<h> high, <m> med, <l> low)');
    expect(prompt).toContain('diff --git a/src/a.ts b/src/a.ts');
  });
});
