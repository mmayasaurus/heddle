# CI & review on this repo

Everything runs on GitHub-hosted runners (the repo is public, so minutes are free) and is defined
in `.github/`. Ported from the Spinventory fleet's CI (deterministic tier + gate) and simplified for
a public repo; the reviewer-fleet enablement items that need Maya's account (branch ruleset, app
installs) are tracked in Linear **HED-13**.

## What runs

| Workflow | Trigger | Jobs | Posture |
|---|---|---|---|
| `gate.yml` | push `main`, **PRs to any base** (stacked PRs included) incl. base retargets + title/body edits, manual | **`build`** (`npm ci` → `npm run typecheck` src+test → `npm test` vitest → `npm run build` → smoke the built CLI, `classes`/`packs --json` non-empty) → **`gate`** aggregates it and records a `gate-verdict` marker; a title/body edit makes `gate` **echo** that marker instead of rebuilding | the **required** merge check (job name `gate` is the ruleset's context string — don't rename); edit-safe via the verdict echo (HED-142 — see below) |
| `deterministic-review.yml` | PRs (incl. drafts for gitleaks, base retargets, and title/body edits), push `main` | **`semgrep-scan` → `semgrep`** (`p/typescript` + `p/nodejs`, diff-aware vs the PR base, full on `main`, SARIF → code scanning) · **`gitleaks-scan` → `gitleaks`** (official CLI over exactly `base.sha..head.sha`). The plain-runner public jobs aggregate real scan results into SHA-bound `*-verdict` markers; title/body edits echo those markers instead of rescanning or skipping. gitleaks' shell lives in `.github/scripts/gitleaks-range-scan.sh` (HED-113) so the fixture matrix can exercise it directly. | semgrep report-only · gitleaks red on a hit (not required); edit-safe via real verdict echoes (HED-131) |
| `actions-hygiene.yml` | PRs / `main` pushes touching `.github/**` | **actionlint** · **zizmor** (SARIF → code scanning) | actionlint red on findings · zizmor report (same-repo) / red (forks) |
| `.github/dependabot.yml` | weekly | grouped bumps of the hash-pinned actions, 7-day cooldown | — |

Findings surface as **code-scanning alerts** ("Code scanning results / <tool>" checks + the Security
tab), job summaries, and the job log — plus whatever the AI reviewer apps post.

## Rules baked into the workflows (don't undo them casually)

- **A green scanner check is not a scan — assert the scanned volume.** The gitleaks step computes
  `git rev-list --count --no-merges base..head` itself, runs gitleaks with `--no-color` so its log is
  exactly zerolog's `<time> <LEVEL> <msg>`, and reds the job when any line's LEVEL is `ERR`/`FTL`
  or the `INF N commits scanned` count is below the expected number (a finding whose path merely
  contains "ERR" cannot trip it). Origin: in a `container:` job the
  workspace is owned by the runner uid and `actions/checkout` writes its `safe.directory` entry to a
  temporary HOME, so gitleaks' internal `git log` failed with "dubious ownership" — and gitleaks
  still exited 0 with "0 commits scanned … no leaks found". Two rounds of a PR were green with an
  empty scan before a human read the log. Every container-job script therefore starts with
  `git config --global --add safe.directory "$GITHUB_WORKSPACE"`, and any scanner added later must
  ship with a volume assertion from day one. The semgrep step likewise checks scanned volume (HED-70)
  via `--json-output=semgrep.json` + `paths.scanned`: a full-`main` scan covering 0 targets, or an
  absent/unparseable `paths.scanned` (schema drift), fails closed. On a PR, semgrep already aborts
  (reds) when its git breaks, and emits no `paths.skipped` to distinguish a legitimate skip (nested
  exclude / `.semgrepignore` / deletion) from a real miss — so a 0-target PR scan with in-language
  changes WARNS (surfaced for review) rather than false-redding a valid PR. Still pending under HED-70:
  the same assertion for zizmor/actionlint (HED-252), and extracting the semgrep step to a
  fixture-testable script as gitleaks did in HED-113 (HED-253).
