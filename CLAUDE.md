# CLAUDE.md — heddle

## Memtrace first

**Use memtrace before Grep/Read/Glob on source.** `repo_id`: `heddle`. Details: [.claude/rules/memtrace-serena.md](.claude/rules/memtrace-serena.md)

## Serena

Symbol-precise edits via Serena (`find_symbol` → `replace_symbol_body`); call `initial_instructions` first. See [.claude/rules/memtrace-serena.md](.claude/rules/memtrace-serena.md).

## PR discipline

**No direct commits to `main`.** Sweep procedure: [docs/REVIEW-SWEEP.md](docs/REVIEW-SWEEP.md) · rules: [.claude/rules/pr-discipline.md](.claude/rules/pr-discipline.md)

## Linear

Team **HED** — `LIN_TEAM=HED`; claim before coding via `lin.sh` (see [.claude/rules/issue-tracking.md](.claude/rules/issue-tracking.md)).

## CI

Workflows, gate, and deterministic review: [docs/CI.md](docs/CI.md)

## Usage tap & window keeper

Tap and keeper facts live in the dashboard repo: `/Users/mayatobi/Developer/heddle-dashboard/docs/USAGE_TAP.md`

## Worktrees

One worktree per active agent: [.claude/rules/worktree-discipline.md](.claude/rules/worktree-discipline.md)
