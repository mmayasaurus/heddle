# Startup — orient before touching anything

Run this at the start of a heddle session (or after a compaction that lost your place). It reads
**live sources only**. There is deliberately no hand-maintained "current state" document to consult:
the audit that produced this command found Spinventory's `_vault/decisions/`, `_vault/sessions/` and
`.session/` all empty in practice (docs/SPINVENTORY-PARITY.md), so a status file is a thing that rots
between the moment you write it and the moment someone trusts it. Git, Linear, and the GitHub API
cannot rot — they are the state.

Execute in order and report as you go.

## 1. Who and where

1. Your fleet letter comes from the SessionStart primer; confirm the PR-ownership id agrees:
   `/Users/mayatobi/Developer/Spinventory-Rebuild-App/.claude/bin/pr-own.sh whoami`
2. `git rev-parse --show-toplevel` — must be `<repo>/.worktrees/<your-letter>` or
   `<repo>/.worktrees/<your-letter>-<lane>`. A main checkout or another agent's worktree is a STOP:
   commit anything uncommitted to a `wip/` branch, move to your own worktree (branch off fresh
   `origin/main`, register the memtrace overlay), then continue. See `.claude/rules/worktree-discipline.md`.
3. `git status --porcelain` and `git branch --show-current` — know what you are sitting on before you
   change it. Uncommitted work from a previous session gets committed to a `wip/` branch now, not later.

## 2. What is already yours

4. `LIN_TEAM=HED /Users/mayatobi/Developer/Spinventory-Rebuild-App/.claude/bin/lin.sh --agent <letter> mine`
   — every issue you have claimed. Each one is a promise: drive it or release it.
5. `pr-own.sh mine` — every PR this worktree owns. For each, get its real state rather than assuming:
   `gh pr view <n> --json state,mergeable,headRefOid` and the unresolved-thread count
   (GraphQL query in docs/REVIEW-SWEEP.md channel (c)).
6. For any PR that looks finished, check the two things that actually block a merge: `gate` green at the
   CURRENT head (`gh pr checks <n>`), and whether `mergeable` says `CONFLICTING` — a branch that is
   merely behind merges as-is (`.claude/rules/pr-discipline.md` condition 5).

## 3. What moved while you were gone

7. `git fetch origin main && git log --oneline HEAD..origin/main | head -20` — with several agents
   active, `main` moves fast. Read what landed; it is the most common source of a surprise.
8. Skim `docs/REVIEW-SWEEP.md` and `docs/CI.md` if either changed in that range. These two carry the
   rules that change most often, and a stale mental copy of them produces confidently wrong work.

## 4. Pick the next action

9. If you have claimed work in flight, that is your next action — finish it before pulling anything new.
10. If your queue is empty: `lin.sh list`, claim the top unclaimed issue nearest your lane, and start.
    Do not wait for tasking (standing directive, Maya 2026-08-17). Announce the claim in one line so the
    board stays legible.

## Report

Produce a short briefing, not a narrative: identity + worktree, claimed issues, owned PRs with their
real blocking condition, what landed on `main` since you last looked, and **the single next action**.
State anything you could not verify rather than filling the gap — an unverified line in a briefing is
worse than an absent one, because the next decision gets made on it.
