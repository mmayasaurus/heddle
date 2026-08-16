# PR discipline — heddle (core)

## Branching & Linear

- **No direct commits to `main`.** Every change: branch → PR → sweep → merge.
- Team **HED** (`LIN_TEAM=HED`). Run `lin.sh` from `/Users/mayatobi/Developer/Spinventory-Rebuild-App` with `.claude/bin/lin.sh --agent <letter>`.
- **`lin.sh view HED-n`** before coding — use its suggested branch name.
- PR title: **`[Agent <letter>] …`** · PR body: **`Fixes HED-n`** (required).

## Review sweep (before clean / merge)

Full procedure: **[docs/REVIEW-SWEEP.md](../../docs/REVIEW-SWEEP.md)** in this repo.

Mechanical gates:

- Run **`/Users/mayatobi/Developer/Spinventory-Rebuild-App/.claude/bin/pr-sweep.sh <n>`** — all channels (a–e), every author, code-scanning alerts included.
- **Two consecutive sweeps exit 0**, ≥15 min apart, against the **same HEAD** commit.
- Driving a PR you didn't open? **`pr-own.sh claim <n>`** first (`check` in the sweep).

After merge:

```sh
SYNC_REPO_DIR=/Users/mayatobi/Developer/heddle \
  /Users/mayatobi/Developer/Spinventory-Rebuild-App/.claude/bin/pr-linear-sync.sh
lin.sh resolve HED-n "<summary + PR #>"
```

## Self-merge (standing authorization)

When all six conditions in `/Users/mayatobi/Developer/Spinventory-Rebuild-App/.claude/rules/heddle-self-merge.md` hold, you may merge your own PR without waiting for Maya:

1. Two `pr-sweep.sh` exits 0, ≥15 min apart at HEAD (docs-only main drift exception per that file).
2. Every non-empty review body addressed (fix or reply+resolve with rationale).
3. All required checks green at HEAD.
4. Merge commit only, pinned to the swept commit (`gh pr merge <n> --merge --match-head-commit <swept-sha>`) — never squash, never force-push.
5. PR body has `Fixes HED-n`; branch up to date with current `main` (merge `origin/main` in — never rebase a published branch).
6. Stacked PRs merge bottom-up (base first, retarget children, re-sweep).

Still waits for Maya: security-semantics changes, user-visible feature removal, or touching another agent's files — see the full rule.
