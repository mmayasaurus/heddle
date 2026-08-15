/**
 * Hermetic test environment. dispatch()/resolveIdentity() read process-bound identity and worker
 * stamps from the environment; the CLI/hook read HEDDLE_ROUTING/HEDDLE_PACKS. A test run must not
 * change behavior depending on WHO runs it — a heddle-dispatched codex worker inherits
 * HEDDLE_WORKER=1 / HEDDLE_PARENT / HEDDLE_AGENT and would otherwise see every un-injected dispatch
 * refused with depth-1 (observed live 2026-08-15, ledger #49). Tests that need these values inject
 * them explicitly (dispatch({identity}) / resolveIdentity(cwd, env)).
 */
for (const k of ['HEDDLE_AGENT', 'FLEET_AGENT', 'HEDDLE_WORKER', 'HEDDLE_DISPATCH_ID', 'HEDDLE_PARENT',
  'HEDDLE_ROUTING', 'HEDDLE_PACKS']) {
  delete process.env[k];
}

// resolveIdentity() also walks up from cwd looking for a `.fleet-agent` file — env stripping cannot
// neutralize that, so fail LOUDLY instead of letting the suite silently bind an identity when run
// from a pinned worktree (tests must inject `identity` explicitly).
import { existsSync } from 'node:fs';
import { dirname, join as joinPath } from 'node:path';
{
  let dir = process.cwd();
  for (;;) {
    if (existsSync(joinPath(dir, '.fleet-agent'))) {
      throw new Error(
        `test/setup.ts: a .fleet-agent file exists at ${dir} — the suite would bind that identity via ` +
        `resolveIdentity()'s file fallback and stop being hermetic. Run the tests from a checkout ` +
        `without one (or remove it).`,
      );
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}
