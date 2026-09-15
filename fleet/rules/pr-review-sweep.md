# PR review sweep — before you call a PR clean, and before you merge

**The rule (Commandment #3):** before you call a PR clean/merge-ready — and again in the same breath
as merging — sweep ALL channels, across EVERY author, against the LATEST commit. The #1 recurring
failure across every instance is a **partial or stale** sweep. Mechanize it: `.claude/bin/pr-sweep.sh <n>`.

## The 30-second happy path (this is most PRs — do these, in order)

1. **Gate green (repos with CI).** `npm run gate` passes locally; where the repo has a required `gate`
   check (the inner app repo), it's green at HEAD. The outer workspace repo has no CI — nothing to wait on.
2. **Commit-clean, then dispatch the pre-PR review** — *before* `gh pr create`, dispatch the
   `adversarial-review` class (§1). A diverse-family reviewer reads your diff, find-only — round 1 of the review LOOP (§1b). Later rounds
   run on the OPEN PR whenever §1b.2 fires: for inner-repo app code after every fix round that changes a
   non-exempt path; in EVERY repo (carve-out, heddle, workspace included) after a round reporting ≥1 high
   or ≥2 med — until converged.
3. **Triage.** Spot-verify ≥1 finding, fix the real ones, `record_review_outcome` (§1).
4. **Open the PR** with `Fixes SPI-n`, post the review receipt as its first comment, `.claude/bin/pr-own.sh claim <n>`.
5. **Push once per round**, not per commit (§4).
6. **Sweep, then merge-or-escalate.** `.claude/bin/pr-sweep.sh <n>` clean on two sweeps ≥15 min apart →
   self-merge per `spi-self-merge.md` (once in force) if it's not a retained class, else hand to Maya/R.

**Most reads end here.** The sections below are reference detail for when something's weird.

---

## §1 Pre-PR adversarial review

Before `gh pr create`, dispatch ONE diverse-family reviewer:
`dispatch_worker(task_class:"adversarial-review", author_provider:"claude", agent:"<letter>", cwd:"<your worktree>", diff_base:"origin/main")` — **with NO explicit `skills:`** (the class default resolves `adversarial-review` to the SPI shadow pack = six SPI lenses). The reviewer is read-only/find-only; you apply the fixes.
- **Escalation valve:** fan to a SECOND author-excluded family when the diff touches security/RLS/migrations/auth, DB schema, or exceeds ~400 changed lines. Otherwise one reviewer.
- **Triage:** spot-verify at least one cited `file:line` before accepting the set; fix the real ones; `record_review_outcome(dispatch_id, findings_total, findings_accepted)`.
- **Receipt on the PR** (pr-sweep will assert it once SPI-899 lands — until then, posting it is on you): `<!-- pre-pr-review: reviewer=<family>/<model> dispatch=<id> round=<N> findings=<H+M+L> high=<H> med=<M> low=<L> accepted=<A> outcome=<clean|fixed|flagged> head=<sha> base=<merge-base sha> -->` (`findings` is the sum — it is what `record_review_outcome(findings_total)` takes).
- **Refused / timed-out:** retry once on the pool's next family; still failing → open with `outcome=flagged` + a Linear note (don't block indefinitely). `outcome=flagged` is NOT convergence (§1b.4): the PR may open, it may not self-merge.

Full contract + lens definitions: `_vault/architecture/spi-895-adversarial-review-design.md` §8.

### §1b The review LOOP — iterate to convergence (Maya, firsthand 2026-08-23)

One pre-PR round is the floor, not the ceiling. **Round 1 runs before `gh pr create`** (§1). **Every later
round runs on the OPEN PR**, reviewing the PR's authored diff as it stands. The definitions below are
mechanical on purpose: if you find yourself arguing a PR out of a round, it needs the round.

1. **Every PR starts with one round. Whether the LOOP (items 2–6) engages depends on repo and paths:**
   - **Inner app repo, in-scope paths** (any changed path outside the carve-out): the loop is engaged from
     round 1 — both triggers in item 2 apply after every round. (Once the loop is engaged in ANY repo,
     "non-exempt path" in items 2 and 4 means every path except test files and carve-out paths.)
   - **Carve-out paths** (every changed path is under `docs/`, `_vault/`, `notes/`, `.claude/`, `.codex/`,
     `.gemini/`, `scripts/`, or is a `*.md` file), **heddle repos, and the workspace repo**: only trigger
     (b) applies at first — the loop engages when a round reports ≥1 high or ≥2 med; from then on (a)
     applies too.
   - **Governance rule files and the workspace enforcement chain** (`.claude/bin/pr-sweep.sh`,
     `.claude/bin/pr-own.sh`, the policy/deletion/usage hooks under `.claude/hooks/`): as the previous line, AND Maya/R word stays required regardless of
     convergence — the loop never lifts a retained class.
