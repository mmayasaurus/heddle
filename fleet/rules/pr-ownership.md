# PR ownership — one owner per PR, recorded ON the PR (not in memory)

**The failure this fixes:** agents *forget* their own open PRs and *collide* on each other's,
because ownership only ever lived in the agent's context/memory (dies at compaction) and in
ad-hoc docs (not on the PR). Every commit is `@mmayasaurus`, so a fresh or compacted agent
running `gh pr view` can't tell whose PR it is → it either abandons its own or piles onto
someone else's (the #1879 collision, 2026-07-06). Fix: ownership is a **durable marker on the
PR itself**, re-derived every time — so it survives compaction and is visible to every instance.

This reinforces Commandments **#4 (stay current, nothing stranded)** and **#5 (be mindful of
others)**, and is enforced through the sweep you already run for **#3**.

## Your identity = your worktree

One instance works one worktree (worktree-discipline rule), so **your owner id is your worktree's
name**: `basename` of the inner-repo toplevel with the `Rebuild-Project-Root.` prefix stripped —
e.g. `Rebuild-Project-Root.forms` → **`forms`**; the main working copy → **`main`**. Stable across
sessions and compaction (the worktree persists), unlike a session id. The helper computes it:
`.claude/bin/pr-own.sh whoami`.

## The claim marker

A claimed PR carries **both**:
- the label **`claimed`** (so `gh pr list --label claimed` finds all claimed PRs), and
- one pinned comment: `<!-- PR-OWNER: <worktree> | since: <iso8601> | heartbeat: <iso8601> -->`
  (the **authoritative** record — the label is just for listability).

The **heartbeat** is bumped every time the owner pushes to the PR. A claim is **stale** (treated as
abandoned, reclaimable) when its heartbeat is older than **`PR_OWN_STALE_HOURS` (default 4)** — a bit
longer than an active work session.

Use the helper for all of this — never hand-roll the comment/label/timestamp:
```
.claude/bin/pr-own.sh whoami            # print this worktree's owner id
.claude/bin/pr-own.sh claim <n>         # claim (or refresh heartbeat on) PR <n>
.claude/bin/pr-own.sh check <n>         # → YOURS | UNOWNED | STALE(reclaimable) | OWNED:<wt>(fresh→stand down)
.claude/bin/pr-own.sh mine              # list open PRs this worktree owns
.claude/bin/pr-own.sh release <n>       # hand off / abandon: drop label + post a release note
```

## The rules

1. **Open a PR → claim it** in the same step (`pr-own.sh claim <n>`). An unclaimed open PR is an
   orphan waiting to be forgotten or double-worked.
2. **Before you push, comment, resolve a thread, or merge a PR you did NOT open THIS session,
   `pr-own.sh check <n>` first** — fold this into the mandatory #3 sweep (you're already reading
   `gh pr view <n> --json comments`, where the `PR-OWNER` marker lives):
   - `YOURS` → proceed.
   - `UNOWNED` or `STALE` → claim it (`claim <n>`), then work it. For a stale reclaim the helper
     posts a short "reclaiming (stale Nh)" note so the prior owner sees it.
   - `OWNED:<other> (fresh)` → **STAND DOWN.** It's actively driven by another instance. Don't push,
     don't merge, don't `/deepreview`. If you have something useful, leave ONE comment and move on;
     if you think you should own it, coordinate with Maya first (she assigns).
3. **Heartbeat as you work** — `pr-own.sh claim <n>` on every push keeps the heartbeat fresh so
   others know it's alive. (The helper's `claim` is idempotent: first call claims, later calls just
   bump the heartbeat.)
4. **Land or release — never strand.** When Maya verifies and you merge, the PR closes and the claim
   retires with it. If you're stopping with it unfinished, either keep the heartbeat fresh (you'll
   resume) or `pr-own.sh release <n>` so another instance can adopt it cleanly. A claimed PR whose
   heartbeat you let go stale **is** the "forgotten PR" failure.
5. **Only Maya decides mergeable** (Commandment #3) — ownership just says *who drives it to green*,
   not that it may merge. Owning a PR never bypasses the sweep or Maya's verify.

## Non-force only (safety)

Even with ownership, **never force-push** (Commandment / Non-Negotiables). If two instances briefly
overlap a branch, non-force pushes make lost work impossible — the second push rejects and rebases.
That's the backstop under this whole protocol.

See also: `pr-review-sweep.md` (the #3 sweep this hooks into), `worktree-discipline.md`
(one-worktree-per-instance), memory `feedback-pr-sweep-all-channels-all-reviewers`, and the
`project-errorboundary-perscreen-recovery-followup` memory (the #1879 collision this prevents).
