import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dispatch } from '../src/dispatch.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import { ClaudeAdapter } from '../src/adapters/claude.js';
import { Ledger } from '../src/ledger.js';
import type { CapsByProvider } from '../src/usage.js';
import type { WorkerAdapter } from '../src/types.js';
import { fakeAdapter, IDENTITIES, useTempResources } from './helpers.js';

function gitRepo(cwd: string): void {
  execFileSync('git', ['init', '-q'], { cwd });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-q', '-m', 'init'], { cwd });
}

function commitTrackedProbe(cwd: string): void {
  writeFileSync(join(cwd, 'tracked-probe.txt'), 'before');
  execFileSync('git', ['add', 'tracked-probe.txt'], { cwd });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'track probe'], { cwd });
}

function reviewRouting(tempDir: () => string): () => void {
  const path = join(tempDir(), 'routing.yaml');
  writeFileSync(path, readFileSync(join(process.cwd(), 'routing', 'routing.v0.yaml'), 'utf8').replace('auto_assess: true', 'auto_assess: false'));
  const previous = process.env.HEDDLE_ROUTING;
  process.env.HEDDLE_ROUTING = path;
  return () => { if (previous === undefined) delete process.env.HEDDLE_ROUTING; else process.env.HEDDLE_ROUTING = previous; };
}

function cursorOverCaps(): CapsByProvider {
  const window = (usedPercentage: number) => ({ usedPercentage, resetsAt: Date.now() / 1000 + 3600 });
  const base = (provider: string, windows = {}) => ({ provider, source: 'limits.json' as const, stale: false, capturedAt: Date.now() / 1000, fiveHour: window(5), sevenDay: window(5), windows, noteCodes: [], accounts: [], activeAccount: null });
  return { cursor: base('cursor', { 'included-total': window(95) }), gemini: base('gemini') };
}