- **Suppressions are PR-controlled, so the scan never trusts the PR's copy.** gitleaks scans with
  the *base branch's* `.gitleaks.toml`/`.gitleaksignore` (or a default-rules stub), ignores inline
  `gitleaks:allow`, and moves the PR's working-tree copies aside (gitleaks merges
  `<source>/.gitleaksignore` unconditionally). semgrep swaps every `.semgrepignore` for the base
  branch's copy via a local commit (`--baseline-commit` refuses a dirty tree) and passes
  `--disable-nosem`. Consequence: a new suppression must land on `main` in its own reviewed PR
  before another PR can benefit from it.
- **Container jobs are POSIX `sh`.** Inside `container:` the runner defaults to `sh -e`, not bash —
  a bash array in the first run of the semgrep step failed with `syntax error: unexpected "("`.
- **Everything is pinned.** Actions by full SHA with a `# vX.Y.Z` comment (zizmor's default
  `unpinned-uses` policy; Dependabot bumps them). Container images and `docker://` uses are
  tag+digest pinned and are **manual bumps** — Dependabot does not track them (each carries a
  `MANUAL BUMP` note). Runners are pinned to an Ubuntu series, never `-latest`.
- **Least privilege.** Workflow-level `permissions: {}`, per-job grants with a comment on each,
  `persist-credentials: false` on every checkout, no PR-controlled string expanded into a `run:`.
  The container scanner jobs check out PR code with only `contents: read` + `security-events: write`;
  only the separate plain-runner aggregator jobs hold `checks: write`, and they never check out PR code.
- **Fork PRs get scanned too**; only the SARIF-upload steps (write token) are same-repo-guarded.
- `pull_request: edited` uses the same safe distinction in **`gate.yml`** and
  **`deterministic-review.yml`**. A base retarget re-runs real work because the merge result,
  semgrep baseline, and gitleaks range moved. A title/body edit skips only the leaf work; the public
  `gate`, `semgrep`, and `gitleaks` jobs publish a **real echoed verdict** from the head SHA's marker.
  The edit concurrency slot has cancellation disabled, so an echo cannot cancel an in-flight build or
  scan. A skipped public scanner check is not an accepted noop.

## GitHub required-status-check semantics — observed (HED-142)

GitHub resolves a required status check from the newest check-run of the required name **in the newest
check-suite** on the head commit — suite-creation order, not run-completion order (rows 1, 6, 7). Rows
1–6 are observed `mergeable_state` from a real PR in the sandbox `mmayasaurus/heddle-gate-sandbox` (a
throwaway repo whose ruleset required exactly one check named `gate`, `strict:false`); row 7 is a live
observation from dashboard#45 — not doc-inference. Legend: `blocked` = a required check is unsatisfied
(cannot merge), `unstable` = mergeable but a non-required check is failing/pending, `clean` =
mergeable and all green.

