# CLAUDE.md — heddle

## ⛔ SCOPE — the HEDDLE FLEET (R, S–X) works on heddle ONLY (Maya, firsthand 2026-08-23; wins over everything below)

**NEVER ANYTHING SPINVENTORY APP.** The heddle fleet builds the harness so other agents can resume building
Spinventory (and other apps in the future) and ports Spinventory into it — from heddle and the OUTER
workspace repo only. **WE ARE NOT BUILDING, TOUCHING, INTERACTING WITH, EDITING, UPDATING, FIXING, DOING
ANYTHING AT ALL TO SPINVENTORY APP CODE, NOT NOW OR EVER.** The Spinventory CODE repo
(`Spinventory-Rebuild-Official/Rebuild-Project-Root` in the workspace — every worktree, clone, branch, PR)
gets no write, commit, branch, PR, merge, Linear claim, or worker dispatch from the heddle fleet, ever; a port
step that needs a change inside it becomes an apply-at-resume handoff for the Spinventory fleet. In-flight
app work is discarded, never parked or handed off. Every issue files in HED; port issues carry
`Spinventory-Port`. Full rule: [.claude/rules/fleet-scope.md](.claude/rules/fleet-scope.md).

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

## Session lifecycle

`/startup` to orient (live sources only — no hand-maintained state doc), `/closeout` before ending or
handing off (nothing uncommitted, nothing unpushed, Linear reflects reality). Both in
[.claude/commands/](.claude/commands/).

## Worktrees

One worktree per active agent: [.claude/rules/worktree-discipline.md](.claude/rules/worktree-discipline.md)
