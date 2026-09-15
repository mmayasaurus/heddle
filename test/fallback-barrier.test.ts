import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dispatch, type AdapterFactory, type DispatchRequest } from '../src/dispatch.js';
import { autoWipCommit, checkoutFingerprint, fallbackBarrier } from '../src/worktree.js';
import type { Account } from '../src/accounts.js';
import type { CapsByProvider } from '../src/usage.js';
import type { DispatchOptions, WorkerAdapter, WorkerResult } from '../src/types.js';
import { HERMETIC_GIT_ENV, IDENTITIES, useTempResources } from './helpers.js';

type TestProvider = 'codex' | 'cursor';
type Handler = (attempt: number, opts: DispatchOptions) => WorkerResult;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: HERMETIC_GIT_ENV });
}

function gitRepo(tempDir: () => string): string {
  const root = tempDir();
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 't@t');
  git(root, 'config', 'user.name', 't');
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'config', 'core.hooksPath', '.git/hooks');
  writeFileSync(join(root, 'tracked.txt'), 'committed\n');
  git(root, 'add', 'tracked.txt');
  git(root, 'commit', '-q', '-m', 'init');
  return root;
}

function indexState(cwd: string): string {
  return git(cwd, 'ls-files', '-s', '-z');
}

/** The real-index entry (mode + blob + stage) for a single path — the isolation-relevant slice. */
function indexEntry(cwd: string, path: string): string {
  return git(cwd, 'ls-files', '-s', '-z', '--', path);
}

/** Working-tree status of a single path; '' when it is clean (matches HEAD and the index). */
function pathStatus(cwd: string, path: string): string {
  return git(cwd, 'status', '--porcelain', '-z', '-uall', '--', path).replace(/\0/g, '').trim();
}

function statusState(cwd: string): string {
  return git(cwd, 'status', '--porcelain', '-z', '-uall');
}

function committedPaths(cwd: string): string[] {
  return git(cwd, 'diff-tree', '--no-commit-id', '--name-only', '-r', '-z', 'HEAD')
    .split('\0').filter(Boolean).sort();
}

function requireFp(cwd: string) {
  const fp = checkoutFingerprint(cwd);
  if (fp === null) throw new Error(`expected fingerprint at ${cwd}`);
  return fp;
}

function installRouting(tempDir: () => string): () => void {
  const path = join(tempDir(), 'routing.yaml');
  writeFileSync(path, [
    'version: 0',
    'providers:',
    '  codex: { execution: headless, models: [primary] }',
    '  cursor: { execution: headless, models: [fallback] }',
    'task_classes:',
    '  barrier:',
    '    provider: codex',
    '    model: primary',
    '    fallback: { provider: cursor, model: fallback }',
    '',
  ].join('\n'));
  const previous = process.env.HEDDLE_ROUTING;
  const previousComms = process.env.HEDDLE_COMMS_DB;
  const previousAccounts = process.env.HEDDLE_ACCOUNTS;
  const accountsPath = join(tempDir(), 'accounts.json');
  writeFileSync(accountsPath, JSON.stringify({
    schemaVersion: 2,
    codex: [
      { id: 'first', codexHome: null, billingClass: 'subscription-flat' },
      { id: 'second', codexHome: null, billingClass: 'subscription-flat' },
    ],
    cursor: [{ id: 'cursor-first', keyFile: null, billingClass: 'subscription-flat' }],
  }));
  process.env.HEDDLE_ROUTING = path;
  process.env.HEDDLE_COMMS_DB = join(tempDir(), 'missing-comms.db');
  process.env.HEDDLE_ACCOUNTS = accountsPath;
  return () => {
    if (previous === undefined) delete process.env.HEDDLE_ROUTING;
    else process.env.HEDDLE_ROUTING = previous;
    if (previousComms === undefined) delete process.env.HEDDLE_COMMS_DB;
    else process.env.HEDDLE_COMMS_DB = previousComms;
    if (previousAccounts === undefined) delete process.env.HEDDLE_ACCOUNTS;
    else process.env.HEDDLE_ACCOUNTS = previousAccounts;
  };
}