2. **Triggers — another round is REQUIRED when EITHER holds.** (a) the PR's AUTHORED diff —
   `git diff $(git merge-base <base-ref> HEAD)...HEAD`, where `<base-ref>` is the PR's actual base branch
   (`origin/main` unless stacked; the intended stack base before the PR exists) — changed in any
   non-exempt path since the latest receipt's `head=`/`base=` (mechanical check: `diff <(git diff <base>...<head> -- .) <(git diff
   $(git merge-base <base-ref> HEAD)...HEAD -- .)` using the receipt's shas; any hunk outside test or
   carve-out paths is a change). Changes confined to test files (`*.test.*`, `__tests__/`) or carve-out paths
   do not count; a comment-only edit inside a production file DOES count (a cheap round beats an
   argument); a forward-merge of `main` that leaves the authored diff byte-identical does not count —
   the same measurement the self-merge rules' non-overlap exception uses; a stacked PR retargeted after
   its base merged is re-measured the same way. The PR owner makes this call and records the changed
   paths in the PR. (b) the latest round reported ≥1 high or ≥2 med. Nits (wording, style) never trigger.
3. **A round is every reviewer dispatched for it.** The §1 escalation valve's second family is part of the
   same round: it consumes no loop slot and is not re-fanned on later rounds unless the INCREMENTAL fix diff since
   the last round meets the valve predicates on its own. A round's verdict is the SUM of its reviewers' VERDICT counts; post ONE receipt PER REVIEWER, each
   carrying the same `round=` (the schema has one `reviewer=`/`dispatch=` slot — never combine).
4. **Converged.** All of: the numerically latest round's receipt(s) carry `head=`/`base=` matching the
   current authored diff (no non-exempt change since); that round's summed counts are 0 high and <2 med;
   every finding from that round AND all prior rounds is fixed on HEAD or disputed with evidence in the
   PR. `outcome=flagged` (reviewer refused or timed out after the §1 retry) is NOT convergence: it counts as a
   round toward the cap and REQUIRES another round with the next family; a flagged round 3 goes to Maya. Severity vocabulary is the
   reviewer report's VERDICT counts (`high|med|low`; legacy `P1` = high, `P2` = med).
5. **Rotate the family; pass the route explicitly.** Each round uses a model family not yet used by a ROUND of
   this PR's loop (valve fan-out reviewers do not consume rotation slots) and never the author's family;
   if every author-eligible family has been used, reuse the least recently used one (`author_provider` stays honest: the family that wrote the
   latest fixes). Round 1 is the class's default route; for rounds ≥2 dispatch the `adversarial-review`
   class WITH an explicit `provider` + `model` from its pool, default order cursor/grok-4.6-high →
   codex/gpt-5.6-sol → gemini/gemini-3.1-pro-high (claude/opus only when the author is not Claude; a
   gemini reviewer takes no MCP — pass `mcp: []`, or the dispatch is refused). Name the previous rounds'
   findings in the dispatch `prompt` (the tool's required text field) so the reviewer reads them.
6. **Cap: three rounds.** Not converged after round 3 → `lin.sh needs-maya <ISSUE-ID> "QUESTION: merge
   PR #<n> with these residuals? OPTIONS: a) [REC] merge … b) round 4 with <family> … c) hold CONTEXT: PR
   link, receipts, residual high/med list"` (the three slots needs-maya.md requires); the PR neither loops
   further nor self-merges until her word.
7. **Receipts.** The PR owner posts a NEW comment for every round (one per reviewer when a round has
   several, same `round=`) — never an edit of an earlier one. `head=`/`base=` are the shas CAPTURED AT
   DISPATCH — the commit the reviewer actually read — never the post-fix HEAD (a fix push after a round
   is, by construction, a change since that receipt):
   `<!-- pre-pr-review: reviewer=<family>/<model> dispatch=<id> round=<N> findings=<H+M+L> high=<H>
   med=<M> low=<L> accepted=<A> outcome=<clean|fixed|flagged> head=<sha> base=<merge-base sha> -->`.
   Convergence and self-merge read `high=`/`med=`, reconciled to the reviewer's VERDICT line; pr-sweep
   asserts the latest round once SPI-899 lands (until then, posting it is on you).
8. **The double sweep (§2) is unchanged** — it proves completeness of bot/CI findings; the loop proves
   depth; a PR needs both.

Why (Maya): "what if something big is found on the second sweep … do we just trust that the fix is good
and nothing else is wrong and merge away?" Until this section: yes — bots and CI re-ran on every fix push,
but the independent model-family read was one-shot. Same-night evidence: a worker draft carried four
defects its own green tests could not see; round 1 found two more highs in the orchestrator's fixes; and
this section's own loop ran — five highs in round 1, two in round 2 — before it was ready for Maya.

## §2 The sweep — `pr-sweep.sh <n>`

