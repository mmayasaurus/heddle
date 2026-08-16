# Worktree discipline — heddle (core)

Maya's standing policy (2026-08-15). Fleet history/rationale:
`/Users/mayatobi/Developer/Spinventory-Rebuild-App/.claude/rules/worktree-discipline.md`

## Location & naming

- Worktrees live **inside the repo**: `.worktrees/<agent>-<lane>` (e.g. `.worktrees/S-ci`).
  Never as `~/Developer` siblings — those are the legacy layout; move any you still have
  (`git worktree move <old> .worktrees/<name>` — lossless; then re-register the memtrace
  watch at the new path: `unwatch_directory(old)` + `watch_directory(new, repo_id="heddle")`).
- `.worktrees/` is gitignored and memtrace-ignored; tooling excludes are wired in this repo's
  configs so commands run at the REPO ROOT never recurse into sibling worktrees. Inside your OWN
  worktree, run everything normally (lint, tests, scans — that's what it is for).

## Recycle, don't mint

**One worktree per agent per repo.** Between tasks, stay in it: `git fetch` and start the next
branch off fresh `origin/main` in the SAME folder. Do not create a new worktree per task.

## Lifecycle

1. Branch off latest `origin/main`; register the memtrace overlay immediately:
   `watch_directory(path="<worktree>", repo_id="heddle")`.
2. Commit as you go — uncommitted work is invisible and easy to lose.
3. PR → full sweep (see `pr-discipline.md`) → merge promptly. **Branches are kept after merge.**
4. **Removal (standing authorization, Maya 2026-08-15):** a worktree may be removed WITHOUT a
   further per-item ask only when ALL hold — its branches are fully merged to `origin/main`,
   `git status` is clean, and no live agent has its cwd inside. Then:
   `git worktree remove <dir>` + `unwatch_directory(path="<dir>")` immediately.
   Anything with uncommitted work stays until committed to a `wip/` branch or Maya rules.
   **No worktree may remain that no agent is using.**