| # | Scenario | Latest `gate` check-runs (oldest→newest) | `mergeable_state` | What it proves |
|---|---|---|---|---|
| 1 | baseline; commit run then bot-edit churn | success, cancelled, success, success | `unstable` | Latest `gate` success ⇒ mergeable. A mid-sequence CANCELLED run did not stick because a later same-SHA success superseded it (a later same-SHA **suite** supersedes for resolution — see row 7). Unstable only because non-required bot checks were pending. |
| 2 | gate job `if:false` on every run | skipped, skipped, skipped | `unstable` | A required check that is only ever `skipped` is treated as satisfied ⇒ skip does not block. |
| 3 | red commit, then a later `skipped` run (masking test) | failure, failure, cancelled, failure, skipped | `clean` | A `skipped` run SUPERSEDES prior failures ⇒ skip MASKS a real red. Unsafe. |
| 4 | dynamic job name — `gate` on commit, `gate-edit` on a body edit | `gate`=success, then `gate-edit`=success (×N) | `blocked` | The latest check-suite produced `gate-edit`, not `gate`, so the required `gate` context reads unsatisfied ⇒ BLOCKED, even though an earlier suite delivered `gate` green. |
| 5 | verdict-echo — green commit, then a title/body edit storm | `gate`=success (commit), then `gate`=success (×N echo runs) | `clean` | Every edit run publishes the STATIC `gate` context (never `gate-edit`), so the latest suite always satisfies the requirement ⇒ stays mergeable through edits. Solves row 4. |
| 6 | verdict-echo anti-mask — red commit, then an edit that REMOVES the failing marker from the title | `gate`=failure (commit) + a `gate-verdict`=failure marker, then `gate`=failure (×N echo, incl. after the title no longer signals failure) | `blocked` | The echo re-emits the SHA-bound `gate-verdict` rather than recomputing from the current title, so a red STAYS red across edits ⇒ does NOT mask (the exact hole row 3's skip left open). |
| 7 | verdict-echo marker race on a SLOW build — commit run still building when bot edits fire (dashboard#45, live) | commit `gate`=success in the OLDEST suite; edit-echoes that gave up waiting for the marker = failure in NEWER suites | `blocked` | GitHub reads the required context from the newest SUITE, so the newer fail-closed echoes blocked the PR even though the commit success completed later — and `gh pr checks`, which uses the newest RUN, showed `pass` (the divergence is the tell; `mergeable_state` is the authority). **Fixed** by making the echo WAIT while the build is in flight — bound by an *invariant* (the `gate` job's timeout exceeds the longest leaf timeout), never an elapsed-time ceiling — so it never lands a premature red in a newer suite; two fixed timeouts (150 s, then ~20 min) were each falsified live here before the invariant. Live-only: the sandbox can't show it — instant builds keep suite-order and run-order aligned. |

These force three constraints on any edit-safe gate: every run must publish the static required context
`gate` [row 4 — omitting it blocks]; an edit run must never publish a passing or `skipped` `gate` that
misrepresents a real red [row 3 — skip masks]; and an edit run's `gate` must not be turned red by
cancellation (a cancelled required check reds the PR until a later suite supersedes — dashboard#41). The
verdict echo below is the shape that satisfies all three, validated by rows 5–6, with the slow-build
timing corner (row 7) fixed by the pending-wait.

*Sandbox vs live:* the sandbox validates the **semantics** (which conclusion supersedes which); only a
live PR validates the **timing** — suite-creation order versus run-completion order — because the
sandbox's instant builds keep the two aligned. Row 7 is a live-only finding.

## The gate survives PR edits: the verdict echo (HED-142)

Reviewer bots edit PR bodies constantly, and each edit fires a `pull_request: edited` check-suite. The
matrix above rules out the two shortcuts — skipping an edit run **masks** a red (row 3); renaming the
edit run's job **blocks** the PR because the latest suite no longer carries `gate` (row 4). So every
run, commit or edit, must publish a `gate` conclusion equal to the real verdict for the head commit.
`gate.yml` does that with a **verdict echo**:

- **Commit / retarget / push** runs do the real work — the leaf jobs (`build` in core; `web` + `rust` +
  `rust-test` in the dashboard), each guarded to commit-events with an `if:`. The `gate` job takes their
  aggregate conclusion, records it as a **non-required `gate-verdict` marker check-run on the head SHA**,
  and exits with it. `gate` is the real verdict.
- **Title/body-edit** runs skip the leaf jobs (no cold rebuild) and the `gate` job **echoes**: it reads
  the head SHA's latest `gate-verdict` and exits with exactly that conclusion. An edit can only *repeat*
  the verdict the commit already earned — green stays green, red stays red — so it never masks (row 6)
  and always publishes the static `gate` context (row 5).

Two mechanisms keep it honest:

- **Discriminator `github.event.changes.base.ref.from`** — populated on a base **retarget** (which must
  re-run the real gate against the new base), empty/absent on a title/body edit (which echoes). GitHub
  coerces the absent value so `!= ''` is *false* for a plain edit; verified in the sandbox, and both
  `gate.yml`s derive `IS_EDIT` from the same expression.
- **Two concurrency slots.** Commit-driven events share a `run` slot with `cancel-in-progress: true` (a
  newer commit supersedes the stale run). Title/body edits use an `edit` slot with
  `cancel-in-progress: false` — echoes are ~5 s and are never cancelled, so a cancelled edit run can
  never red the required context (the failure measured on dashboard#41).

The `gate-verdict` marker is deliberately **not** required — requiring it would recreate the row-4 block
(it exists only on commit runs). Do not add it to the ruleset.

### Scanner verdict echoes (HED-131)

`deterministic-review.yml` applies the same proven build/aggregator shape independently to semgrep and
gitleaks. On commit-driven events, the containerized `<scanner>-scan` leaf performs the unchanged real
scan and SARIF uploads. A separate plain `ubuntu-24.04` `<scanner>` job reads the leaf result, publishes
`<scanner>-verdict` on the head SHA best-effort, and exits with the real result. The leaf never holds
`checks: write`; the aggregator never checks out or executes PR code.

On a title/body edit, the leaf is skipped but the public `semgrep` / `gitleaks` job is not: it reads the
latest SHA-bound marker with `gh` + `jq` and exits 0 **only** for a positively parsed `success`. A missing,
unparseable, or non-success marker fails closed. If the marker has not appeared because the matching
`semgrep scan…` or `gitleaks scan…` leaf is still in flight, the echo stays pending and describes that
state in its job summary. It fails closed only after the leaf is verifiably gone for the sustained dry
window. Each aggregator's timeout exceeds its leaf's timeout, preserving the same wait invariant as
`gate.yml`. Scanner commit runs use the cancellable `scan` concurrency slot; title/body echoes use the
non-cancelling `noop` slot.

Residuals, by design:

- **Marker race.** An edit that fires before the commit run has published its marker finds none. The
  echo does **not** fail closed on a timer — a premature red would land in a check-suite *newer* than
  the commit run's own gate, and since GitHub resolves the required check from the newest suite, it
  would block the PR until another edit superseded it (matrix row 7). Instead the echo stays
  **pending**, polling for the marker *for as long as a commit-path job for the SHA is in flight*, and
  self-describing that pending state in its job summary. Fail-closed is reached only when the build is
  verifiably gone (no leaf in flight) with still no FRESH marker for a sustained dry window, or when
  the loop exhausts its belt — either way the post-loop guard has recorded no verdict and reds. The
  wait bound is an **invariant, not a constant**, sized by two rules: the loop's sleep-sum exceeds the
  longest leaf timeout (core ≈24m50s > 15; dashboard ≈48m50s > 45) so the echo can't run out of polls
  while a leaf legitimately runs, and the job `timeout-minutes` exceeds that sleep-sum plus an API
  allowance (core 30; dashboard 55) so a stuck echo fails closed cleanly via the loop, not as a
  `timed_out` red. (A leaf that sits *queued* far past the belt is the residual edge — it reds, and a
  re-run clears it; safe, because the direction is fail-closed.) Two earlier *fixed* timeouts (150 s,
  then a ~20 min ceiling) were each falsified live
  on dashboard#45 by a build that outran them; the invariant closes the class. A pending required check
  correctly blocks merge *while the build runs*, then resolves to the real verdict; it fails closed only
  if the marker never appears (commit run cancelled or never ran), with a self-describing remedy (re-run
  `gate`, or push a commit).
- **Reopen.** `reopened` is a commit-path event, so it re-runs the real gate and refreshes the marker
  for the (unchanged) head SHA; verdicts are SHA-bound, so reopen carries no stale-verdict hazard in the
  common case — which is also why close/reopen reliably forces a fresh verdict after a runner-side
  outage. Narrow residual: in the few seconds between a re-run being triggered and its leaves appearing
  in the check-runs API, the edit echo has no newer leaf to weigh the prior marker against, so it can
  read that marker as fresh — a false-GREEN needing a same-SHA re-run whose result FLIPS *and* an edit
  firing inside that window (the triple-coincidence rarity of the class the freshness filter closes); it
  self-corrects the instant the new leaf is visible. Fully closing it would need check-suite inspection.
  The same generation-ambiguity has a second-precision face: `started_at` is 1-second resolution and a
  marker is not tied to a workflow generation, so an old success marker sharing a second with a newer
  failing leaf's start satisfies the `>=` check — and the boundary cannot tighten to `>`, since a marker
  and its OWN leaf legitimately share a second. Tracked in **HED-203** (tie freshness to the check-suite
  generation rather than `started_at` ordering).
- **Fork PRs.** On a fork-head PR `GITHUB_TOKEN` is read-only regardless of `permissions:`, so the
  marker POST 403s. The commit path still reports the real verdict (the POST is best-effort and only
  warns); only later *edit* runs on a fork degrade — and they **fail closed, never mask**. The fleet
  uses same-repo branches, where the marker always publishes.
- **Echo read hardening (HED-182).** The edit echo reads the SHA's check-runs with `gh api --paginate
  --slurp` and flattens every page (`[.[].check_runs[]]`): the list is returned *across suites*, so a
  heavily-reviewed SHA (each edit echo adds its own `gate` run — 4 were live on heddle#57) really does
  span pages, and a single-page read would miss the marker. A failed read leaves liveness *unknown* and
  retries rather than coercing to an empty `{}` (which reds the required gate on one API blip under
  `set -eu`). The marker is accepted only when it is **fresher than the newest EXECUTED (non-skipped)
  commit-path leaf** (`marker.started_at >= max` over leaves whose `conclusion != "skipped"`, in jq)
  AND no leaf is in flight — so a prior same-SHA run's stale marker is never echoed into a newer suite
  (the false-GREEN a reopen / re-run would otherwise open). The `!= "skipped"` guard is load-bearing: a
  title/body edit's OWN leaves are `if:`-false and publish `skipped` check-runs whose `started_at` is
  the edit run's (newer) time — counting them would read every marker as stale and RED the gate on every
  bot edit (caught live in review). Exit 0 is reachable **only** through that accept path (a `VERDICT`
  the loop sets there and nowhere else), so neither loop exhaustion nor a retained value can green the gate.
  `deterministic-review.yml`'s scanner echoes carry the same hardening (HED-193), and additionally read
  with **`?filter=all`** so a queued / in-progress duplicate that the default `filter=latest` omits can
  never hide an in-flight scan from INFLIGHT (proven on heddle#61: `filter=latest` dropped a *queued*
  `semgrep-cloud-platform/scan` and an *in-progress* Codacy run — 33 rows vs 35 under `filter=all`).
  Monotone-safe: a superset of runs can only raise INFLIGHT (the fail-closed direction) and cannot make
  `max(started_at)` fall or `sort_by|last` pick an older marker. The same belt for gate.yml's echo is
  tracked in **HED-202**.

## Gate wedge recovery — a hung hosted runner (runbook, HED-206)

The required `gate` runs on GitHub-**hosted** runners (`ubuntu-24.04`). Hosted runners *can* hang
mid-job — not only self-hosted ones — leaving the `build` leaf stuck `in_progress` and the required
`gate` context pending. This is the operational counterpart to the verdict-echo section above: what to
run when a wedge is live. First hit was on the dashboard (2026-08-19, HED-206), whose `gate` shares
this repo's marker/echo architecture; the cancel-poisons-the-marker trap below bit heddle#66 live.

*Recurrence-watch scope (HED-206 has no written spec):* a documented detection procedure plus a
live-tested query — **no daemon/watcher**, because the belt self-clears and there has been a single
incident. The "if it recurs" clause at the end names the upgrade path.

> Throughout the `gh` commands below, replace every `<…>` placeholder with the real value (`<id>` = a
> run id, `<n>` = a PR number, `<branch>` = a branch name) — the angle brackets are literal here, not
> shell redirection, so a verbatim paste will fail.

**First: most wedges self-*terminate* — don't touch them early.** The `build` leaf carries
`timeout-minutes: 15` and the `gate` job carries `timeout-minutes: 30` (by the invariant that it
exceeds the leaf plus the echo's polling/API budget). So a hung run **ends within the belt** rather
than hanging for GitHub's 6-hour default — but self-terminate is not self-heal: a `build` killed by
its own timeout publishes a **red** verdict, so the required `gate` still needs a re-trigger (below) to
go green. **Act only once the required `gate` has been pending past the point any single job could
still be running (~30 min — `build` is 15, the gate job 30).**

**Recurrence watch — how to spot one.** The tell is a required `gate` pending well past the ceiling
with the `build` run stuck `in_progress`. A `runner-scale.sh status` reading of "many online / 0 busy"
is a **red herring** for a *hosted*-runner hang. Surface candidates to inspect (query live-verified
2026-08-21; empty = nothing to inspect). Treat it as a **first-pass filter, not a verdict** — it ages
each run's total wall-clock (`createdAt` includes any queue wait), so a long-but-healthy run can show
up; confirm every hit with the `…/jobs` call below before acting:

```shell
gh run list --repo mmayasaurus/heddle --workflow gate.yml --status in_progress --limit 100 \
  --json databaseId,createdAt,headBranch,event,url \
  --jq '.[] | select(((now-(.createdAt|fromdate))/60) > 30)
             | {id:.databaseId, age_min:(((now-(.createdAt|fromdate))/60)|floor),
                branch:.headBranch, event:.event, url:.url}'   # >30 min: past any job's own timeout (build 15, gate 30)
```

`--limit 100` is load-bearing: `gh run list` fetches **newest-first, default 20**, and the jq age
filter runs *after* the fetch — a small limit can page right past an old wedged run and print nothing
(a false "healthy"). Then confirm the specific run:

```shell
gh api repos/mmayasaurus/heddle/actions/runs/<id>/jobs \
  --jq '.jobs[] | {name, status, started_at, runner_name, labels}'
```

A job `in_progress` with `started_at` well past its timeout is genuinely stuck (`runner_name` /
`labels` confirm hosted vs self-hosted); a job still running *inside* its timeout is not a wedge —
leave it.

**Kill a genuinely-hung run — force-cancel, never plain cancel:**

```shell
gh api -X POST repos/mmayasaurus/heddle/actions/runs/<id>/force-cancel
```

`force-cancel` is GitHub's documented last-resort endpoint (it bypasses `always()`); plain `gh run
cancel` does **not** clear a truly-hung run.

**⚠️ DANGER — a plain cancel poisons the verdict marker.** `gh run cancel` is **run-scoped** — it
cancels the run's `build` check-run. The `gate` job's `needs: [build]` (`if: always()`) then
aggregates that `cancelled` need as non-success → publishes `gate-verdict = FAILURE` → the edit echo
faithfully **repeats** that false failure, so the PR looks code-broken when it is only infra (this bit
heddle#66). With a single `gate` need here, cancelling `build` always poisons the marker — use
`force-cancel`, which bypasses the aggregator entirely.

**Then unblock the PR — force-cancel alone does NOT.** Because `force-cancel` bypasses `always()`, the
`gate` job never runs, so no fresh `gate-verdict` is written and the required `gate` for that head SHA
stays cancelled/absent → still blocking. Re-trigger a **commit-path** run to publish a fresh verdict
(HEAD is unchanged — verdicts are SHA-bound, so any double-sweep merge-pin stays valid):

```shell
gh pr close <n> --repo mmayasaurus/heddle && \
  gh pr reopen <n> --repo mmayasaurus/heddle
```

`reopened` is a commit-path event (in `gate.yml` `types:`), so it re-runs the real `build` and
republishes the marker with the **true** verdict for that SHA — green if the code is actually green;
infra recovery on a genuinely-red SHA correctly stays red. If `reopen` fails (auth/network) the PR is
left **closed** — check `gh pr view <n> --repo mmayasaurus/heddle --json state` and reopen manually. Confirm `headRefOid` is
unchanged afterward.

Break-glass alternative (no PR churn): `gh workflow run gate.yml --repo mmayasaurus/heddle --ref <branch>` (`workflow_dispatch`,
also commit-path). **Force-cancel the hung run first** — a dispatch run uses the ref-keyed concurrency
group (`gate-<ref>-run`), not the hung run's PR-number group, so it does not displace the hung run,
which could later `always()`-publish `FAILURE` over your fresh marker. Do **not** reach for `gh run
rerun` reflexively: it replays a run's *original* event, so it only helps on a **commit-path** run
(`push` / `opened` / `synchronize` / `reopened` / `workflow_dispatch`) — rerunning an *edit* run just
re-echoes the existing (bad) marker. Close/reopen is unambiguously commit-path, so prefer it.

**After recovery** you still owe the full review sweep — two clean sweeps ≥15 min apart at the
now-green HEAD (see below).

**If this recurs** (beyond the single 2026-08-19 incident), extract the detection query above into a
committed, fixture-testable script and file a follow-up ticket — a standing watcher is not justified
by one self-clearing incident.

## The review sweep (before anything is called clean)

Full procedure with the exact commands: [REVIEW-SWEEP.md](REVIEW-SWEEP.md). In short: a PR is clean only after **every channel** — issue comments, review bodies, inline threads,
code-scanning alerts, and the checks tab — has been read against the **latest** commit and every
item fixed or answered with rationale (dispute bots with evidence, never rubber-stamp). Some
reviewers are on-demand (Cursor Bugbot: comment `bugbot run` — never trigger or wait for a
removed bot; roster last purged 2026-08-21). The commands for every channel are in [REVIEW-SWEEP.md](REVIEW-SWEEP.md); the maintainers'
fleet automates the same sweep with a script kept outside this repo. Two clean sweeps ≥15 minutes
apart against the SAME commit are the bar (late-landing bots), and merges are merge commits — never squash,
never force.

### Standing rules (Maya, 2026-08-15 — apply to everyone, orchestrator included)

- **No direct commits to `main`.** Every change goes on a branch → PR → the full review sweep → merge.
- **As many revision rounds as it takes.** Every reviewer bot on both repos is there on purpose; every
  comment / review body / inline thread is addressed (fix, or reply+resolve with evidence) before merge.
  "Green" is not "clean" — clean means zero unaddressed items against HEAD after the double sweep.
- **Behavioral tests, not toggle tests.** A test that proves a switch flips is NOT a test that proves
  the switch DOES the thing ("does turning it on actually turn the function on, not just the toggle").
  Every PR's tests must assert the observable effect: state / persisted result / downstream behavior,
  not the UI or flag alone. Reviewers grade tests on this bar; superficial tests are a review finding to fix.
- **Two lessons already paid for:** a PR that has a merge conflict gets NO `pull_request` workflow runs
  (GitHub skips them silently) — check `gh pr view <n> --json mergeable` before assuming CI is slow; and
  a green scanner check is not proof a scan happened — assert the scanned volume (see the rules above).

## Deliberately NOT here

Spinventory's Deep Reviewers I–V, its Gemini review workflow and PR-Agent are OpenRouter/Ollama-keyed
and are **not** ported (Maya, 2026-08-15: no OpenRouter expansion; the public repos already get
15+ free reviewers). Recorded in HED-13 — please don't re-propose.
