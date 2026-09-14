import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  aggregateScoredRounds,
  buildCandidatePrompt,
  extractJudgeJson,
  summarizeCorpus,
  type CorpusRound,
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

  it('writes an inline-only candidate prompt with the frozen diff', () => {
    const dir = tempDir();
    const path = buildCandidatePrompt(dir, round());
    const prompt = readFileSync(path, 'utf8');

    expect(prompt).toContain('You have NO repository access and NO code-discovery tools');
    expect(prompt).toContain('VERDICT: <n> findings (<h> high, <m> med, <l> low)');
    expect(prompt).toContain('diff --git a/src/a.ts b/src/a.ts');
  });
});
