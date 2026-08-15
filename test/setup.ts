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
