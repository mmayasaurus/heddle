/**
 * Hermetic test environment. dispatch()/resolveIdentity() read process-bound identity and worker
 * stamps from the environment; the CLI/hook read HEDDLE_ROUTING/HEDDLE_PACKS. A test run must not
 * change behavior depending on WHO runs it — a heddle-dispatched codex worker inherits
 * HEDDLE_WORKER=1 / HEDDLE_PARENT / HEDDLE_AGENT and would otherwise see every un-injected dispatch
 * refused with depth-1 (observed live 2026-08-15, ledger #49). Tests that need these values inject
 * them explicitly (dispatch({identity}) / resolveIdentity(cwd, env)).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const k of ['HEDDLE_AGENT', 'FLEET_AGENT', 'HEDDLE_WORKER', 'HEDDLE_DISPATCH_ID', 'HEDDLE_PARENT',
  'HEDDLE_ROUTING', 'HEDDLE_PACKS', 'CLAUDE_CONFIG_DIR']) {
  delete process.env[k];
}
// Cap-aware routing (HED-67/68) reads ~/.heddle/usage + ~/.heddle/accounts.json — point both at an
// empty temp dir so no test ever routes on the operator's live caps or accounts. Tests that need
// caps inject `caps`/`accounts` on the request or set these to their own fixture dir.
const empty = mkdtempSync(join(tmpdir(), 'heddle-test-usage-'));
process.env.HEDDLE_USAGE_DIR = empty;
process.env.HEDDLE_ACCOUNTS = join(empty, 'accounts.json');
