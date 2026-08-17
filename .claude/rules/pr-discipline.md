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
5. PR body has `Fixes HED-n`; branch **not CONFLICTING** — `gh pr view <n> --json mergeable` reads
   `MERGEABLE` (poll past `UNKNOWN`, which only means GitHub is still computing). A forward-merge is
   REQUIRED only when it reads `CONFLICTING` — then merge the base repository's `main` in (from a fork that is the base repo's
   remote, not the fork's `origin/main`; never rebase a published branch); a branch that is merely
   behind merges as-is. Mind the enum: `mergeable` is only `MERGEABLE` / `CONFLICTING` / `UNKNOWN`,
   and it is what this rule keys on — behind-ness appears in `mergeStateStatus` (`BEHIND`,
   `UNSTABLE`, `CLEAN`, `BLOCKED`), which is informational here, not a gate. **Do not merge main forward just because main moved** (Maya-ratified
   2026-08-17): nothing requires it — both rulesets are `strict: false`, so `gate` at HEAD is the only
   enforced gate — Spinventory has the same posture with agents A–Q merging all day, and on a repo
   with six active agents it does not converge, since each forward-merge is a new HEAD costing a fresh
   CI run plus a fresh 15-minute double sweep while main advances again inside that window. The safety
   net is `gate` on every push to `main`. Note the distinction: no forward-merge is REQUIRED without a
   conflict, but you are always PERMITTED to merge main in — do it when your change feels semantically
   load-bearing against something that just landed.
6. Stacked PRs merge bottom-up (base first, retarget children, re-sweep).

Still waits for Maya: security-semantics changes, user-visible feature removal, or touching another agent's files — see the full rule.

## Config-text exception (Maya-ratified 2026-08-16) — SUPERSEDED 2026-08-17

**Superseded by condition 5 above** (Maya, 2026-08-17), which grants the same relief to EVERY
non-conflicting PR regardless of file class — this exception was a narrow patch for exactly the
problem condition 5 now solves generally. Its same-breath overlap measurement is no longer required.
Kept below for provenance, since merge reports from 2026-08-16 cite it.

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
