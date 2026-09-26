# Git-level guard

Rules enforced in git hooks bind every agent provider at once, because Claude Code, Codex and
Cursor seats all run git. A repository opts in by pointing `core.hooksPath` at a folder of small
wrappers that call `heddle_git_guard.py` with a JSON config.

| Rule | Hook | What it refuses |
|---|---|---|
| `no_main_merge` | pre-merge-commit, pre-commit, pre-push | a merge on a non-main branch that brings in commits from main's first-parent line (`git merge main`, `git merge origin/main`, `git pull origin main`, a SHA on main) |
| `no_protected_paths` | pre-commit, pre-push | adding or changing the configured agent/harness paths, except on the allowed branches; deleting them is always allowed |
| `no_push_to_main` | pre-push | pushing to `main`/`master` |
| `no_force_push` | pre-push | non-fast-forward updates of branches and tags |
| `no_remote_delete` | pre-push | deleting a remote branch or tag |
| `worktree_cap` | pre-commit, pre-push | more folders than the cap in the worktrees folder: warns (`warn`) or refuses (`block`); listed creators are never refused |
| `worktree_alert` | post-checkout | a new worktree made by anyone not in `worktree_creators` (reported, never removed) |
| backstops | post-commit, post-merge | commits or merges that skipped the hooks: alert only |

After its own checks the engine runs the repository's own hook of the same name from
`<git-common-dir>/hooks` (for example Git LFS), with the same arguments and standard input.
If the engine itself fails it warns, logs, and still runs that hook (fail open).

Names in the messages come from the config, never from the code: `rule_owner` (who set the
rules), `orchestrator` (who handles worktrees, merges and deletions; defaults to the first
`worktree_creators` entry) and `protected_paths_reason`. See `guard.example.json`.

## Install

```sh
sh make-git-guard-hooks.sh ~/.heddle/fleet/git-hooks/<project>/hooks \
  ~/.heddle/fleet/git-hooks/heddle_git_guard.py ~/.heddle/fleet/git-hooks/<project>/guard.json
git config --file <repo>/.git/config core.hooksPath ~/.heddle/fleet/git-hooks/<project>/hooks
HEDDLE_GIT_GUARD_CONFIG=~/.heddle/fleet/git-hooks/<project>/guard.json python3 heddle_git_guard.py --selftest
```

Emergency off switch for one rule: set it to `false` in the config's `checks` map. Off for the
whole repository: `git config --file <repo>/.git/config --unset core.hooksPath` (the
repository's own hooks in `.git/hooks` then run as before).

## Companion pieces

- `../hooks/git-bypass-guard.py`: PreToolUse guard for Claude Code and Codex that refuses the
  ways around these hooks (`core.hooksPath` overrides, `--no-verify`, `git commit -n`),
  merging main into another branch, `git grep`, `git sparse-checkout`, and `git worktree
  add`/`move`, `git clone` and `gh repo clone` by anyone but the orchestrator. Its optional
  config (`HEDDLE_BYPASS_GUARD_CONFIG`, default `~/.heddle/fleet/hooks/git-bypass-guard.json`)
  names the orchestrator and limits the worktree and clone rule to listed repositories; with
  no list that rule applies everywhere. It is activated per provider as a PreToolUse command
  hook on the shell tool; the file's docstring has the config format.
- `local-pr-check.sh`: runs a pinned hygiene script on a PR's exact head on the local machine
  and posts a free GitHub commit status, instead of paid GitHub Actions minutes.

Tests: `tests/run-tests.sh <empty-dir>`, `tests/test-local-check.sh <empty-dir> <hygiene.sh>`,
`../hooks/tests/test_git_bypass_guard.py [empty-dir]`. They use throwaway repositories only.
