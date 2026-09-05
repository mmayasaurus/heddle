import { afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../src/ledger.js';
import type { BoundIdentity } from '../src/identity.js';
import type { DispatchOptions, WorkerAdapter, WorkerResult } from '../src/types.js';

export function useTempResources(prefix = 'heddle-test-') {
  const dirs: string[] = [];
  const ledgers: Ledger[] = [];

  afterEach(() => {
    for (const ledger of ledgers) {
      try {
        ledger.close();
      } catch {
        // A test may explicitly close a ledger before resource cleanup.
      }
    }
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
    ledgers.length = 0;
  });

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }

  function track(dir: string): void {
    dirs.push(dir);
  }

  function trackLedger(ledger: Ledger): Ledger {
    ledgers.push(ledger);
    return ledger;
  }

  function tempLedger(): Ledger {
    return trackLedger(new Ledger(join(tempDir(), 'ledger.db')));
  }

  return { tempDir, tempLedger, track, trackLedger };
}

export function fakeAdapter(
  result: WorkerResult = { ok: true, output: 'done', exitCode: 0 },
  opts: { readAgents?: boolean } = {},
): { adapter: WorkerAdapter; calls: Array<{ prompt: string; opts: DispatchOptions; agents?: string }> } {
  const calls: Array<{ prompt: string; opts: DispatchOptions; agents?: string }> = [];
  const adapter: WorkerAdapter = {
    name: 'fake',
    provider: 'codex',
    dispatch: async (prompt, dispatchOpts) => {
      calls.push({
        prompt,
        opts: dispatchOpts,
        ...(opts.readAgents !== false ? { agents: readFileSync(join(dispatchOpts.cwd, 'AGENTS.md'), 'utf8') } : {}),
      });
      return result;
    },
  };
  return { adapter, calls };
}

export const IDENTITIES = {
  unbound: { agent: null, source: 'unbound', worker: null },
  boundU: { agent: 'U', source: 'env:HEDDLE_AGENT', worker: null },
} as const satisfies Record<'unbound' | 'boundU', BoundIdentity>;

// Hermetic git for fixtures: no operator global/system config (gpgsign, hooksPath, …) and none of the
// env vars through which git ignores cwd or takes injected config — the leak the code under test
// must be immune to. Shared by the repo-aware-gate and guidance tests (HED-389).
export const HERMETIC_GIT_ENV: NodeJS.ProcessEnv = (() => {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_CONFIG_COUNT']) delete env[name];
  return env;
})();

export function hermeticGit(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: HERMETIC_GIT_ENV });
}

/**
 * A `git init` repository at `root`. The returned cwd is `root/<relativeCwd>` — a plain subdirectory,
 * or (linkedWorktree) a REAL linked worktree created with `git worktree add`, which may sit outside
 * `root` (`../Rebuild-Project-Root.<feature>` is how a consumer fleet lays its worktrees out).
 * Linked worktrees matter: `git rev-parse --show-toplevel` there is the WORKTREE path, which is the
 * identity bug HED-389's tests exist to catch — a subdirectory of the repo cannot see it.
 */
export function initRepoFixture(
  root: string, relativeCwd: string, opts: { remote?: string; linkedWorktree?: boolean } = {},
): string {
  mkdirSync(root, { recursive: true });
  hermeticGit(root, 'init', '-q');
  if (opts.remote) hermeticGit(root, 'remote', 'add', 'origin', opts.remote);
  const cwd = join(root, relativeCwd);
  if (opts.linkedWorktree) {
    hermeticGit(root, '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-q', '-m', 'init');
    hermeticGit(root, 'worktree', 'add', '-q', cwd, '-b', 'worker');
  } else {
    mkdirSync(cwd, { recursive: true });
  }
  return cwd;
}