describe('adversarial review dispatch', () => {
  const { tempDir, tempLedger } = useTempResources('heddle-dispatch-review-test-');
  const { unbound } = IDENTITIES;

  it('requires author_provider before creating a ledger row or materializing a worker', async () => {
    const restore = reviewRouting(tempDir); const ledger = tempLedger(); const fake = fakeAdapter();
    try {
      await expect(dispatch({ taskClass: 'adversarial-review', prompt: 'review', cwd: tempDir(), identity: unbound }, ledger, () => fake.adapter)).rejects.toThrow(/requires author_provider/);
      expect(fake.calls).toHaveLength(0); expect(ledger.recent()).toEqual([]);
      const outcome = await dispatch({ taskClass: 'adversarial-review', authorProvider: ' Claude ', prompt: 'review', cwd: tempDir(), identity: unbound }, ledger, () => fake.adapter);
      expect(ledger.getReview(outcome.ledgerId)?.author_provider).toBe('claude');
    } finally { restore(); }
  });

  it('runs the primary reviewer read-only and materializes both required adversarial packs', async () => {
    const restore = reviewRouting(tempDir); const ledger = tempLedger(); const fake = fakeAdapter();
    try {
      const outcome = await dispatch({ taskClass: 'adversarial-review', authorProvider: 'claude', prompt: 'review', cwd: tempDir(), identity: unbound }, ledger, () => fake.adapter);
      expect(fake.calls[0].opts).toMatchObject({ model: 'cursor-grok-4.6-high', readOnly: true, systemPromptAppend: undefined });
      expect(fake.calls[0].agents).toContain('### adversarial-review'); expect(fake.calls[0].agents).toContain('### worker-role');
      expect(outcome.review).toMatchObject({ authorProvider: 'claude', reviewerProvider: 'cursor', reviewerModel: 'cursor-grok-4.6-high' });
      expect(ledger.getReview(outcome.ledgerId)).toMatchObject({ author_provider: 'claude', reviewer_provider: 'cursor' });
      expect(ledger.recent(1)[0].skills).toBe('worker-role,adversarial-review');
    } finally { restore(); }
  });

  it('uses the pool reviewer and avoids a duplicate fallback when the author is the primary family', async () => {
    const restore = reviewRouting(tempDir); const ledger = tempLedger(); const fake = fakeAdapter({ ok: false, output: 'failed', exitCode: 1 });
    try {
      const outcome = await dispatch({ taskClass: 'adversarial-review', authorProvider: 'cursor', prompt: 'review', cwd: tempDir(), identity: unbound }, ledger, () => fake.adapter);
      expect(fake.calls).toHaveLength(1); expect(fake.calls[0].opts.model).toBe('gemini-3.1-pro-high');
      expect(outcome.routeReason).toContain('reviewer pool:2 (author is cursor)');
      expect(outcome.review?.reviewerProvider).toBe('gemini'); expect(ledger.getReview(outcome.ledgerId)?.reviewer_provider).toBe('gemini');
    } finally { restore(); }
  });

  it('never retries a failed review on the author family, and a cap-routed primary still runs rather than routing to the author family', async () => {
    const restore = reviewRouting(tempDir); const failed = fakeAdapter({ ok: false, output: 'failed', exitCode: 1 });
    try {
      await dispatch({ taskClass: 'adversarial-review', authorProvider: 'gemini', prompt: 'review', cwd: tempDir(), identity: unbound }, tempLedger(), () => failed.adapter);
      // the class fallback (gemini) is the author's family → dropped, so a failed cursor review is NOT retried on gemini
      expect(failed.calls).toHaveLength(1); expect(failed.calls[0].opts.model).toBe('cursor-grok-4.6-high');
      // cursor over its cap: the author-family fallback was already dropped, so cap-aware routing has nowhere to go and runs cursor anyway
      const capped = fakeAdapter(); const ledger = tempLedger();
      const outcome = await dispatch({ taskClass: 'adversarial-review', authorProvider: 'gemini', prompt: 'review', cwd: tempDir(), identity: unbound, caps: cursorOverCaps() }, ledger, () => capped.adapter);
      expect(outcome.refusal).toBeUndefined(); expect(capped.calls).toHaveLength(1); expect(capped.calls[0].opts.model).toBe('cursor-grok-4.6-high');
      expect(outcome.routeReason).toContain('cap:over cursor included-total 95%'); expect(outcome.routeReason).toContain('(no fallback) → ran primary');
      expect(ledger.recent(1)[0]).toMatchObject({ provider: 'cursor', refusal: null });
    } finally { restore(); }
  });

  it('refuses an explicit author-family reviewer but runs an explicitly different reviewer', async () => {
    const restore = reviewRouting(tempDir); const ledger = tempLedger(); const fake = fakeAdapter();
    try {
      const refused = await dispatch({ taskClass: 'adversarial-review', provider: 'cursor', model: 'cursor-grok-4.6-high', authorProvider: 'cursor', prompt: 'review', cwd: tempDir(), identity: unbound }, ledger, () => fake.adapter);
      expect(refused.refusal?.code).toBe('same-provider-review'); expect(refused.refusal?.reason).toContain('DIFFERENT provider'); expect(fake.calls).toHaveLength(0); expect(ledger.recent(1)[0].refusal).toBe('same-provider-review');
      const ran = await dispatch({ taskClass: 'adversarial-review', provider: 'codex', model: 'gpt-5.6-sol', authorProvider: 'cursor', prompt: 'review', cwd: tempDir(), identity: unbound }, ledger, () => fake.adapter);
      expect(ran.review?.reviewerProvider).toBe('codex'); expect(fake.calls).toHaveLength(1);
    } finally { restore(); }
  });

  it('prepends the requested diff-base instruction without changing the original task tail', async () => {
    const restore = reviewRouting(tempDir); const fake = fakeAdapter();
    try {
      await dispatch({ taskClass: 'adversarial-review', authorProvider: 'claude', diffBase: 'main', prompt: 'original task', cwd: tempDir(), identity: unbound }, tempLedger(), () => fake.adapter);
      expect(fake.calls[0].prompt).toMatch(/^Review the changes on this branch relative to `main`/);
      expect(fake.calls[0].prompt.endsWith('original task')).toBe(true);
    } finally { restore(); }
  });

  it('records a successful read-only mandate when the git worktree remains unchanged', async () => {
    const restore = reviewRouting(tempDir); const cwd = tempDir(); gitRepo(cwd); commitTrackedProbe(cwd); const ledger = tempLedger();
    try {
      const outcome = await dispatch({ taskClass: 'adversarial-review', authorProvider: 'claude', prompt: 'review', cwd, identity: unbound }, ledger, () => fakeAdapter().adapter);
      expect(outcome.review?.mandateOk).toBe(true); expect(ledger.getReview(outcome.ledgerId)?.mandate_ok).toBe(1); expect(outcome.error).toBeUndefined();
    } finally { restore(); }
  });

  it('surfaces and records a write mandate violation without discarding findings or reverting files', async () => {
    const restore = reviewRouting(tempDir); const cwd = tempDir(); gitRepo(cwd); commitTrackedProbe(cwd); const ledger = tempLedger();
    let writerCalls = 0;
    const writer: WorkerAdapter = { name: 'writer', provider: 'codex', dispatch: async (_prompt, opts) => { writerCalls += 1; writeFileSync(join(opts.cwd, 'tracked-probe.txt'), 'after'); return { ok: true, output: 'done', exitCode: 0 }; } };
    try {
      const outcome = await dispatch({ taskClass: 'adversarial-review', authorProvider: 'claude', prompt: 'review', cwd, identity: unbound }, ledger, () => writer);
      expect(readFileSync(join(cwd, 'tracked-probe.txt'), 'utf8')).toBe('after'); expect(outcome.review?.mandateOk).toBe(false); expect(ledger.getReview(outcome.ledgerId)?.mandate_ok).toBe(0); expect(outcome.error).toContain('MANDATE VIOLATION'); expect(outcome.output).toBe('done');
      // a violation is a POLICY failure of this reviewer, never retried on the class fallback —
      // the tree is already mutated, so a second reviewer would review tampered state
      expect(writerCalls).toBe(1);
      expect(ledger.recent()).toHaveLength(1);
    } finally { restore(); }
  });

  it('catches a reviewer that edits the injected AGENTS.md — restore must not mask the violation', async () => {
    const restore = reviewRouting(tempDir); const cwd = tempDir(); gitRepo(cwd); const ledger = tempLedger();
    // the cursor reviewer gets AGENTS.md materialized; an edit to it was invisible under the old
    // before-materialize/after-restore snapshot ordering (restore reinstated the original bytes)
    const agentsEditor: WorkerAdapter = { name: 'w', provider: 'codex', dispatch: async (_prompt, opts) => {
      writeFileSync(join(opts.cwd, 'AGENTS.md'), 'REVIEWER WAS HERE'); return { ok: true, output: 'done', exitCode: 0 };
    } };
    try {
      const outcome = await dispatch({ taskClass: 'adversarial-review', authorProvider: 'claude', prompt: 'review', cwd, identity: unbound }, ledger, () => agentsEditor);
      expect(outcome.review?.mandateOk).toBe(false); expect(outcome.error).toContain('MANDATE VIOLATION');
    } finally { restore(); }
  });

  it('catches a bare git add — the index is part of the mandate digest even when no bytes change', async () => {
    const restore = reviewRouting(tempDir); const cwd = tempDir(); gitRepo(cwd); commitTrackedProbe(cwd); const ledger = tempLedger();
    writeFileSync(join(cwd, 'tracked-probe.txt'), 'dirty'); // dirty BEFORE the review starts
    const stager: WorkerAdapter = { name: 'w', provider: 'codex', dispatch: async (_prompt, opts) => {
      execFileSync('git', ['add', 'tracked-probe.txt'], { cwd: opts.cwd }); return { ok: true, output: 'done', exitCode: 0 };
    } };
    try {
      const outcome = await dispatch({ taskClass: 'adversarial-review', authorProvider: 'claude', prompt: 'review', cwd, identity: unbound }, ledger, () => stager);
      expect(outcome.review?.mandateOk).toBe(false);
    } finally { restore(); }
  });

  it('refuses an author_provider that is not a known provider instead of silently disabling the family guard', async () => {
    const restore = reviewRouting(tempDir); const ledger = tempLedger(); const fake = fakeAdapter();
    try {
      await expect(dispatch({ taskClass: 'adversarial-review', authorProvider: 'cursur', prompt: 'review', cwd: tempDir(), identity: unbound }, ledger, () => fake.adapter))
        .rejects.toThrow(/not a known provider/);
      expect(fake.calls).toHaveLength(0);
    } finally { restore(); }
  });

  it('embeds the actual diff for a claude read-only reviewer and keeps the run-it-yourself instruction for others', async () => {
    const restore = reviewRouting(tempDir); const cwd = tempDir(); gitRepo(cwd); const ledger = tempLedger();
    execFileSync('git', ['checkout', '-q', '-b', 'work'], { cwd });
    writeFileSync(join(cwd, 'feature.txt'), 'THE-CHANGED-LINE');
    execFileSync('git', ['add', 'feature.txt'], { cwd });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'feat'], { cwd });
    const fake = fakeAdapter(undefined, { readAgents: false }); // claude materializes no AGENTS.md
    try {
      // claude reviewer (explicit different-family route): no Bash in its tool set → diff embedded
      const claudeOutcome = await dispatch({ taskClass: 'adversarial-review', provider: 'claude', model: 'opus', authorProvider: 'cursor', diffBase: 'master', prompt: 'review', cwd, identity: unbound }, ledger, () => fake.adapter);
      if (!fake.calls.length) throw new Error('claude reviewer never ran: ' + JSON.stringify({ refusal: claudeOutcome.refusal, error: claudeOutcome.error, execution: claudeOutcome.execution }));
      const claudePrompt = fake.calls[0].prompt;
      expect(claudePrompt).toContain('You cannot run shell commands');
      expect(claudePrompt).toContain('```diff');
      expect(claudePrompt).toContain('THE-CHANGED-LINE');
      // cursor reviewer (class primary): runs git itself
      await dispatch({ taskClass: 'adversarial-review', authorProvider: 'claude', diffBase: 'master', prompt: 'review', cwd, identity: unbound }, ledger, () => fake.adapter);
      const cursorPrompt = fake.calls[1].prompt;
      expect(cursorPrompt).toContain('run `git diff master...HEAD`');
      expect(cursorPrompt).not.toContain('```diff');
    } finally { restore(); }
  });

  it('unions the class mandate packs with an explicit skills list — the find-only mandate cannot be dropped', async () => {
    const restore = reviewRouting(tempDir); const ledger = tempLedger(); const fake = fakeAdapter();
    try {
      const outcome = await dispatch({ taskClass: 'adversarial-review', authorProvider: 'claude', skills: ['code-discovery'], prompt: 'review', cwd: tempDir(), identity: unbound }, ledger, () => fake.adapter);
      expect(fake.calls[0].agents).toContain('### adversarial-review');
      expect(fake.calls[0].agents).toContain('### code-discovery');
      const skills = String(ledger.recent(1)[0].skills);
      expect(skills).toContain('adversarial-review'); expect(skills).toContain('worker-role'); expect(skills).toContain('code-discovery');
      expect(outcome.ok).toBe(true);
    } finally { restore(); }
  });

  it('marks the mandate unavailable rather than failed for a non-git review directory', async () => {
    const restore = reviewRouting(tempDir); const ledger = tempLedger();
    try {
      const outcome = await dispatch({ taskClass: 'adversarial-review', authorProvider: 'claude', prompt: 'review', cwd: tempDir(), identity: unbound }, ledger, () => fakeAdapter().adapter);
      expect(outcome.review?.mandateOk).toBeNull(); expect(ledger.getReview(outcome.ledgerId)?.mandate_ok).toBeNull(); expect(outcome.error).toBeUndefined();
    } finally { restore(); }
  });

  it('skips auto-assessment for an empty successful review output from the shipped routing table', async () => {
    const fake = fakeAdapter({ ok: true, output: '', exitCode: 0 });
    const outcome = await dispatch({ taskClass: 'adversarial-review', authorProvider: 'claude', prompt: 'review', cwd: tempDir(), identity: unbound }, tempLedger(), () => fake.adapter);
    expect(outcome.assessment).toBeUndefined();
  });

  it('documents the current read-only enforcement gap for agy and cursor adapters', () => {
    // Tripwire: update the review documentation and this test when either adapter gains a read-only mapping.
    expect(readFileSync(join(process.cwd(), 'src/adapters/agy.ts'), 'utf8')).not.toContain('readOnly');
    expect(readFileSync(join(process.cwd(), 'src/adapters/cursor.ts'), 'utf8')).not.toContain('readOnly');
  });

  it('passes read-only argv contracts to Codex and Claude adapters instead of privileged write flags', () => {
    const codex = new CodexAdapter().buildArgs('x', { model: 'gpt-5.6-sol', cwd: '/tmp', readOnly: true, capabilities: ['exec-privileged'] });
    expect(codex).toEqual(expect.arrayContaining(['--sandbox', 'read-only'])); expect(codex).not.toContain('danger-full-access');
    const claude = new ClaudeAdapter().buildArgs('x', { model: 'opus', cwd: '/tmp', readOnly: true });
    // ONLY the read built-ins in the tool set — no Bash at all: the permission layer is not a
    // boundary (verified live: an --allowedTools git-only Bash still wrote files, because operator
    // global settings leak into workers), so the set restriction is the whole enforcement.
    expect(claude).toEqual(expect.arrayContaining(['--tools', 'Read', 'Grep', 'Glob']));
    expect(claude).not.toContain('Bash'); expect(claude).not.toContain('--allowedTools');
    expect(claude).not.toContain('Edit'); expect(claude).not.toContain('Write'); expect(claude).not.toContain('--dangerously-skip-permissions');
    // a granted browse survives read-only mode at the SET level (so it actually holds)
    const browsing = new ClaudeAdapter().buildArgs('x', { model: 'opus', cwd: '/tmp', readOnly: true, capabilities: ['browse'] });
    expect(browsing.slice(browsing.indexOf('--tools') + 1, browsing.indexOf('--permission-mode'))).toEqual(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch']);
  });
});
