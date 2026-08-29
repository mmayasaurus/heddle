import { describe, expect, it } from 'vitest';
import {
  computePrSweepVerdict,
  dispositionReceipts,
  isDispositionedReview,
  runPrSweep,
  type GhRunner,
} from '../src/pr-sweep.js';

const submittedAt = '2026-08-28T12:00:00Z';

interface SweepFixture {
  reviews?: unknown[];
  threads?: unknown[];
  alerts?: unknown[];
  checks?: unknown[];
  mergeable?: boolean;
  mergeStateStatus?: string;
  comments?: unknown[];
}

function ghFor({
  reviews = [], threads = [], alerts = [], checks = [], mergeable = true, mergeStateStatus = 'CLEAN', comments = [],
}: SweepFixture = {}): GhRunner {
  return (args) => {
    const command = args.join(' ');
    if (command === 'repo view --json nameWithOwner') return JSON.stringify({ nameWithOwner: 'acme/widgets' });
    if (command.startsWith('api repos/acme/widgets/pulls/7/commits')) return JSON.stringify([{ commit: { committer: { date: '2026-08-28T11:00:00Z' } } }]);
    if (command === 'api repos/acme/widgets/pulls/7') return JSON.stringify({ number: 7, title: 'Sweep me', state: 'open', head: { sha: 'abcdef1234567890' }, mergeable, mergeable_state: mergeStateStatus.toLowerCase() });
    if (command.startsWith('api repos/acme/widgets/issues/7/comments')) return JSON.stringify(comments);
    if (command.startsWith('api repos/acme/widgets/pulls/7/reviews')) return JSON.stringify(reviews);
    if (command.startsWith('api graphql')) return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { totalCount: threads.length, nodes: threads } } } } });
    if (command.startsWith('api repos/acme/widgets/code-scanning/alerts')) return JSON.stringify(alerts);
    if (command.startsWith('api repos/acme/widgets/commits/abcdef1234567890/check-runs')) return JSON.stringify({ check_runs: checks });
    if (command.startsWith('api repos/acme/widgets/commits/abcdef1234567890/status')) return JSON.stringify({ statuses: [] });
    throw new Error(`unexpected gh call: ${command}`);
  };
}

describe('PR sweep', () => {
  it('returns clean for a PR with no mechanical failures', () => {
    const result = runPrSweep('7', '/repo', ghFor({ checks: [{ name: 'build', conclusion: 'success' }] }));
    expect(result.exitCode).toBe(0);
    expect(result.data.clean).toBe(true);
    expect(result.text).toContain('✓ mechanical gates pass');
  });

  it('is not clean when an inline thread remains unresolved', () => {
    const thread = { isResolved: false, isOutdated: false, path: 'src/a.ts', comments: { nodes: [{ author: { login: 'reviewer' }, body: 'fix this', createdAt: submittedAt }] } };
    const result = runPrSweep('7', '/repo', ghFor({ threads: [thread] }));
    expect(result.data.clean).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(result.text).toContain('1 unresolved inline thread(s)');
  });

  it('recognizes a disposition receipt only for the matching reviewer and timestamp', () => {
    const receipts = dispositionReceipts([{ body: `handled\n<!-- dispositioned: reviewer[bot] ${submittedAt} -->` }]);
    const review = { author: { login: 'reviewer' }, submittedAt, body: 'finding' };
    expect(isDispositionedReview(review, receipts)).toBe(true);
    expect(isDispositionedReview({ ...review, submittedAt: '2026-08-28T12:01:00Z' }, receipts)).toBe(false);
  });

  it('drops dispositioned review bodies and surfaces undispositioned bodies', () => {
    const reviews = [
      { user: { login: 'reviewer' }, submitted_at: submittedAt, state: 'commented', body: 'handled finding' },
      { user: { login: 'other' }, submitted_at: '2026-08-28T12:01:00Z', state: 'commented', body: 'unhandled finding' },
    ];
    const comments = [{ user: { login: 'author' }, created_at: '2026-08-28T12:02:00Z', body: `<!-- dispositioned: reviewer ${submittedAt} -->` }];
    const result = runPrSweep('7', '/repo', ghFor({ reviews, comments }));
    expect(result.data.undispositionedReviewBodies.map((review) => review.author)).toEqual(['other']);
    expect(result.text).toContain('✓ dispositioned');
    expect(result.text).toContain('1 non-empty review body to read/address: other');
  });

  it('warns when the check rollup is green but merge state is blocked', () => {
    const result = runPrSweep('7', '/repo', ghFor({ checks: [{ name: 'build', conclusion: 'success' }], mergeStateStatus: 'BLOCKED' }));
    expect(result.data.mergeState.mergeStateStatus).toBe('BLOCKED');
    expect(result.text).toContain('🚨 DIVERGENCE');
  });

  it('computes a mechanical failure from open code-scanning alerts', () => {
    expect(computePrSweepVerdict({ unresolvedThreadCount: 0, threadOverflow: false, openAlertCount: 1, codeScanningError: false }).clean).toBe(false);
  });
});
