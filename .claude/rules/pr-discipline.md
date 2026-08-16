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
5. PR body has `Fixes HED-n`; branch up to date with current `main` (merge `origin/main` in — never rebase a published branch; subject to the config-text exception below).
6. Stacked PRs merge bottom-up (base first, retarget children, re-sweep).

Still waits for Maya: security-semantics changes, user-visible feature removal, or touching another agent's files — see the full rule.

## Config-text exception (Maya-ratified 2026-08-16)

When a PR's ENTIRE diff is `.claude/**` + `docs/**` + root config-text (CLAUDE.md, README.md,
ROADMAP.md, .gitignore, .memtraceignore, ESLint ignore entries (none exist in this repo today)) — nothing under `src/`,
`src-tauri/`, tests, or `.github/workflows/` — a non-overlapping `main` advance neither forces a
re-merge nor restarts the sweep clock. Three mechanical conditions: (1) the zero-overlap
measurement runs in the SAME BREATH as the merge (against then-current main); (2) the merge is
pinned with `--match-head-commit`; (3) the merge report states the exception and the overlap
measurement. Scope notes: `.claude/**` in this repo holds only JSON and Markdown — if an
executable ever lands there, it falls OUT of this exception; a base advance in the seconds between
the overlap measurement and the merge API call is an accepted residual (gh has no base-pinning
flag; `--match-head-commit` pins our side). Rationale: the exception is about main-movement
invalidation, not diff riskiness — config-text has an empty interaction surface with incoming
code; the double-sweep still covers the PR's own correctness. Authority:
`/Users/mayatobi/Developer/Spinventory-Rebuild-App/.claude/rules/heddle-self-merge.md`.
