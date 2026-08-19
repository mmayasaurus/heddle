import { describe, it, expect } from 'vitest';
import { matchLabel, EFFORT_LABELS, RESULT_LABELS } from '../src/classify.js';

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

  it('prefers a whole-word match over an incidental substring', () => {
    // "lower" contains "low" as a substring but not as a whole word; "high" is the real verdict.
    expect(matchLabel('lower risk, so high effort is not needed — wait, high.', EFFORT))
      .toEqual({ label: 'high', matched: true });
    // A pure substring-only occurrence still matches (fallback), proving substrings aren't lost:
    expect(matchLabel('minimalistic', EFFORT)).toEqual({ label: 'minimal', matched: true });
  });
});
