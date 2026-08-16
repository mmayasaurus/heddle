import { defineConfig } from 'vitest/config';

/**
 * heddle test runner — vitest, matching Spinventory's choice so fleet agents write tests the same
 * way in both repos. Tests live under `test/` (never in `src/`, which is what `tsc` builds into
 * `dist/`) and import sources directly from `../src/*.js` — vite resolves the NodeNext `.js`
 * specifiers to the `.ts` files, so nothing needs a build step first.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Strip identity/worker/env overrides so results don't depend on who runs the suite (a heddle
    // worker inherits HEDDLE_WORKER=1 and would trip depth-1 in every un-injected dispatch test).
    setupFiles: ['test/setup.ts'],
    // node:sqlite (the ledger) is still flagged experimental on Node 22. `--disable-warning=<type>`
    // (Node ≥ 20.11/21.3) silences ONLY that category — unlike `--no-warnings[=…]`, whose `=…`
    // suffix is ignored and which hides every process warning (verified 2026-08-15, Node 22.23:
    // a DeprecationWarning stays visible under --disable-warning, vanishes under --no-warnings).
    execArgv: ['--disable-warning=ExperimentalWarning'],
    // Every dispatch/ledger test must point Ledger at a temp path — never ~/.heddle/ledger.db.
    // (Enforced by convention + the ledger tests themselves; see test/ledger.test.ts.)
  },
});
