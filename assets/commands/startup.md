---
description: Orient your session from live git, issue-tracker, and GitHub state before making changes.
---

# Startup — orient before touching anything

Orient your session from live sources before reading or modifying any project files. There is
intentionally no hand-maintained "current state" file to read: such a file rots between the moment it
is written and the moment someone trusts it. Git, your issue tracker, and the code-host (GitHub) API
are live and cannot rot — they are the state.

Execute these steps in order and report as you go.

## 1. Who & where

- Confirm your agent identity: `heddle whoami`.
- Verify your working directory: `git rev-parse --show-toplevel`. It MUST resolve to your own
  worktree (e.g. `.worktrees/<agent>`) — never a main checkout or another agent's worktree. If it is
  wrong, stop and move to your own worktree before doing anything else
  (see `.claude/rules/worktree-discipline.md`).
- Inspect your local state: `git status --porcelain`, `git branch --show-current`, and
  `git stash list` (stashed work is invisible to `git status`). Commit or understand anything you
  find before you change it.

## 2. What is already yours

- Discover this project's team and issue tracker from the registry: `heddle projects`.
- Query your issue tracker (the one `heddle projects` reports) for every issue claimed by your agent
  identity. Each is a promise: drive it or release it.
- List the PRs you own: `gh pr list --author @me` (and see `.claude/rules/pr-ownership.md`). For each,
  get its REAL state, don't assume: `gh pr view <n> --json state,mergeable,headRefOid` plus its
  unresolved-review-thread count (`.claude/rules/pr-review-sweep.md`).

## 3. What moved while you were gone

- `git fetch origin`, then read what landed: `git log --oneline HEAD..origin/main` (read all of it).
- Did any RULE change? `git diff --name-only HEAD..origin/main -- docs/ .claude/rules/`. Anything
  listed, re-read before you act — a stale mental copy of a rule produces confidently wrong work.

## 4. Pick the next action

- If you have claimed work in flight, that is your next action — finish it before pulling anything new.
- If your queue is empty, claim the top unclaimed issue nearest your lane (e.g. `ABC-123`) from your
  tracker and start.

## Report

Produce a short briefing, not a narrative:

- **Identity & worktree** — who you are and the worktree you are in.
- **Claimed issues** — keys and state.
- **Owned PRs** — number, and the SINGLE condition actually blocking each merge.
- **What landed on `main`** — and any rule that changed since you last looked.
- **The single next action.**

State anything you could not verify rather than filling the gap — an unverified line in a briefing is
worse than an absent one, because the next decision gets made on it.