function adapterHarness(handlers: Record<TestProvider, Handler>): {
  factory: AdapterFactory;
  calls: Array<{ provider: TestProvider; opts: DispatchOptions }>;
} {
  const calls: Array<{ provider: TestProvider; opts: DispatchOptions }> = [];
  const attempts: Record<TestProvider, number> = { codex: 0, cursor: 0 };
  const factory: AdapterFactory = (provider) => {
    if (provider !== 'codex' && provider !== 'cursor') throw new Error(`unexpected provider ${provider}`);
    const adapter: WorkerAdapter = {
      name: `fake-${provider}`,
      provider,
      dispatch: (_prompt, opts) => {
        attempts[provider] += 1;
        calls.push({ provider, opts });
        return Promise.resolve(handlers[provider](attempts[provider], opts));
      },
    };
    return adapter;
  };
  return { factory, calls };
}

function request(cwd: string, overrides: Partial<DispatchRequest> = {}): DispatchRequest {
  return {
    taskClass: 'barrier', prompt: 'x', cwd, identity: IDENTITIES.unbound,
    caps: allCaps(),
    rotationAccounts: {
      codex: [{ id: 'first', codexHome: null }, { id: 'second', codexHome: null }],
      cursor: [{ id: 'cursor-first', keyFile: null }],
    },
    ...overrides,
  };
}

function success(): WorkerResult {
  return { ok: true, output: 'fallback done', exitCode: 0 };
}

function failure(error = 'primary failed'): WorkerResult {
  return { ok: false, output: '', error, exitCode: 1 };
}

function allCaps(): CapsByProvider {
  const window = { usedPercentage: 10, resetsAt: null };
  const provider = (name: TestProvider, ids: string[], activeAccount: string) => ({
    provider: name, source: 'limits.json' as const, stale: false, capturedAt: 1,
    fiveHour: window, sevenDay: { usedPercentage: null, resetsAt: null }, windows: {}, noteCodes: [],
    activeAccount,
    accounts: ids.map((id) => ({
      id, fiveHour: window, sevenDay: { usedPercentage: null, resetsAt: null }, windows: {},
      noteCodes: [], limitReached: false, stale: false,
    })),
  });
  return {
    codex: provider('codex', ['first', 'second'], 'first'),
    cursor: provider('cursor', ['cursor-first'], 'cursor-first'),
  };
}

function codexAccounts(): Account[] {
  return ['first', 'second'].map((id) => ({
    id, provider: 'codex', harness: 'codex', credentialRef: `test:${id}`,
    billingClass: 'subscription-flat', codexHome: null,
  }));
}

