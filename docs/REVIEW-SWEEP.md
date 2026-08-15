# PR review sweep — before anything is called clean or merged

A PR review sweep is the systematic audit of every feedback channel on a pull request against its latest commit. Reviews land across multiple distinct GitHub surfaces, and automated bots often post findings several minutes after a push. A pull request is declared "clean" only after every surface has been fully inspected at HEAD and all findings are either resolved or explicitly dispositioned. The primary failure mode in PR review is a partial or stale sweep where late-landing bot findings are missed. To guard against late-arriving automated reviews, the mandatory standard for merge readiness is two consecutive clean sweeps conducted at least 15 minutes apart at HEAD.

## The five channels

Review feedback arrives through five distinct channels on GitHub. Every channel must be queried using `gh` (GitHub CLI) and `jq` for the target PR number `<n>`.

| Channel | Scope | Inspection command | Finding criteria |
|---|---|---|---|
| (a) Issue comments | Top-level PR conversation | `gh pr view <n> --json comments` | Unaddressed feedback or requested changes in comment bodies. |
| (b) Review bodies | Formally submitted review header text | `gh pr view <n> --json reviews` | An empty body is clean; a non-empty body is a finding (several bots post findings in review bodies rather than comments). |
| (c) Inline review threads | Line-level code review discussions | GraphQL query below | Any thread where `isResolved` is `false`. |
| (d) Code-scanning alerts | SARIF security and lint findings | `gh api "repos/<owner>/<repo>/code-scanning/alerts?pr=<n>&state=open"` | Any open alert associated with the PR. |
| (e) Checks at HEAD | CI workflow jobs and status rollups | `gh pr checks <n>` and `gh pr view <n> --json statusCheckRollup` | Any failing required check. |

> [!NOTE]
> A "Code scanning results / <tool>" check in channel (e) is a summary of open alerts in channel (d); see [CI.md](CI.md). On heddle-dashboard, the `lint` job is red by design until HED-14 and is not required.

To inspect channel (c) inline review threads, run the following GraphQL query:

```shell
gh api graphql -f query='query($o:String!,$r:String!,$n:Int!){ repository(owner:$o,name:$r){ pullRequest(number:$n){ reviewThreads(first:100){ nodes{ id isResolved path line comments(first:1){ nodes{ author{login} body } } } } } } }' -F o=<owner> -F r=<repo> -F n=<n>
```

## Trigger the reviewers that need it

Most review applications trigger automatically on push. However, specific tools require explicit manual triggers depending on repository state or workflow configuration:

- **CodeRabbit**: On repositories with fewer than 10 stars, CodeRabbit only reviews when triggered by commenting `@coderabbitai review` (or `@coderabbitai full review` for an initial full pass). Post this comment after opening the PR and after each substantive push.
- **Copilot code review**: Request-based review; re-request manually from the Reviewers panel in the GitHub UI.
- **Automatic reviewers**:
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
- Skipped workflow runs for `pull_request: edited` events (triggered when bots edit PR descriptions; see [CI.md](CI.md)).

Read these notices to confirm their status, then move on without treating them as findings.

## Address every item

For every finding identified across all channels, either fix it or reply with clear technical rationale and resolve the thread. When disputing automated bot findings, always provide concrete evidence such as a green run link, a documentation quote, or a measured runtime value. Never rubber-stamp and never resolve a thread silently.

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

Use the login as GitHub prints it (e.g. `codacy-production[bot]`) and the timestamp exactly as returned by the API. The receipt is keyed on author and timestamp, so a new review by the same author still flags.

Example comment:

```markdown
Reviewed and dispositioned automated feedback:
<!-- dispositioned: codacy-production[bot] 2026-08-15T14:30:00Z -->
```

## Push once per round, then re-sweep

Batch fixes for a round into one push (each push spawns a full reviewer round). After pushing:

1. Re-trigger the manual reviewers (e.g. comment `@coderabbitai review`).
2. Wait for the round to land.
3. Sweep again.

### Sweep clean checklist

- 0 unresolved inline review threads.
- Every non-empty review body fixed or documented with a disposition receipt.
- 0 open code-scanning alerts introduced by the PR (or each one dispositioned).
- Every required status check green at HEAD (`gate`).
- No unread or late-landing items.
- Sweep #2 completed ≥15 minutes after sweep #1 at HEAD with nothing new.

## Gotchas that already bit us

- **No workflow runs at HEAD after a push?** Check `gh pr view <n> --json mergeable,mergeStateStatus` first: GitHub silently skips `pull_request` workflows on a conflicting PR; fix by merging `origin/main` into the branch (never force-push).
- **A green scanner check is not proof a scan happened.** Read the job log for the scanned volume (our gitleaks step now fails closed on an empty scan; see [CI.md](CI.md)).
- **A skipped "noop" Deterministic Review run per push** is the `edited`-event guard operating normally, not a failure.
- **Bots auto-resolve their own threads when the code changes.** The sweep still lists them; check `isResolved`, not memory.

## Merging

- Merge commits only (`gh pr merge <n> --merge`).
- Never squash, never force-push.
- Ensure branch is up to date with `main` (merge `origin/main` into it if behind).
- PR description body carries `Fixes <ticket>`.
- Keep the branch after merging (branches are history).
- Who may merge is a maintainer policy outside this document.

## Fleet tooling

The maintainers' fleet automates channels (a)–(e) with a sweep script kept outside this repo. Contributors without it use the commands above — the procedure is the same.

