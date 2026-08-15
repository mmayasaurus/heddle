# CI & review on this repo

Everything runs on GitHub-hosted runners (the repo is public, so minutes are free) and is defined
in `.github/`. Ported from the Spinventory fleet's CI (deterministic tier + gate) and simplified for
a public repo; the reviewer-fleet enablement items that need Maya's account (branch ruleset, app
installs) are tracked in Linear **HED-13**.

## What runs

| Workflow | Trigger | Jobs | Posture |
|---|---|---|---|
| `gate.yml` | push `main`, PRs to `main`, manual | **`gate`** — `npm ci` → `npm run typecheck` → `npm run build` → smoke the built CLI (`classes`/`packs --json` must be non-empty arrays) | the **required** merge check (job name `gate` is the ruleset's context string — don't rename) |
| `deterministic-review.yml` | PRs (incl. drafts for gitleaks; base-branch retargets), push `main` | **semgrep** (`p/typescript` + `p/nodejs`, diff-aware vs the PR base, full on `main`, SARIF → code scanning) · **gitleaks** (official CLI over exactly `base.sha..head.sha`) | semgrep report-only · gitleaks red on a hit (not required) |
| `actions-hygiene.yml` | PRs / `main` pushes touching `.github/**` | **actionlint** · **zizmor** (SARIF → code scanning) | actionlint red on findings · zizmor report (same-repo) / red (forks) |
| `.github/dependabot.yml` | weekly | grouped bumps of the hash-pinned actions, 7-day cooldown | — |
| `.deepsource.toml` | (DeepSource app, once installed — HED-13) | JS/TS + secrets analyzers, repo-accurate config | merged *before* the app so it doesn't invent work |

Findings surface as **code-scanning alerts** ("Code scanning results / <tool>" checks + the Security
tab), job summaries, and the job log — plus whatever the AI reviewer apps post. The `.deepsource.toml`
exists because an unconfigured DeepSource opened ~118 non-defect threads on one Spinventory PR.

## Rules baked into the workflows (don't undo them casually)

- **A green scanner check is not a scan — assert the scanned volume.** The gitleaks step computes
  `git rev-list --count --no-merges base..head` itself and reds the job on any `ERR`/`[git]`/`fatal`
  line in gitleaks' log or a "N commits scanned" mismatch. Origin: in a `container:` job the
  workspace is owned by the runner uid and `actions/checkout` writes its `safe.directory` entry to a
  temporary HOME, so gitleaks' internal `git log` failed with "dubious ownership" — and gitleaks
  still exited 0 with "0 commits scanned … no leaks found". Two rounds of a PR were green with an
  empty scan before a human read the log. Every container-job script therefore starts with
  `git config --global --add safe.directory "$GITHUB_WORKSPACE"`, and any scanner added later must
  ship with a volume assertion from day one (semgrep/zizmor: HED-70).
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
- **Fork PRs get scanned too**; only the SARIF-upload steps (write token) are same-repo-guarded.
- `pull_request: edited` is handled *only* for base-branch retargets (the baseline/range moves);
  title/body edits are skipped by the job guards and get their own concurrency group so they never
  cancel an in-flight scan.

## The review sweep (before anything is called clean)

A PR is clean only after **every channel** — issue comments, review bodies, inline threads,
code-scanning alerts, and the checks tab — has been read against the **latest** commit and every
item fixed or answered with rationale (dispute bots with evidence, never rubber-stamp). Some
reviewers need a manual trigger (CodeRabbit on repos with <10 stars: comment `@coderabbitai
review`). Spinventory's `pr-sweep.sh <n>` is repo-agnostic and runs from inside this repo; the
heddle-specific sweep doc is HED-16. Two clean sweeps ≥15 minutes apart at HEAD are the bar
(late-landing bots), and merges are merge commits — never squash, never force.

## Deliberately NOT here

Spinventory's Deep Reviewers I–V, its Gemini review workflow and PR-Agent are OpenRouter/Ollama-keyed
and are **not** ported (Maya, 2026-08-15: no OpenRouter expansion; the public repos already get
15+ free reviewers). Recorded in HED-13 — please don't re-propose.
