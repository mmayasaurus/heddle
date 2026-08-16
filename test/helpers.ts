import { afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
