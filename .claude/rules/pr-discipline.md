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

When all eight conditions in `/Users/mayatobi/Developer/Spinventory-Rebuild-App/.claude/rules/heddle-self-merge.md` hold, you may merge your own PR without waiting for Maya:

1. Two `pr-sweep.sh` exits 0, ≥15 min apart at HEAD (the non-overlapping main-advance exception is in that file).
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
7. An open code-scanning alert blocks only if it is in or touched by the diff, or it is warning
   severity or worse in a file your lane owns. An inherited one that does neither doesn't block,
   provided you characterize it (id, severity, file, age, not in the diff, open on `main`), name it and
   its disposition in one sentence of the merge report, and make sure a ticket tracks it (search
   first; no duplicates). Never dismiss another lane's alert to unblock your own merge.
8. Review loop: at least one pre-PR adversarial round has completed (a refused or timed-out round
   doesn't count), and every finding from every round is fixed on HEAD or disputed with evidence. A
   round with ≥1 high or ≥2 med engages the loop: the latest receipts must then match the authored
   diff with 0 high and <2 med, unless three rounds have run, after which it merges unconverged
   (Maya, 2026-10-05). A loop whose rounds all failed keeps retrying until one completes, and doesn't
   go to Maya.

Since Maya's standing merge rule of 2026-10-05, security-semantics changes, user-visible feature
removal and PRs touching another agent's files merge on these same conditions. Still hers, before
the work: her own enumeration of a delete-set before a deleter is built
(`/Users/mayatobi/Developer/Spinventory-Rebuild-App/.claude/rules/destructive-scope.md`), the
decision flags in `/Users/mayatobi/Developer/Spinventory-Rebuild-App/.claude/rules/needs-maya.md`
(each also raised with her in conversation), and CI is never bypassed. See the full rule.

## Config-text exception — SUPERSEDED 2026-08-17

Superseded by condition 5 (Maya, 2026-08-17), which gives every non-conflicting PR the same relief.
Merge reports from 2026-08-16 cite it. Its text stays in
`/Users/mayatobi/Developer/Spinventory-Rebuild-App/.claude/rules/heddle-self-merge.md` and in this
file's history: `git show 7f2d525:.claude/rules/pr-discipline.md`.