describe('fallback commit barrier', () => {
  const { tempDir, tempLedger } = useTempResources('heddle-fallback-barrier-test-');

  it('refuses and ledgers a fallback when the failed primary created dirt', async () => {
    const root = gitRepo(tempDir); const restore = installRouting(tempDir); const ledger = tempLedger();
    const harness = adapterHarness({
      codex: () => { writeFileSync(join(root, 'primary-dirt.txt'), 'dirty\n'); return failure(); },
      cursor: success,
    });
    try {
      const outcome = await dispatch(request(root), ledger, harness.factory);
      const rows = ledger.recent();
      const primary = rows.find((row) => row.provider === 'codex' && row.refusal === null)!;
      expect(outcome.refusal?.code).toBe('fallback-blocked-dirty-tree');
      expect(outcome.refusal?.reason).toContain('codex/primary');
      expect(outcome.refusal?.reason).toContain(`dispatch #${primary.id}`);
      expect(outcome.refusal?.reason).toContain('primary-dirt.txt');
      expect(outcome.refusal?.instruction).toBe(
        `Commit or discard the changes in ${root}, then re-dispatch. Or re-dispatch with the CLI flag --fallback-wip-commit (MCP tool: fallback_wip_commit) to auto-commit the failed leg's own new files (a tree with pre-existing local changes is never auto-committed).`,
      );
      // The refusal fires on a fallback path, so the row is attributed as a fallback (HED-622: the
      // direct refusalOutcome path must set usedFallback, not inherit the hard-coded false).
      expect(outcome.usedFallback).toBe(true);
      expect(rows.some((row) => row.refusal === 'fallback-blocked-dirty-tree')).toBe(true);
      expect(harness.calls.map((call) => call.provider)).toEqual(['codex']);
    } finally { restore(); }
  });

  it('runs the fallback when the primary fails without changing the checkout', async () => {
    const root = gitRepo(tempDir); const restore = installRouting(tempDir);
    const harness = adapterHarness({ codex: () => failure(), cursor: success });
    try {
      const outcome = await dispatch(request(root), tempLedger(), harness.factory);
      expect(outcome).toMatchObject({ ok: true, provider: 'cursor', usedFallback: true });
      expect(harness.calls.map((call) => call.provider)).toEqual(['codex', 'cursor']);
    } finally { restore(); }
  });

  it('does not treat unchanged pre-existing dirt as primary-created dirt', async () => {
    const root = gitRepo(tempDir); const restore = installRouting(tempDir);
    writeFileSync(join(root, 'pre-existing.txt'), 'orchestrator work\n');
    const harness = adapterHarness({ codex: () => failure(), cursor: success });
    try {
      const outcome = await dispatch(request(root), tempLedger(), harness.factory);
      expect(outcome).toMatchObject({ ok: true, provider: 'cursor', usedFallback: true });
      expect(git(root, 'status', '--short', '--', 'pre-existing.txt')).toContain('?? pre-existing.txt');
    } finally { restore(); }
  });

  it('runs the fallback when cwd is not a Git repository', async () => {
    const cwd = tempDir(); const restore = installRouting(tempDir);
    const harness = adapterHarness({ codex: () => failure(), cursor: success });
    try {
      const outcome = await dispatch(request(cwd), tempLedger(), harness.factory);
      expect(outcome).toMatchObject({ ok: true, provider: 'cursor', usedFallback: true });
      expect(harness.calls.map((call) => call.provider)).toEqual(['codex', 'cursor']);
    } finally { restore(); }
  });

  it('blocks the fallback when the failed leg made the checkout unreadable', async () => {
    // preFp is captured on a valid repo; the leg destroys .git, so the post-leg fingerprint is null.
    // escapedPaths reports that as "undecidable" (null) — the barrier must NOT let a wrecked tree pass.
    const root = gitRepo(tempDir); const restore = installRouting(tempDir);
    const harness = adapterHarness({
      codex: () => { rmSync(join(root, '.git'), { recursive: true, force: true }); return failure(); },
      cursor: success,
    });
    try {
      const outcome = await dispatch(request(root), tempLedger(), harness.factory);
      expect(outcome.refusal?.code).toBe('fallback-blocked-dirty-tree');
      expect(outcome.refusal?.reason).toContain('unreadable');
      expect(harness.calls.map((call) => call.provider)).toEqual(['codex']);
    } finally { restore(); }
  });

  it('blocks class fallback when a failed account-failover leg created dirt', async () => {
    const root = gitRepo(tempDir); const restore = installRouting(tempDir); const ledger = tempLedger();
    const harness = adapterHarness({
      codex: (attempt) => {
        if (attempt === 1) return failure('429 rate limit');
        writeFileSync(join(root, 'failover-dirt.txt'), 'dirty\n');
        return failure('failover failed');
      },
      cursor: success,
    });
    try {
      const outcome = await dispatch(request(root, {
        caps: allCaps(), accountRegistry: codexAccounts(),
        rotationAccounts: {
          codex: [{ id: 'first', codexHome: null }, { id: 'second', codexHome: null }], cursor: [],
        },
        coolingPath: join(tempDir(), 'cooling.json'), nowS: 100,
      }), ledger, harness.factory);
      const failedFailover = ledger.recent().find((row) => row.provider === 'codex' && row.account === 'second')!;
      expect(outcome.refusal?.code).toBe('fallback-blocked-dirty-tree');
      expect(outcome.refusal?.reason).toContain('failover-dirt.txt');
      expect(outcome.refusal?.reason).toContain(`dispatch #${failedFailover.id}`);
      expect(harness.calls.map((call) => call.provider)).toEqual(['codex', 'codex']);
    } finally { restore(); }
  });

  it('blocks the fallback when the failed primary moved HEAD', async () => {
    const root = gitRepo(tempDir); const restore = installRouting(tempDir);
    const harness = adapterHarness({
      codex: () => {
        writeFileSync(join(root, 'head-move.txt'), 'committed by worker\n');
        git(root, 'add', 'head-move.txt');
        git(root, 'commit', '-q', '-m', 'worker moved head');
        return failure();
      },
      cursor: success,
    });
    try {
      const outcome = await dispatch(request(root), tempLedger(), harness.factory);
      expect(outcome.refusal?.code).toBe('fallback-blocked-dirty-tree');
      expect(outcome.refusal?.reason).toContain('HEAD moved');
      // A warning on the failed leg (here the moved HEAD → HED-127 destroyed-work) must survive the
      // barrier refusal, not be dropped — the parent tree is still wrecked and someone has to know.
      expect(outcome.destroyed).toBeTruthy();
      expect(git(root, 'log', '-1', '--format=%s').trim()).toBe('worker moved head');
      // No auto-WIP commit is ever made now (refuse-only): just init + the worker's own commit.
      expect(git(root, 'rev-list', '--count', 'HEAD').trim()).toBe('2');
      expect(harness.calls.map((call) => call.provider)).toEqual(['codex']);
    } finally { restore(); }
  });
});

