# Startup — orient before touching anything

Run this at the start of a heddle session (or after a compaction that lost your place). It reads
**live sources only**. There is deliberately no hand-maintained "current state" document to consult:
the audit that produced this command found Spinventory's `_vault/decisions/`, `_vault/sessions/` and
`.session/` all empty in practice (docs/SPINVENTORY-PARITY.md), so a status file is a thing that rots
between the moment you write it and the moment someone trusts it. Git, Linear, and the GitHub API
cannot rot — they are the state.

**Tooling:** `lin.sh` and `pr-own.sh` live in the workspace bin — the one canonical location is
`.claude/rules/issue-tracking.md` (currently the absolute path
`/Users/mayatobi/Developer/Spinventory-Rebuild-App/.claude/bin/`; relocating the fleet bins to
`~/.heddle` is HED-96 — HED-107 made every discipline hook's resolution loud-fail-open (a missing
hook screams and is skipped, never silently vanishes; hook vendoring is HED-96 too). The steps below
name the tools without repeating the path — run them from that
bin, or with the full path on first use.

Execute in order and report as you go.

## 1. Who and where

1. Your fleet letter comes from the SessionStart primer; confirm the PR-ownership id agrees:
   `pr-own.sh whoami`.
2. `git rev-parse --show-toplevel` — must be `<repo>/.worktrees/<your-letter>-<lane>` (e.g.
   `.worktrees/S-ci`), the form `.claude/rules/worktree-discipline.md` mandates. A main checkout or
   **another agent's** worktree is a STOP — do **not** touch its contents: move to your own worktree
   (branch off fresh `origin/main`, register the memtrace overlay) and continue there. Uncommitted
   work you find in someone else's tree is theirs; leave it and tell them, never commit it.
3. In **your own** worktree only: `git status --porcelain` and `git branch --show-current` — know what
   you are sitting on before you change it. Your own uncommitted work from a previous session gets
   committed to a `wip/` branch now, not later; `git stash list` too, since stashed work is invisible
   to `git status`.

## 2. What is already yours

4. `LIN_TEAM=HED lin.sh --agent <letter> mine` — every issue you have claimed. Each is a promise:
   drive it or release it. (`LIN_TEAM=HED` is per-invocation — repeat it on every `lin.sh` call.)
5. `pr-own.sh mine` — every PR this worktree owns. For each, get its real state rather than assuming:
   `gh pr view <n> --json state,mergeable,headRefOid` and the unresolved-thread count
   (GraphQL query in docs/REVIEW-SWEEP.md channel (c)).
6. For any PR that looks finished, check the two things that actually block a merge: `gate` green at the
   CURRENT head (`gh pr checks <n>`), and whether `mergeable` says `CONFLICTING` — a branch that is
   merely behind merges as-is (`.claude/rules/pr-discipline.md` condition 5; behind-ness is
   `mergeStateStatus`, not a blocker).

## 3. What moved while you were gone

7. `git fetch origin main`, then two reads — with several agents active `main` moves fast:
   - `git log --oneline HEAD..origin/main` — what landed (read all of it, not a truncated head).
   - `git diff --name-only HEAD..origin/main -- docs/ .claude/rules/` — did any RULE change while you
     were gone? This catches a `docs/REVIEW-SWEEP.md`, `docs/CI.md` or `pr-discipline.md` edit no
     matter how many commits deep it sits. Anything listed, read before you act — a stale mental copy
     of a rule produces confidently wrong work.

## 4. Pick the next action

8. If you have claimed work in flight, that is your next action — finish it before pulling anything new.
9. If your queue is empty: `LIN_TEAM=HED lin.sh list`, claim the top unclaimed issue nearest your lane,
   and start. Do not wait for tasking (standing directive, Maya 2026-08-17). Announce the claim in one
   line so the board stays legible.

## Report

Produce a short briefing, not a narrative: identity + worktree, claimed issues, owned PRs with their
real blocking condition, what landed on `main` (and any rule that changed) since you last looked, and
**the single next action**. State anything you could not verify rather than filling the gap — an
unverified line in a briefing is worse than an absent one, because the next decision gets made on it.
