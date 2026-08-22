import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../src/adapters/claude.js';
import { Ledger } from '../src/ledger.js';
import { useTempResources } from './helpers.js';
import { runCli, withTempHome } from './helpers/cli.js';
import { startMcp, type McpHarness } from './helpers/mcp.js';

function reviewDispatch(ledger: Ledger, model: string): number {
  const id = ledger.start({
    orchestrator: null, taskClass: 'adversarial-review', provider: 'cursor', model,
    skills: null, issue: 'HED-92', pr: null, cwd: '/tmp/review-surface', promptPreview: 'review',
    sessionId: null, fellBackFrom: null,
  });
  ledger.finish(id, { ok: true });
  return id;
}

function seedReview(ledger: Ledger, authorProvider: string, reviewerProvider: string, model: string): number {
  const id = reviewDispatch(ledger, model);
  ledger.recordReview({
    dispatchId: id, authorProvider, authorModel: `${authorProvider}-author`, authorDispatchId: null,
    reviewerProvider, reviewerModel: `${reviewerProvider}-reviewer`,
  });
  return id;
}

function textResult(result: Awaited<ReturnType<McpHarness['callTool']>>): Record<string, unknown> {
  const content = result.content[0];
  if (!content || content.type !== 'text') throw new Error('expected text MCP result');
  try {
    return JSON.parse(content.text) as Record<string, unknown>;
  } catch {
    throw new Error(`MCP result was not valid JSON: ${content.text.slice(0, 200)}`);
  }
}

describe('review surfaces end to end', () => {
  const { tempDir, trackLedger } = useTempResources('heddle-review-surfaces-e2e-');

  it('persists MCP review outcomes and returns their reviewer-pair aggregation', async () => {
    const home = withTempHome();
    const ledger = trackLedger(new Ledger(join(home, '.heddle', 'ledger.db')));
    const claudeCursor = seedReview(ledger, 'claude', 'cursor', 'cursor-a');
    const codexClaude = seedReview(ledger, 'codex', 'claude', 'claude-b');
    ledger.close();

    const mcp = await startMcp({ home });
    try {
      const first = await mcp.callTool('record_review_outcome', {
        dispatch_id: claudeCursor, findings_total: 5, findings_accepted: 3, notes: 'two false positives',
      });
      expect(first.isError).not.toBe(true);
      expect(textResult(first)).toMatchObject({
        recorded: true,
        review: { dispatch_id: claudeCursor, findings_total: 5, findings_accepted: 3, notes: 'two false positives' },
      });

      const second = await mcp.callTool('record_review_outcome', {
        dispatch_id: codexClaude, findings_total: 2, findings_accepted: 1,
      });
      expect(second.isError).not.toBe(true);

      const persisted = trackLedger(new Ledger(join(home, '.heddle', 'ledger.db')));
      expect(persisted.getReview(claudeCursor)).toMatchObject({ findings_total: 5, findings_accepted: 3, notes: 'two false positives' });
      expect(persisted.getReview(codexClaude)).toMatchObject({ findings_total: 2, findings_accepted: 1 });
      persisted.close();

      const stats = await mcp.callTool('review_stats', { limit: 10 });
      expect(stats.isError).not.toBe(true);
      expect(textResult(stats)).toMatchObject({
        pairs: expect.arrayContaining([
          expect.objectContaining({ author_provider: 'claude', reviewer_provider: 'cursor', reviews: 1, scored: 1, findings_total: 5, findings_accepted: 3, acceptance_rate: 0.6 }),
          expect.objectContaining({ author_provider: 'codex', reviewer_provider: 'claude', reviews: 1, scored: 1, findings_total: 2, findings_accepted: 1, acceptance_rate: 0.5 }),
        ]),
        // review_stats returns { pairs, recent } — pin `recent` too (HED-92 review) so a regression
        // that dropped it is caught, matching the CLI test's `recent` assertion below.
        recent: expect.arrayContaining([
          expect.objectContaining({ dispatch_id: claudeCursor, findings_total: 5, findings_accepted: 3 }),
          expect.objectContaining({ dispatch_id: codexClaude, findings_total: 2, findings_accepted: 1 }),
        ]),
      });
    } finally {
      await mcp.close();
    }
  }, 30_000);

  it('records an outcome through the CLI and lists its persisted review row', async () => {
    const home = withTempHome();
    const ledger = trackLedger(new Ledger(join(home, '.heddle', 'ledger.db')));
    const id = seedReview(ledger, 'claude', 'cursor', 'cursor-cli');
    ledger.close();

    const outcome = await runCli(['review-outcome', String(id), '--total', '4', '--accepted', '3', '--notes', 'one false positive'], { home });
    expect(outcome).toMatchObject({ code: 0, stderr: '' });
    expect(outcome.stdout).toContain(`recorded #${id}: 3/4 findings accepted`);

    const reviews = await runCli(['reviews', '--json'], { home });
    expect(reviews).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(reviews.stdout)).toMatchObject({
      pairs: [expect.objectContaining({ author_provider: 'claude', reviewer_provider: 'cursor', findings_total: 4, findings_accepted: 3, acceptance_rate: 0.75 })],
      recent: [expect.objectContaining({ dispatch_id: id, findings_total: 4, findings_accepted: 3, notes: 'one false positive' })],
    });
  }, 30_000);

  it('returns a timeout result promptly when the Claude command exceeds its dispatch timeout', async () => {
    const script = join(tempDir(), 'slow-claude');
    // `exec` replaces the shell with sleep (no fork), so the dispatch SIGKILL reaches the sleeper
    // directly, its stdio closes, and dispatch resolves promptly. Without exec, sh forks sleep,
    // SIGKILL hits only the shell, and the orphaned sleep keeps the pipes open for the full 5s —
    // dispatch would still report a timeout but not return promptly, so this test would silently
    // take 5s and never pin caller-visible prompt-return (HED-92 review, chatgpt-codex).
    writeFileSync(script, '#!/bin/sh\nexec sleep 5\n', 'utf8');
    chmodSync(script, 0o755);

    const started = Date.now();
    const result = await new ClaudeAdapter({ bin: script }).dispatch('review this', {
      model: 'haiku', cwd: process.cwd(), timeoutMs: 100,
    });
    const elapsed = Date.now() - started;

    expect(result).toMatchObject({ ok: false, exitCode: null, error: expect.stringContaining('claude timed out after 100ms (SIGKILL)') });
    // Caller-visible contract: dispatch RETURNS promptly on timeout, not after the child's full 5s.
    // Pins that dispatch does not block on the killed child (HED-92 review).
    expect(elapsed).toBeLessThan(4_000);
  }, 10_000);

  it('includes fake Claude stderr in the failed dispatch result', async () => {
    const script = join(tempDir(), 'stderr-claude');
    writeFileSync(script, '#!/bin/sh\necho "credential diagnostic" >&2\nexit 4\n', 'utf8');
    chmodSync(script, 0o755);

    const result = await new ClaudeAdapter({ bin: script }).dispatch('review this', {
      model: 'haiku', cwd: process.cwd(), timeoutMs: 5_000,
    });

    expect(result).toMatchObject({ ok: false, exitCode: 4, error: expect.stringContaining('stderr tail: credential diagnostic') });
  });
});