describe('autoWipCommit isolation', () => {
  const { tempDir, tempLedger } = useTempResources('heddle-autowip-test-');

  it('membership-block: a changed pre-existing dirty path refuses and commits nothing', () => {
    const root = gitRepo(tempDir);
    writeFileSync(join(root, 'pre-existing.txt'), 'orchestrator\n');
    const preFp = requireFp(root);
    writeFileSync(join(root, 'pre-existing.txt'), 'leg overwrote it\n');
    writeFileSync(join(root, 'leg-new.txt'), 'new\n');
    const postFp = requireFp(root);
    const headBefore = git(root, 'rev-parse', 'HEAD').trim();
    const indexBefore = indexState(root);

    const result = autoWipCommit(root, preFp, postFp);
    expect(result.committed).toBe(false);
    if (!result.committed) expect(result.reason).toContain('pre-existing dirty path changed');
    expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(headBefore);
    expect(indexState(root)).toBe(indexBefore);
    expect(git(root, 'rev-list', '--count', 'HEAD').trim()).toBe('1');
  });

  it('leg-modified clean tracked file refuses (finding 2): a modified tracked path is not a new path', () => {
    const root = gitRepo(tempDir);
    // gitRepo commits tracked.txt clean, so checkoutFingerprint omits it — it is ABSENT from preFp.
    // The leg both MODIFIES tracked.txt and creates leg-new.txt, so postFp∖preFp is {tracked.txt,
    // leg-new.txt}. Before the fix the modified tracked file entered safeSet and its change was
    // committed; it must instead make the whole operation unsafe → refuse.
    const preFp = requireFp(root);
    writeFileSync(join(root, 'tracked.txt'), 'committed\nleg appended\n');
    writeFileSync(join(root, 'leg-new.txt'), 'leg\n');
    const postFp = requireFp(root);
    const headBefore = git(root, 'rev-parse', 'HEAD').trim();
    const indexBefore = indexState(root);

    const result = autoWipCommit(root, preFp, postFp);
    expect(result.committed).toBe(false);
    if (!result.committed) {
      expect(result.reason).toContain('tracked path');
      expect(result.reason).toContain('tracked.txt');
    }
    // Nothing committed, nothing staged — the modification stays the operator's to resolve.
    expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(headBefore);
    expect(git(root, 'rev-list', '--count', 'HEAD').trim()).toBe('1');
    expect(indexState(root)).toBe(indexBefore);
  });

  it('renamed tracked file refuses (qodo #5): a rename destination is not an untracked new path', () => {
    const root = gitRepo(tempDir);
    const preFp = requireFp(root);
    // The leg renames a clean tracked file. checkoutFingerprint records the rename under its
    // destination path with an 'R' status (the source is consumed as the paired NUL field), so the
    // destination is absent from preFp but is NOT '??'. It must refuse — never stage the destination
    // and leave the source deleted (a copy committed while the fallback inherits the source deletion).
    git(root, 'mv', 'tracked.txt', 'renamed.txt');
    const postFp = requireFp(root);
    expect(postFp.entries.get('renamed.txt')?.startsWith('R')).toBe(true);
    const headBefore = git(root, 'rev-parse', 'HEAD').trim();
    const indexBefore = indexState(root);

    const result = autoWipCommit(root, preFp, postFp);
    expect(result.committed).toBe(false);
    if (!result.committed) expect(result.reason).toContain('tracked path');
    expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(headBefore);
    expect(git(root, 'rev-list', '--count', 'HEAD').trim()).toBe('1');
    expect(indexState(root)).toBe(indexBefore);
  });

  it('head-moved-under-us refuses (finding 1): a HEAD advance after the fingerprint is not overwritten', () => {
    const root = gitRepo(tempDir);
    const preFp = requireFp(root);
    writeFileSync(join(root, 'leg-new.txt'), 'leg\n');
    const postFp = requireFp(root);
    // HEAD advances AFTER postFp was captured — a concurrent leg/commit lands real work at B. An
    // unconditional update-ref parented on the re-resolved HEAD would revert it; the pre-check (and,
    // for a tighter race, the update-ref compare-and-swap) must refuse instead.
    writeFileSync(join(root, 'concurrent.txt'), 'landed between fingerprint and auto-wip\n');
    git(root, 'add', 'concurrent.txt');
    git(root, 'commit', '-q', '-m', 'concurrent B');
    const headB = git(root, 'rev-parse', 'HEAD').trim();

    const result = autoWipCommit(root, preFp, postFp);
    expect(result.committed).toBe(false);
    if (!result.committed) expect(result.reason).toContain('HEAD moved after fingerprint');
    // The concurrent commit is NOT reverted and no auto-WIP commit was layered on: HEAD is still B.
    expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(headB);
    expect(git(root, 'log', '-1', '--format=%s').trim()).toBe('concurrent B');
    expect(git(root, 'rev-list', '--count', 'HEAD').trim()).toBe('2');
  });

  it('path-scope isolation: commits only the leg new file; orchestrator staged file is untouched', () => {
    const root = gitRepo(tempDir);
    writeFileSync(join(root, 'orch-staged.txt'), 'orchestrator staged\n');
    git(root, 'add', 'orch-staged.txt');
    const preFp = requireFp(root);
    writeFileSync(join(root, 'leg-new.txt'), 'leg created\n');
    const postFp = requireFp(root);
    const orchEntryBefore = indexEntry(root, 'orch-staged.txt');
    const stagedBefore = git(root, 'diff', '--cached', '--', 'orch-staged.txt');

    const result = autoWipCommit(root, preFp, postFp);
    expect(result.committed).toBe(true);
    expect(committedPaths(root)).toEqual(['leg-new.txt']);
    // The orchestrator's staged entry is byte-identical, and the committed path is reconciled CLEAN
    // (finding 3) instead of left staged-for-deletion — so the whole index is no longer identical.
    expect(indexEntry(root, 'orch-staged.txt')).toBe(orchEntryBefore);
    expect(pathStatus(root, 'leg-new.txt')).toBe('');
    expect(git(root, 'diff', '--cached', '--', 'orch-staged.txt')).toBe(stagedBefore);
    expect(git(root, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n')).not.toContain('orch-staged.txt');
    expect(git(root, 'show', 'HEAD:leg-new.txt')).toBe('leg created\n');
  });

  it('pathspec-magic literal: a :(glob) filename commits as a literal path', () => {
    const root = gitRepo(tempDir);
    writeFileSync(join(root, 'x'), 'would match glob\n');
    const preFp = requireFp(root);
    writeFileSync(join(root, ':(glob)x'), 'literal magic\n');
    const postFp = requireFp(root);

    const result = autoWipCommit(root, preFp, postFp);
    expect(result.committed).toBe(true);
    expect(committedPaths(root)).toEqual([':(glob)x']);
    const ls = git(root, 'ls-tree', '-r', 'HEAD');
    const line = ls.split('\n').find((row) => row.endsWith('\t:(glob)x'));
    expect(line).toBeTruthy();
    const blob = line!.split(/\s+/)[2];
    expect(git(root, 'cat-file', '-p', blob)).toBe('literal magic\n');
    expect(git(root, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n')).not.toContain('x');
    expect(git(root, 'status', '--short', '--', 'x')).toContain('x');
  });

  it('refresh-no-false-block: fallbackBarrier against the refreshed fingerprint does not block', () => {
    const root = gitRepo(tempDir);
    const preFp = requireFp(root);
    writeFileSync(join(root, 'leg-new.txt'), 'leg\n');
    const postFp = requireFp(root);

    const result = autoWipCommit(root, preFp, postFp);
    expect(result.committed).toBe(true);
    if (!result.committed) throw new Error('expected commit');
    // Finding 3 guard: the committed path is reconciled CLEAN, so it is ABSENT from the refreshed
    // fingerprint. Before the fix it lingered as a '??' entry masking a staged-for-deletion — the
    // phantom that would install a hidden staged deletion as the next barrier's baseline.
    expect(result.newFp.entries.has('leg-new.txt')).toBe(false);
    expect(pathStatus(root, 'leg-new.txt')).toBe('');
    const barrier = fallbackBarrier(root, result.newFp);
    expect(barrier.blocked).toBe(false);
  });

  it('index isolation: orchestrator entry untouched; committed path reconciled on success; index untouched on refusal', () => {
    const root = gitRepo(tempDir);
    writeFileSync(join(root, 'orch-staged.txt'), 'staged\n');
    git(root, 'add', 'orch-staged.txt');
    const indexBefore = indexState(root);
    const orchEntryBefore = indexEntry(root, 'orch-staged.txt');
    const statusBefore = statusState(root);

    const preFp = requireFp(root);
    writeFileSync(join(root, 'keep.txt'), 'keep\n');
    writeFileSync(join(root, 'gone.txt'), 'gone\n');
    const postFp = requireFp(root);
    rmSync(join(root, 'keep.txt'));
    rmSync(join(root, 'gone.txt'));
    const failed = autoWipCommit(root, preFp, postFp);
    expect(failed.committed).toBe(false);
    if (!failed.committed) expect(failed.reason).toContain('vanished');
    // A REFUSED auto-WIP touches the real index zero times — whole-index byte-identity still holds.
    expect(indexState(root)).toBe(indexBefore);

    writeFileSync(join(root, 'leg-new.txt'), 'leg\n');
    const successPost = requireFp(root);
    const success = autoWipCommit(root, preFp, successPost);
    expect(success.committed).toBe(true);
    // On SUCCESS the real index is written once, and only to reconcile the leg's OWN committed path:
    // the orchestrator's staged entry is byte-identical, the committed path is now a clean index entry
    // (not staged-for-deletion — finding 3), and nothing else moved. The whole index is intentionally
    // no longer identical (that assertion enshrined the phantom-deletion bug).
    expect(indexEntry(root, 'orch-staged.txt')).toBe(orchEntryBefore);
    expect(pathStatus(root, 'leg-new.txt')).toBe('');
    expect(indexEntry(root, 'leg-new.txt').length).toBeGreaterThan(0);
    expect(git(root, 'diff', '--cached', '--', 'orch-staged.txt').length).toBeGreaterThan(0);
    expect(statusBefore.includes('orch-staged.txt')).toBe(true);
    expect(statusState(root).includes('orch-staged.txt')).toBe(true);
  });

  it('reconcile failure after update-ref rolls HEAD back (finding B): index.lock blocks reset, tree restored as found', () => {
    const root = gitRepo(tempDir);
    writeFileSync(join(root, 'orch-staged.txt'), 'staged\n');
    git(root, 'add', 'orch-staged.txt');
    const preFp = requireFp(root);
    writeFileSync(join(root, 'leg-new.txt'), 'leg\n');
    const postFp = requireFp(root);
    const headBefore = git(root, 'rev-parse', 'HEAD').trim();
    const indexBefore = indexState(root);

    // Hold the real index lock so the post-commit reconcile `git reset` fails, while the temp-index
    // staging, commit-tree, and update-ref (none of which take .git/index.lock) all succeed. The
    // failure path must roll HEAD back via compare-and-swap, leaving the tree exactly as found.
    const lock = join(root, '.git', 'index.lock');
    writeFileSync(lock, '');
    const result = autoWipCommit(root, preFp, postFp);
    rmSync(lock);

    expect(result.committed).toBe(false);
    if (!result.committed) expect(result.reason).toContain('reconcile');
    expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(headBefore);
    expect(git(root, 'rev-list', '--count', 'HEAD').trim()).toBe('1');
    expect(indexState(root)).toBe(indexBefore);
    // The leg's file is back to plain untracked — no phantom staged-deletion left behind.
    expect(pathStatus(root, 'leg-new.txt')).toBe('?? leg-new.txt');
  });

  it('vanished-path tolerance: remaining safeSet paths still commit; all-vanished refuses', () => {
    const root = gitRepo(tempDir);
    const preFp = requireFp(root);
    writeFileSync(join(root, 'keep.txt'), 'keep\n');
    writeFileSync(join(root, 'gone.txt'), 'gone\n');
    const postFp = requireFp(root);
    rmSync(join(root, 'gone.txt'));

    const partial = autoWipCommit(root, preFp, postFp);
    expect(partial.committed).toBe(true);
    expect(committedPaths(root)).toEqual(['keep.txt']);

    const pre2 = requireFp(root);
    writeFileSync(join(root, 'a.txt'), 'a\n');
    writeFileSync(join(root, 'b.txt'), 'b\n');
    const post2 = requireFp(root);
    rmSync(join(root, 'a.txt'));
    rmSync(join(root, 'b.txt'));
    const headBefore = git(root, 'rev-parse', 'HEAD').trim();
    const allGone = autoWipCommit(root, pre2, post2);
    expect(allGone.committed).toBe(false);
    expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(headBefore);
  });

  it('opt-in surface: absent/false refuses; true with an isolable tree proceeds', async () => {
    const restore = installRouting(tempDir);
    try {
      const absentRoot = gitRepo(tempDir);
      const absentHarness = adapterHarness({
        codex: () => { writeFileSync(join(absentRoot, 'primary-dirt.txt'), 'dirty\n'); return failure(); },
        cursor: success,
      });
      const absent = await dispatch(request(absentRoot), tempLedger(), absentHarness.factory);
      expect(absent.refusal?.code).toBe('fallback-blocked-dirty-tree');
      expect(absentHarness.calls.map((call) => call.provider)).toEqual(['codex']);
      expect(git(absentRoot, 'rev-list', '--count', 'HEAD').trim()).toBe('1');

      const falseRoot = gitRepo(tempDir);
      const falseHarness = adapterHarness({
        codex: () => { writeFileSync(join(falseRoot, 'primary-dirt.txt'), 'dirty\n'); return failure(); },
        cursor: success,
      });
      const off = await dispatch(request(falseRoot, { fallbackWipCommit: false }), tempLedger(), falseHarness.factory);
      expect(off.refusal?.code).toBe('fallback-blocked-dirty-tree');
      expect(falseHarness.calls.map((call) => call.provider)).toEqual(['codex']);
      expect(git(falseRoot, 'rev-list', '--count', 'HEAD').trim()).toBe('1');

      const onRoot = gitRepo(tempDir);
      const onHarness = adapterHarness({
        codex: () => { writeFileSync(join(onRoot, 'primary-dirt.txt'), 'dirty\n'); return failure(); },
        cursor: success,
      });
      const on = await dispatch(request(onRoot, { fallbackWipCommit: true }), tempLedger(), onHarness.factory);
      expect(on).toMatchObject({ ok: true, provider: 'cursor', usedFallback: true });
      expect(onHarness.calls.map((call) => call.provider)).toEqual(['codex', 'cursor']);
      expect(committedPaths(onRoot)).toEqual(['primary-dirt.txt']);
      expect(git(onRoot, 'show', 'HEAD:primary-dirt.txt')).toBe('dirty\n');
    } finally { restore(); }
  });

  it('gitignored leg files never enter safeSet and are not committed', () => {
    const root = gitRepo(tempDir);
    writeFileSync(join(root, '.gitignore'), 'secret.bin\n');
    git(root, 'add', '.gitignore');
    git(root, 'commit', '-q', '-m', 'ignore');
    const preFp = requireFp(root);
    writeFileSync(join(root, 'secret.bin'), 'ignored\n');
    writeFileSync(join(root, 'visible.txt'), 'visible\n');
    const postFp = requireFp(root);
    expect(postFp.entries.has('secret.bin')).toBe(false);
    expect(postFp.entries.has('visible.txt')).toBe(true);

    const result = autoWipCommit(root, preFp, postFp);
    expect(result.committed).toBe(true);
    expect(committedPaths(root)).toEqual(['visible.txt']);
    expect(git(root, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n')).not.toContain('secret.bin');
  });

  it('nested cwd: rescues the safe new file when dispatched from a subdirectory (codex P2)', () => {
    const root = gitRepo(tempDir);
    const sub = join(root, 'sub');
    mkdirSync(sub);
    // Fingerprint FROM the nested cwd. git status emits ROOT-relative paths there ('sub/new.txt'),
    // so before the fix pathStillExists/git add resolved them against the subdir and dropped the file
    // as "vanished" — the opt-in silently failed. autoWipCommit must resolve the repo top level.
    const preFp = requireFp(sub);
    writeFileSync(join(sub, 'new.txt'), 'leg created in sub\n');
    const postFp = requireFp(sub);
    expect(postFp.entries.has('sub/new.txt')).toBe(true);
    // checkoutFingerprint hashed the real path from the repo top level, not sub/sub/new.txt — so the
    // digest is a real content hash, not the '<missing>' a nested-cwd join would have produced.
    expect(postFp.entries.get('sub/new.txt')).not.toContain('<missing>');

    const result = autoWipCommit(sub, preFp, postFp);
    expect(result.committed).toBe(true);
    expect(committedPaths(root)).toEqual(['sub/new.txt']);
    expect(git(root, 'show', 'HEAD:sub/new.txt')).toBe('leg created in sub\n');
    // The committed path reconciles clean even though the fingerprint was taken from the nested cwd.
    expect(pathStatus(root, 'sub/new.txt')).toBe('');
    if (result.committed) expect(result.newFp.entries.has('sub/new.txt')).toBe(false);
  });

  it('top-level path ending in whitespace is preserved (codex re-convergence P3)', () => {
    // A repo whose top-level directory name ends in a space: `git rev-parse --show-toplevel` returns
    // the whitespace-preserving path, and a `.trim()` would drop the space and leave a nonexistent
    // path — the auto-WIP would then falsely refuse. repoTopLevel strips only git's trailing newline.
    const root = join(tempDir(), 'ws-repo ');
    mkdirSync(root);
    git(root, 'init', '-q');
    git(root, 'config', 'user.email', 't@t');
    git(root, 'config', 'user.name', 't');
    git(root, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(root, 'tracked.txt'), 'committed\n');
    git(root, 'add', 'tracked.txt');
    git(root, 'commit', '-q', '-m', 'init');
    const preFp = requireFp(root);
    writeFileSync(join(root, 'leg-new.txt'), 'leg\n');
    const postFp = requireFp(root);

    const result = autoWipCommit(root, preFp, postFp);
    expect(result.committed).toBe(true);
    expect(committedPaths(root)).toEqual(['leg-new.txt']);
    expect(git(root, 'show', 'HEAD:leg-new.txt')).toBe('leg\n');
  });
});
