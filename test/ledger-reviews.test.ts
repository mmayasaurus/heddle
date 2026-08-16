import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Ledger } from '../src/ledger.js';
import { useTempResources } from './helpers.js';

describe('ledger adversarial reviews', () => {
  const { tempDir, trackLedger } = useTempResources('heddle-ledger-reviews-test-');
  function ledger(): Ledger { return trackLedger(new Ledger(join(tempDir(), 'ledger.db'))); }
  function start(db: Ledger, n = 0): number {
    return db.start({ orchestrator: null, taskClass: 'adversarial-review', provider: 'cursor', model: `m${n}`, skills: null, issue: null, pr: null, cwd: '/tmp/x', promptPreview: 'p', sessionId: null, fellBackFrom: null });
  }
  // scoring requires a FINISHED dispatch (the in-flight guard) — the helper mirrors the real flow
  function finished(db: Ledger, n = 0): number {
    const id = start(db, n); db.finish(id, { ok: true }); return id;
  }
  function review(db: Ledger, id: number, author: string, reviewer: string): void {
    db.recordReview({ dispatchId: id, authorProvider: author, authorModel: 'author-model', authorDispatchId: null, reviewerProvider: reviewer, reviewerModel: 'reviewer-model' });
  }

  it('upserts reviewer identity without erasing the existing mandate or scored outcome', () => {
    const db = ledger(); const id = finished(db);
    db.recordReview({ dispatchId: id, authorProvider: 'claude', authorModel: 'fable', authorDispatchId: 41, reviewerProvider: 'cursor', reviewerModel: 'cursor-grok-4.6-high' });
    expect(db.getReview(id)).toMatchObject({ dispatch_id: id, author_provider: 'claude', author_model: 'fable', author_dispatch_id: 41, reviewer_provider: 'cursor', reviewer_model: 'cursor-grok-4.6-high', mandate_ok: null, findings_total: null, outcome_at: null, created_at: expect.any(String) });
    db.setReviewMandate(id, false);
    db.recordReviewOutcome(id, { findingsTotal: 2, findingsAccepted: 1 });
    db.recordReview({ dispatchId: id, authorProvider: 'claude', authorModel: 'fable', authorDispatchId: 41, reviewerProvider: 'gemini', reviewerModel: 'gemini-3.1-pro-high' });
    expect(db.getReview(id)).toMatchObject({ reviewer_provider: 'gemini', mandate_ok: 0, findings_total: 2, findings_accepted: 1 });
    expect(db.recentReviews(10)).toHaveLength(1);
    expect(() => review(db, 999, 'claude', 'cursor')).toThrow();
  });

  it('records false, true, and unavailable mandate outcomes as their persisted SQLite values', () => {
    const db = ledger(); const id = start(db); review(db, id, 'claude', 'cursor');
    db.setReviewMandate(id, false); expect(db.getReview(id)?.mandate_ok).toBe(0);
    db.setReviewMandate(id, true); expect(db.getReview(id)?.mandate_ok).toBe(1);
    db.setReviewMandate(id, null); expect(db.getReview(id)?.mandate_ok).toBeNull();
  });

  it('persists valid outcomes and rejects invalid finding totals without creating a score', () => {
    const db = ledger(); const id = finished(db); review(db, id, 'claude', 'cursor');
    expect(db.recordReviewOutcome(id, { findingsTotal: 5, findingsAccepted: 3, notes: '2 false positives' })).toBe(true);
    expect(db.getReview(id)).toMatchObject({ findings_total: 5, findings_accepted: 3, notes: '2 false positives', outcome_at: expect.any(String) });
    expect(db.recordReviewOutcome(999, { findingsTotal: 1, findingsAccepted: 0 })).toBe(false);
    expect(() => db.recordReviewOutcome(id, { findingsTotal: 2, findingsAccepted: 3 })).toThrow(/must be 0\.\.findings_total/);
    expect(() => db.recordReviewOutcome(id, { findingsTotal: -1, findingsAccepted: 0 })).toThrow();
    expect(() => db.recordReviewOutcome(id, { findingsTotal: 1.5, findingsAccepted: 0 })).toThrow();
    // in-flight guard: an unfinished review dispatch cannot be scored; author_dispatch_id is validated
    const inflight = start(db, 9); review(db, inflight, 'claude', 'cursor');
    expect(() => db.recordReviewOutcome(inflight, { findingsTotal: 1, findingsAccepted: 0 })).toThrow(/still in flight/);
    expect(() => db.recordReview({ dispatchId: id, authorProvider: 'claude', authorModel: null, authorDispatchId: -3, reviewerProvider: 'cursor', reviewerModel: 'm' })).toThrow(/positive integer/);
  });

  it('aggregates scored review pairs and orders the largest pair first', () => {
    const db = ledger();
    const a = finished(db, 1); review(db, a, 'claude', 'cursor'); db.recordReviewOutcome(a, { findingsTotal: 5, findingsAccepted: 3 });
    const b = finished(db, 2); review(db, b, 'claude', 'cursor'); db.recordReviewOutcome(b, { findingsTotal: 4, findingsAccepted: 4 });
    const c = start(db, 3); review(db, c, 'claude', 'gemini');
    const d = finished(db, 4); review(db, d, 'codex', 'claude'); db.recordReviewOutcome(d, { findingsTotal: 2, findingsAccepted: 0 }); db.setReviewMandate(d, false);
    const stats = db.reviewPairStats();
    expect(stats[0]).toMatchObject({ author_provider: 'claude', reviewer_provider: 'cursor', reviews: 2, scored: 2, findings_total: 9, findings_accepted: 7, acceptance_rate: 0.778, mandate_violations: 0 });
    expect(stats).toEqual(expect.arrayContaining([
      expect.objectContaining({ author_provider: 'claude', reviewer_provider: 'gemini', reviews: 1, scored: 0, acceptance_rate: null }),
      expect.objectContaining({ author_provider: 'codex', reviewer_provider: 'claude', mandate_violations: 1, acceptance_rate: 0 }),
    ]));
  });

  it('returns the newest joined review rows with dispatch outcome and start data', () => {
    const db = ledger();
    for (let n = 0; n < 3; n++) { const id = start(db, n); review(db, id, 'claude', 'cursor'); db.finish(id, { ok: n % 2 === 0 }); }
    const rows = db.recentReviews(2);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.dispatch_id)).toEqual([3, 2]);
    expect(rows[0]).toMatchObject({ ok: 1, started_at: expect.any(String) });
  });
});
