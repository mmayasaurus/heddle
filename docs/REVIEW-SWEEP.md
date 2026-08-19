# PR review sweep — before anything is called clean or merged

A PR review sweep is the systematic audit of every feedback channel on a pull request against its latest commit. Reviews land across multiple distinct GitHub surfaces, and automated bots often post findings several minutes after a push. A pull request is declared "clean" only after every surface has been fully inspected at HEAD and all findings are either resolved or explicitly dispositioned. The primary failure mode in PR review is a partial or stale sweep where late-landing bot findings are missed. To guard against late-arriving automated reviews, the mandatory standard for merge readiness is two consecutive clean sweeps conducted at least 15 minutes apart at HEAD — the bots on these repos typically post between 1 and 20 minutes after a push, in no fixed order.

This document is shared by both heddle repos; the few repo-specific facts (the dashboard's by-design red `lint` job, the exact scanner set) are called out where they appear, everything else applies to both.

## The five channels

Review feedback arrives through five distinct channels on GitHub. Query every channel with `gh` (GitHub CLI); `jq` helps when you want to filter the JSON. Set the placeholders once and paste the commands as-is:

```shell
OWNER=mmayasaurus REPO=$(gh repo view --json name -q .name) N=<pr-number>
```

| Channel | Scope | Inspection command | Finding criteria |
|---|---|---|---|
| (a) Issue comments | Top-level PR conversation | `gh pr view $N --json comments` | Unaddressed feedback or requested changes in comment bodies. |
| (b) Review bodies | Formally submitted review header text | `gh pr view $N --json reviews` | An empty body is clean; a non-empty body must be READ regardless of review state — an `APPROVED` review can still carry a suggestion (several bots post findings in review bodies rather than comments). |
| (c) Inline review threads | Line-level code review discussions | GraphQL query below | Any thread where `isResolved` is `false`. |
| (d) Code-scanning alerts | SARIF security and lint findings | `gh api --paginate "repos/$OWNER/$REPO/code-scanning/alerts?pr=$N&state=open"` | Any open alert associated with the PR. (`pr` is a documented query parameter of this endpoint — GitHub's OpenAPI description, component `pr-alias`.) |
| (e) Checks at HEAD | CI workflow jobs and status rollups | `gh pr checks $N` (`--required` filters to the ruleset's required ones) and `gh pr view $N --json statusCheckRollup` | Every required check has SUCCEEDED (pending, skipped and cancelled do not count). A red NON-required check is still a finding unless its red is documented as by-design (e.g. the dashboard `lint` job until HED-14) — a red gitleaks or actionlint job is never "just non-required". |

> [!IMPORTANT]
> **A red SECRETS check is resolved by re-running it to green, never by analysis — even when the
> analysis is right.** If gitleaks is red because a scan step failed, a SARIF upload broke, or a
> provider had an incident, the fix is to re-run the job until it reports green at the current HEAD.
> Reasoning your way to "the red is infrastructural, the code is fine" may be entirely correct and is
> still not a pass: it is the one waiver nobody should be making, because it is indistinguishable
> from the case where the scan never examined the content. (2026-08-17, heddle#29 during a GitHub
> incident.) Every other channel can be dispositioned with a written rationale; this one is settled
> by a green run.

> [!NOTE]
> A "Code scanning results / <tool>" check in channel (e) is a summary of open alerts in channel (d); see [CI.md](CI.md). For a PR from a **fork**, the scanners still run but cannot upload SARIF (read-only token), so channel (d) stays empty — read the semgrep and gitleaks **job summaries / logs** in channel (e) instead; a fork PR is not clean until those say so. On heddle-dashboard, the `lint` job is red by design until HED-14 and is not required.

To inspect channel (c) inline review threads, run the following GraphQL query (100 threads per page; if `hasNextPage` is true, repeat with `after:"<endCursor>"` until it is false — a sweep that stops at page one is incomplete):

```shell
gh api graphql -f query='query($o:String!,$r:String!,$n:Int!){ repository(owner:$o,name:$r){ pullRequest(number:$n){ reviewThreads(first:100){ pageInfo{ hasNextPage endCursor } nodes{ id isResolved path line comments(first:1){ nodes{ author{login} body } } } } } } }' -F o="$OWNER" -F r="$REPO" -F n="$N"
```

## Trigger the reviewers that need it

Most review applications trigger automatically on push. However, specific tools require explicit manual triggers depending on repository state or workflow configuration:

- **CodeRabbit**: On repositories with fewer than 10 stars, CodeRabbit only reviews when triggered by commenting `@coderabbitai review` (or `@coderabbitai full review` for an initial full pass). Post this comment after opening the PR and after each substantive push.
- **Copilot code review**: Request-based review; re-request manually from the Reviewers panel in the GitHub UI.
- **Automatic reviewers** (roster as of 2026-08-15 — it changes; the checks tab and comment authors of any recent PR are the live list):
  - Qodo
  - Codacy
  - cubic
  - Gitar
  - Sourcery
  - Amazon Q
  - LlamaPReview
  - Corgea
  - CodeFactor
  - qlty
  - Hound
  - Macroscope
  - Semgrep AppSec check
  - GitHub code scanning
  - Dependabot

## What is NOT a finding (noise)

Certain operational automated outputs should be recognized as non-findings, documented during review, and bypassed:

- "rate limit exceeded" review bodies (e.g. codereviewbot.ai free tier limit of 2–3 reviews per 4 h per repo).
- cr-gpt failure messages stating "OPENAI_API_KEY not set".
- Gitar reports of "CI failed" when the underlying failure is the by-design `lint` job.
- Skipped **deterministic-review** runs for `pull_request: edited` events — that workflow sends title/body edits to a `noop` concurrency slot and skips them (see [CI.md](CI.md)). (The `gate` workflow does NOT skip edits; it names them separately — next line.)
- A `gate (edit — non-required …)` context showing cancelled or red — it is the non-required name a title/body-edit run publishes so it can never touch the required `gate` context (HED-142); a bot-edit storm at PR-open cancels those edit-slot runs, which is cosmetic. The REQUIRED `gate` is published only by commit-driven and base-retarget runs; read that one.

Read these notices to confirm their status, then move on without treating them as findings.

## Address every item

For every finding identified across all channels, either fix it or reply with clear technical rationale — and for inline threads (channel c) resolve the thread; issue comments (a) get a fix or a reply; review bodies (b) get a fix or a reply plus a disposition receipt. When disputing automated bot findings, always provide concrete evidence such as a green run link, a documentation quote, or a measured runtime value. **A negative claim is only as strong as its search boundary** — "this appears nowhere else", "nothing else calls it", "no other path reaches this" only counts if you state the scope you searched, and that scope is wide enough to be worth trusting. A grep over three plausible directories that silently excluded the repo-root config file produced a confidently wrong "the content survives nowhere" during the 2026-08-17 workspace triage; the content was in the root file. State the boundary, or don't make the claim. Never rubber-stamp and never resolve a thread silently.

Bots are frequently wrong. Three real examples from the first CI PRs on the two heddle repos (heddle#2, heddle-dashboard#5) demonstrate valid refutations:

1. A claim that `pnpm/setup` was the wrong action — refuted because it is the official pnpm ≥11 action and the CI job passed.
2. A claim that Dependabot `cooldown` is unsupported for `github-actions` — refuted directly by GitHub's documentation table.
3. A claim that `process.argv[1]` is `[eval]` under `node -e` — refuted by the CI log printing the expected value (`classes: 11 entries`).

And one example where the bot was right and the fix was adopted:

- A finding that `gitleaks-action` silently caps PR scans at 30 commits (API default `per_page`) — replaced with the Gitleaks CLI operating over exactly `base..head`.

## Disposition receipts

After reading and addressing a non-empty review body (channel b), post ONE comment on the PR containing a marker line per review so the next sweep does not re-flag it:

```html
<!-- dispositioned: <login> <submitted_at ISO timestamp> -->
```

Use the login as GitHub prints it (e.g. `codacy-production[bot]`) and the timestamp exactly as returned by the API. The receipt is keyed on author and submission timestamp, so a new review by the same author still flags. Known limit: a bot that EDITS an already-submitted review keeps its `submitted_at`, so the receipt still matches — Gitar maintains a living review this way; re-read living reviews each round rather than trusting the receipt. To list the pairs you need to receipt:

```shell
gh api --paginate "repos/$OWNER/$REPO/pulls/$N/reviews" --jq '.[] | select(.body != "") | "<!-- dispositioned: \(.user.login) \(.submitted_at) -->"'
```

Example comment:

```markdown
Reviewed and dispositioned automated feedback:
<!-- dispositioned: codacy-production[bot] 2026-08-15T14:30:00Z -->
```

## Push once per round, then re-sweep

Batch fixes for a round into one push (each push spawns reviewer runs — some incremental, some full, some none). After pushing:

1. Re-trigger the manual reviewers (e.g. comment `@coderabbitai review`).
2. Wait for the round to land.
3. Sweep again.

### Sweep clean checklist

- 0 unresolved inline review threads.
- Every non-empty review body fixed or documented with a disposition receipt.
- 0 open code-scanning alerts introduced by the PR (or each one dispositioned).
- Every required status check green at HEAD (`gate`).
- No unread or late-landing items.
- Sweep #2 completed ≥15 minutes after sweep #1, both against the SAME commit (`headRefOid`) — record the SHA with each sweep; any push resets the window.

## Gotchas that already bit us

- **No workflow runs at HEAD after a push?** Check `gh pr view $N --json mergeable,mergeStateStatus` first: GitHub silently skips `pull_request` workflows on a conflicting PR; fix by merging `origin/main` into the branch (never force-push).
- **A green scanner check is not proof a scan happened.** Read the job log for the scanned volume (our gitleaks step now fails closed on an empty scan; see [CI.md](CI.md)).
- **A skipped title/body-edit semgrep or gitleaks check at HEAD is a finding, not expected noise.** Those edits now echo the scanner's SHA-bound `*-verdict`; re-run Deterministic Review or push a commit if either edit-path scanner is skipped or lacks a real verdict.
- **Bots auto-resolve their own threads when the code changes.** The sweep still lists them; check `isResolved`, not memory.

## Standing rules from the maintainer

The authoritative wording lives in [CI.md](CI.md#standing-rules-maya-2026-08-15--apply-to-everyone-orchestrator-included) (no direct commits to `main`; as many revision rounds as it takes; behavioral tests, not toggle tests) — one source, not two.

## Merging

- Merge commits only, pinned to the commit you swept: `gh pr merge $N --merge --match-head-commit <swept-sha>` (a push landing between sweep #2 and the merge must not slip through unswept).
- Never squash, never force-push.
- Ensure the branch is **not conflicting** — `gh pr view $N --json mergeable` must read `MERGEABLE` (`UNKNOWN` only means GitHub is still computing; poll again). Merge the base repository's `main` into the branch **only** when it reads `CONFLICTING` — from a fork that means the base repo's remote, not the fork's `origin/main`. A branch that is merely **behind** merges as-is, however far behind: being behind is not a defect, and force-marching every PR forward on each `main` advance does not converge on a busy repo (each forward-merge is a new HEAD, restarting CI and the 15-minute sweep clock while `main` moves again). `mergeable` is the decision; `mergeStateStatus` (`BEHIND` / `UNSTABLE` / `CLEAN` / `BLOCKED`) is informational if you want to see *how* far off you are — it is not what the rule keys on. Full rationale, including the measured basis: `.claude/rules/pr-discipline.md` condition 5.
- PR description body carries `Fixes <ticket>`.
- Keep the branch after merging (branches are history).
- Who may merge is a maintainer policy outside this document.

## Fleet tooling

The maintainers' fleet automates channels (a)–(e) with a sweep script kept outside this repo. Contributors without it use the commands above — the procedure is the same.
