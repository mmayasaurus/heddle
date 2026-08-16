Run this repo's quality gate locally (mirrors `.github/workflows/gate.yml` — see docs/CI.md).

Execute from the repo root (or the active worktree):

1. `npm ci` if node_modules is missing or the lockfile changed; otherwise skip.
2. `npm run typecheck` — tsc over src/ AND test/ (tsconfig.test.json).
3. `npm test` — vitest (behavioral tests; a toggle-flips test is not a pass, see docs/CI.md standing rules).
4. `npm run build` — tsc emit to dist/.
5. Smoke the built CLI exactly as CI does:
   `node dist/cli.js classes --json` and `node dist/cli.js packs --json` — each must be a NON-EMPTY JSON array.

Report results as a table (Check | Result | Details). If anything fails, list the
specific errors and STOP — report, don't fix, unless asked. A green local gate is
necessary but not sufficient: the PR still needs the full review sweep
(docs/REVIEW-SWEEP.md) before it is called clean.
