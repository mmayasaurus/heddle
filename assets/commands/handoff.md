---
description: Produce a durable handoff artifact on the tracker for one in-flight issue or PR.
---

# Handoff — hand off one in-flight item cleanly

Unlike closeout (whole-session hygiene), `/handoff` produces the durable handoff ARTIFACT for a
SINGLE in-flight issue or PR, so another agent (or future-you after a compaction) can pick it up with
zero context loss. Run it any time you set one item down. A handoff that lives only in a session
transcript is lost at compaction — push it where the next reader already looks.

## 1. Make the work durable FIRST

- Commit everything on the branch (a `wip/<agent>-<topic>` branch is fine if it is not ready for its
  real branch), then push it: `git push -u origin <branch>`. An unpushed branch is invisible and
  cannot be handed off.
- Confirm: `git status --porcelain` clean and the branch pushed.

## 2. Capture the exact state ON THE TICKET

On the target ticket in your tracker (discover it via `heddle projects`), post a comment — never a
chat message that scrolls away — with:

- the branch name, PR link (if any), and head sha (`git rev-parse HEAD`);
- what is DONE and verified vs written-but-UNVERIFIED;
- the SINGLE next concrete step;
- every blocking condition and its unblock trigger;
- any decision made and why;
- the rule stubs the next owner must follow (`.claude/rules/worktree-discipline.md`,
  `.claude/rules/pr-ownership.md`, `.claude/rules/pr-review-sweep.md`, `.claude/commands/heddle-gate.md`).

## 3. Point the next owner at live sources, not prose

- The exact command/tests to run to see current state (e.g. `.claude/commands/heddle-gate.md`).
- Where the PR's blocking condition lives: `gh pr view <n> --json mergeable`, `gh pr checks <n>`.

## 4. Assign or release

- If a specific teammate is taking it, name them on the ticket and send your orchestrator one line.
- Otherwise release (unclaim) the issue so it is not stranded on an absent agent.
