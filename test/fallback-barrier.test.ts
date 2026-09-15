import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dispatch, type AdapterFactory, type DispatchRequest } from '../src/dispatch.js';
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
        `Commit or discard the changes in ${root}, then re-dispatch.`,
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
