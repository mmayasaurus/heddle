import { defineConfig } from 'vitest/config';

/**
 * heddle test runner — vitest, matching the first consumer project's choice so fleet agents write tests the same
 * way in both repos. Tests live under `test/` (never in `src/`, which is what `tsc` builds into
 * `dist/`) and import sources directly from `../src/*.js` — vite resolves the NodeNext `.js`
 * specifiers to the `.ts` files, so nothing needs a build step first.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    environment: 'node',
    // Strip identity/worker/env overrides so results don't depend on who runs the suite (a heddle
    // worker inherits HEDDLE_WORKER=1 and would trip depth-1 in every un-injected dispatch test).
    setupFiles: ['test/setup.ts'],
    // node:sqlite (the ledger) is still flagged experimental on Node 22. `--disable-warning=<type>`
    // (Node ≥ 20.11/21.3) silences ONLY that category — unlike `--no-warnings[=…]`, whose `=…`
    // suffix is ignored and which hides every process warning (verified 2026-08-15, Node 22.23:
    // a DeprecationWarning stays visible under --disable-warning, vanishes under --no-warnings).
    execArgv: ['--disable-warning=ExperimentalWarning'],
    // Vitest's 5s default is wrong for THIS suite: most dispatch/review/materialization tests spawn
    // real subprocesses (git, and fake adapters through the full pipeline) — a single mandate
    // snapshot alone is ~6 git spawns — and vitest runs test FILES in parallel with no worker cap.
    // On a developer box already running several agent sessions (load 40+ observed 2026-08-16) the
    // slow files timed out NONDETERMINISTICALLY: the failing file moved run to run, each passed in
    // isolation, and CI stayed green because its runner is quiet. Diagnosed jointly with Agent V
    // (HED-98) from saved output — "Test timed out in 5000ms", never an assertion diff. 30s is the
    // floor for a subprocess test here; the two snapshot-heaviest keep explicit 45s budgets.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Every dispatch/ledger test must point Ledger at a temp path — never ~/.heddle/ledger.db.
    // (Enforced by convention + the ledger tests themselves; see test/ledger.test.ts.)
  },
});