Fetches all channels in one command and exits 0 only when mechanically clean:
(a) issue comments (det-tier scanner markers arrive here too) · (b) review **BODIES** (a non-empty body IS a finding — the single most-missed channel) · (c) inline threads (every unresolved one) · (d) code-scanning alerts · (e) checks at HEAD.
Enumerate **every** author the data returns — every bot present and future, every human, Maya (`mmayasaurus`) — never filter to the names you expect (named rosters in docs go stale; this rule exists because one did). A channel fetch that FAILS is a blocker to report, not a channel to skip. Address each: fix, or reply + resolve with a rationale.
**Disposition receipts:** after reading + addressing a non-empty review body, add `<!-- dispositioned: <login> <timestamp> -->` (login + timestamp as the sweep prints them) so later sweeps skip it.
**Ownership:** before you push / resolve / merge a PR you did NOT open this session, `.claude/bin/pr-own.sh check <n>` first — `OWNED:<other> (fresh)` → stand down.
Re-run the whole sweep after any push, and once more immediately before merging (bots land late).

## §3 Always-on bots

Steady-state high-signal set: **Cursor Bugbot** — runs **once per PR automatically** (Maya's trial setting, 2026-08-21); re-request on notable rounds by commenting **`bugbot run`** on the PR (`cursor review` also works). Its spend rides the active Cursor account's **API/on-demand meter** (baseline reviews included, then on-demand; settings live at cursor.com/automations/from-cursor/bugbot — Cursor moved them under Automations 2026-08); the GitHub association is switched between accounts **manually by Maya** when a meter runs low (HED-304 wires her a low-meter notification). Plus **qodo**, and the **deterministic tier** (semgrep diff-aware, gitleaks) which auto-runs per push. A rate-limit / usage-cap notice is **not** a finding — ignore those. But a *genuine* finding from ANY bot is still addressed per §2 until SPI-898 trims the extra bots: weighting Bugbot/qodo highest does NOT mean skipping a real finding another bot raised (the noise to ignore is the rate-limit/status chatter, not substantive findings).

**Copilot review — on-demand only (Maya, 2026-08-21; SPI-908).** Auto-request is OFF (the July $302 runaway). Request it deliberately with `gh pr edit <n> --add-reviewer @copilot` on PRs where it earns the spend — security/auth/RLS, schema changes, large or cross-cutting diffs, and the retained-class PRs Maya reviews — while included usage has headroom (a $10/mo overage cap is the wiggle-room backstop; don't spend it on routine PRs). Copilot is redundant on routine PRs (pre-PR adversarial review + qodo + on-demand Bugbot + det-tier cover them), so on-demand-on-notable-PRs is the rule, not "always."

## §4 Push once per round

Every push triggers a fresh bot round (rate-limit noise) AND resets the double-sweep clock — so batch
local commits and push when the chunk is genuinely review-ready, never push-as-you-go on an open PR.

## §5 Durable CI truths (when the checks look wrong)

- **No runs at HEAD? Check `mergeable` FIRST.** GitHub silently skips `pull_request` workflows on a
  CONFLICTING PR — pushes produce no runs and the rollup goes quiet (looks pending forever).
  `gh pr view <n> --json mergeable` → `CONFLICTING` means merge `origin/main` in (never force-push); runs resume.
- **A green scanner check is not a scan** — assert the scanned volume; "0 commits scanned" passing green is a failure, not a pass.
- **A red SECRETS check is resolved by re-running it to green, never by analysis** — even a correct
  "the red is infrastructural" reading is indistinguishable from a scan that never examined the content.
- **Fresh worktree → husky/prettier `ENOENT` on commit?** The worktree has no `node_modules`. Prepend
  the main checkout's `node_modules/.bin` to `PATH` for the commit — **never `--no-verify`** (a hook blocks it, correctly).

## §6 Watch, don't idle

Reviews + the gate arrive over 10–25 minutes. Don't block on a single "sleep then sweep" (a late
review lands right after it). Arm a **read-only** `Monitor` that emits one line per NEW unresolved
thread / fresh reviewer verdict / `gate` terminal state, and keep working; re-arm after each push. The
watcher is STRICTLY READ-ONLY — it never pushes, re-triggers, or merges (those are judgment calls).
The mechanized `.claude/bin/pr-watch.sh <n>` (SPI-910) IS that read-only pass — wrap it in the Monitor
(it emits one line per new thread / review body / `gate` terminal state, deduped). (macOS ships bash 3.2 — no assoc arrays / `mapfile`.)

## §7 Merge

Only Maya decides mergeable — OR **standing self-merge per `spi-self-merge.md`** (in force from
SPI-897's merge; ratified by Maya 2026-08-20). Merge-commit only (**never squash**, Commandment #1);
merge `origin/main` in only on CONFLICTING. The **retained classes** (security semantics, user-visible
feature/copy removals, cross-lane PRs, Supabase schema) always go to Maya.

---

*History — retired machinery:* the five Deep-Reviewer workflows, `gemini-review`, the `/deepreview` +
`gitar review` trigger ritual, and the self-hosted review-runner pool (+ its elastic Fly scaling) were
retired in the 2026-08 reset. What they were and why they went: `_vault/architecture/spinventory-reset-spec.md`.

See also: `spi-self-merge.md`, `pr-ownership.md`, Commandments #1 (never squash) / #3 (sweep) / #4 (stay current).
