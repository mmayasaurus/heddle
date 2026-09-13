---
description: End a session cleanly — commit, push, truthful PR and tracker state, durable handoff.
---

# Closeout — leave nothing stranded, and nothing overstated

Run this before ending a session, before a long pause, and before any handoff. Its job is that the
next agent (or the next you, post-compaction) can resume from durable, VISIBLE state. Durable
artifacts are issue-tracker comments, pushed branches, and PR state — NOT a local session file (a
file nobody maintains is worse than none, because it still gets read). Push the truth where teammates
already look.

Execute in order. Do not skip a step because you believe it is empty — verify it is.

## 1. Nothing uncommitted, in any worktree you touched

- In your OWN worktree only: `git status --porcelain` AND `git stash list` (a stash leaves `status`
  clean while living only in your local repo).
- Commit real work. If it is not ready for its branch, that is what `wip/<agent>-<topic>` is for — a
  wip branch costs nothing and uncommitted work is the easiest thing to lose.
- A stash or change you do NOT recognize as this session's is not yours to commit — leave it and flag
  it to whoever owns the tree.
- Move scratch files OUT of the worktree; an untracked file is exactly what a force-clean takes.

## 2. Nothing unpushed

- Find local commits on no remote (works even with no upstream):
  `git log --branches --not --remotes --oneline`. Read it as a CHECKLIST, not a push list.
- Push only YOUR OWN such branches, with tracking: `git push -u origin <branch>`. Never force-push,
  never push local `main`.

## 3. Truthful PR state

For each PR you own (`gh pr list --author @me`; `.claude/rules/pr-ownership.md`), record in one line:
number, head sha, `gate` result at that head (`gh pr checks <n>`), unresolved-thread count, and the
SPECIFIC condition blocking merge (`gh pr view <n> --json mergeable` → CONFLICTING vs mergeable).
"In review" is not a state — "sweep due at HH:MM", "waiting on the operator for security semantics",
"CONFLICTING, needs main merged in" are. Release ownership of any PR you will not drive further.

## 4. Tracker reflects reality

- Issues you finished: resolve them with what landed + merge sha + what was NOT done.
- Issues you claimed but are not finishing: release the claim, or name the teammate taking it. A claim
  on an absent agent looks handled and strands the work.
- Anything you discovered but did not fix: file it before you forget — a finding that lives only in a
  transcript is lost at compaction.

## 5. Handoff, in one place each

- One line to your orchestrator: what landed with shas, what is in flight with its blocking condition,
  what you claimed next.
- For any in-flight ticket a teammate might pick up: a comment ON THE TICKET with the state and the
  next concrete step — not a chat message that scrolls away.

## 6. Verify, then report

Re-run `git status --porcelain`, `git stash list`, and the unpushed check. Assert clean; if you
cannot, say exactly what is dirty and why. Then report:

- **Landed** — with merge shas.
- **In flight** — with the blocking condition per item.
- **NOT done / not attempted** — explicitly, including anything you ran out of time for.
- **Tested vs merely written** — which claims are backed by a run you saw.
- **Known risks / unverified** — what could break that you did not check.

"Tests pass" is not "it works", and a green local gate is not a clean PR. Say which one you have.
