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
   **COMMIT BEFORE DISPATCH — never dispatch a worker into a worktree with uncommitted changes;
   a worker may reset the state it was handed.** Not hypothetical: on 2026-08-17 a dispatched
   worker ran `git checkout -- .` followed by `git clean -fd` inside another agent's worktree and
   destroyed uncommitted work (recovered from patches). So, before every dispatch: **make
   `git status` clean.** Commit real work (a `wip/` branch is enough) and move scratch files out
   of the worktree — untracked files are exactly what a force-clean takes. The rule covers EVERY
   dispatch, not only workers you expect to write files: a "read-only" worker still has a shell,
   and deciding per dispatch which workers are safe is the judgment call this rule exists to
   remove.
   **Dispatch cwd = YOUR OWN worktree.** Point workers at the worktree you are working in, or at a
   scratch dir outside any repo for repo-less tasks — never a main checkout, never another agent's
   worktree (R-codified 2026-08-17 under Maya's every-agent-in-their-own-worktree directive; it had
   been only the SPEC §5 default plus incident history until V's citation challenge exposed that it
   was unwritten). A shared checkout exposes whatever untracked files happen to sit there to the
   worker's shell — which is the same blast radius as the rule above — and it muddles attribution when
   a worker leaves output behind: a stray `replies-r2.json` in the dashboard root on 2026-08-17 was
   first attributed to the wrong agent. A cross-repo need means create or reuse YOUR worktree in that
   repo, not borrow the shared root.
3. PR → full sweep (see `pr-discipline.md`) → merge promptly. **Branches are kept after merge.**
4. **Removal (standing authorization, Maya 2026-08-15):** a worktree may be removed WITHOUT a
   further per-item ask only when ALL hold — its branches are fully merged to `origin/main`,
   `git status` is clean, and no live agent has its cwd inside. Then:
   `git worktree remove <dir>` + `unwatch_directory(path="<dir>")` immediately.
   Anything with uncommitted work stays until committed to a `wip/` branch or Maya rules.
   **No worktree may remain that no agent is using.**
