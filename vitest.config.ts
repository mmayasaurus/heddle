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
    // node:sqlite (the ledger) is still flagged experimental on Node 22; the CLI entry points
    // suppress the warning the same way so agent-parsed output stays clean.
    execArgv: ['--no-warnings=ExperimentalWarning'],
    // Every dispatch/ledger test must point Ledger at a temp path — never ~/.heddle/ledger.db.
    // (Enforced by convention + the ledger tests themselves; see test/ledger.test.ts.)
  },
});
