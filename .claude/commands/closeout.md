# Closeout — leave nothing stranded, and nothing overstated

Run this before ending a heddle session, before a long pause, and before any handoff. Its whole job is
that the next agent (or the next you, post-compaction) can pick up from **durable, visible** state.

The handoff artifacts are deliberately Linear comments, pushed branches and PR state — **not** a local
session file. The audit behind this command found every hand-maintained session/state directory in the
parent project empty in practice (docs/SPINVENTORY-PARITY.md): a file nobody maintains is worse than no
file, because it still gets read. Push the truth where teammates already look.

`lin.sh` and `pr-own.sh` live in the workspace bin (canonical path in `.claude/rules/issue-tracking.md`;
relocatability is HED-107) — named below without repeating the path.

Execute in order. Do not skip a step because you believe it is empty — verify it is.

## 1. Nothing uncommitted, in any worktree you touched

1. `git status --porcelain` in each worktree you worked in (both repos if applicable), **and**
   `git stash list` — stashed work leaves `git status` clean while still living only in your local
   repo, so a closeout that checks only `status` will call a dirty session clean.
2. Anything uncommitted or stashed: commit it. If it is not ready for its real branch, that is what
   `wip/<letter>-<topic>` is for — a wip branch costs nothing and uncommitted work is the single
   easiest thing to lose. Never end a session with a dirty tree or a live stash you mean to keep.
3. Scratch files that should not be committed get moved OUT of the worktree, not left untracked: an
   untracked file is exactly what a force-clean takes, and a worker dispatched into that worktree later
   may reset the state it was handed (`.claude/rules/worktree-discipline.md`).

## 2. Nothing unpushed

4. One command finds every local commit not on a remote, across all branches, including branches with
   **no upstream at all** (where `git log @{u}..HEAD` would error):
   `git log --branches --not --remotes --oneline` — anything it prints is invisible to the fleet.
5. Push each such branch **with tracking set** so it is not silently orphaned again next time:
   `git push -u origin <branch>` (never force). A plain `git push origin HEAD` uploads the commits but
   does not configure `@{u}`, so the branch keeps failing the check above.

## 3. Truthful PR state

6. For each PR you own (`pr-own.sh mine`), record in one line: number, head sha, `gate` result at that
   head, unresolved thread count, and **the specific condition blocking the merge**. The two status
   reads:
   - `gh pr checks <n>` (gate result), and `gh pr view <n> --json mergeable` (CONFLICTING vs mergeable).
   - unresolved threads: the channel (c) GraphQL query in docs/REVIEW-SWEEP.md, counting
     `isResolved == false`.
   "In review" is not a state — "sweep #2 due at HH:MM", "waiting on Maya for security semantics",
   "CONFLICTING, needs main merged in" are.
7. Any PR you will not be driving further: release ownership (`pr-own.sh release <n>`) so it is not
   stranded behind an absent agent.

## 4. Linear reflects reality

8. Issues you finished: `LIN_TEAM=HED lin.sh resolve HED-n "<what landed + merge sha + what was NOT done>"`.
9. Issues you claimed but did not start: say so on the ticket, or release the claim. A claim nobody is
   working is worse than an unclaimed issue, because it looks handled.
10. Anything you discovered but did not fix: file it (`LIN_TEAM=HED lin.sh create …`) before you forget
    it. A finding that lives only in a session transcript is lost at compaction.

## 5. Handoff, in one place each

11. One line to the orchestrator (R): what landed with merge shas, what is in flight with its blocking
    condition, what you claimed next.
12. For any in-flight ticket a teammate might pick up: a comment ON THE TICKET with the state and the
    next concrete step — not a summary in chat that scrolls away.

## 6. Verify, then report

13. Re-run `git status --porcelain`, `git stash list`, and the unpushed check from step 4. Assert clean.
    If you cannot, say exactly what is dirty and why.
14. Report in this shape, and keep the last section honest — it is the one that matters most to whoever
    reads this next:
    - **Landed:** with merge shas.
    - **In flight:** with the blocking condition per item.
    - **NOT done / not attempted:** explicitly, including anything you ran out of time for.
    - **Tested vs merely written:** which claims are backed by a run you saw, and which are not.
    - **Known risks / unverified:** what could break that you did not check.

"Tests pass" is not "it works", and a green local gate is not a clean PR. Say which one you actually have.
