# Heddle Core Repo Skill Pack

Instructions for working inside the `heddle` core repository worktree.

## Verification & Commands
- **Typecheck**: `npm run typecheck` (`tsc --noEmit -p tsconfig.test.json` — checks both `src/` and `test/`) (`package.json`, `.github/workflows/gate.yml`)
- **Test**: `npm test` (`vitest run` — executes unit tests under `test/**/*.test.ts` directly against `src/` without requiring a pre-build step) (`package.json`, `vitest.config.ts`)
- **Build**: `npm run build` (`tsc` — compiles `src/` to `dist/`) (`package.json`)
- **Node Engine**: Node `>=22.12.0` is required (`package.json`, `.github/workflows/gate.yml`)

## Test Discipline & Conventions
- **Behavioral Testing Bar**: Assert observable effects (persisted ledger rows, output argv, created files, returned data), never merely that a flag or toggle flipped. (`.github/workflows/gate.yml`, `docs/CI.md`, `README.md`)
- **Source Imports in Tests**: Tests live under `test/` (never in `src/`) and import sources directly using NodeNext `.js` specifiers (`../src/*.js`), which Vitest resolves to `.ts` files. (`vitest.config.ts`)
- **Ledger Path Discipline**: Every test touching the ledger MUST pass an explicit temporary path to `new Ledger(<temp path>)` — never touch `~/.heddle/ledger.db`. (`vitest.config.ts`, `README.md`)
- **Experimental Warnings**: SQLite (`node:sqlite`) is experimental on Node 22; Vitest passes `execArgv: ['--disable-warning=ExperimentalWarning']`. (`vitest.config.ts`)

## Worktree & Execution Discipline
- **Worktree Boundaries**: Agent worktrees live at `.worktrees/<agent>-<lane>` inside the repository. A worker's current working directory IS its project root — NEVER walk up to parent checkouts. (`.claude/rules/worktree-discipline.md`, `skills/worker-hygiene.md`)
- **Offline CLI Verification**: Offline CLI commands can be verified by running `node dist/cli.js classes --json` and `node dist/cli.js packs --json` (both return non-empty JSON arrays). (`.github/workflows/gate.yml`)
