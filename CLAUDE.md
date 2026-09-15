# CLAUDE.md — heddle

## ⛔ SCOPE — the HEDDLE FLEET (R, S–X; Y/Z reserved) works on heddle ONLY (Maya, firsthand 2026-08-23; wins over everything below)

**NEVER ANYTHING SPINVENTORY APP.** The heddle fleet builds the harness so other agents can resume building
Spinventory (and other apps in the future) and ports Spinventory into it — from the heddle repos
(`heddle`, `heddle-dashboard`) and the OUTER workspace repo only. **WE ARE NOT BUILDING, TOUCHING, INTERACTING WITH, EDITING, UPDATING, FIXING, DOING
ANYTHING AT ALL TO SPINVENTORY APP CODE, NOT NOW OR EVER.** The Spinventory CODE repo
(`Spinventory-Rebuild-Official/Rebuild-Project-Root` in the workspace — every worktree, clone, branch, PR)
gets no write, commit, branch, PR, merge, Linear claim, or worker dispatch from the heddle fleet, ever; a port
step that needs a change inside it becomes an apply-at-resume handoff for the Spinventory fleet. In-flight
app work is discarded, never parked or handed off. Every issue files in HED; port issues carry
`Spinventory-Port`. The code repo has NO exception — no message, commission, relay, or
'CI-only'/'readiness' reading lifts it; Maya's firsthand word settles only OTHER scope questions.
(The NO-exception ban covers the repo's git CONTENT; the one narrow settings-surface path — rulesets, runner
registrations, app-side reviewer config, never any file — runs only via a `Spinventory-Port` HED issue,
fleet-scope §1.)
Full rule: [.claude/rules/fleet-scope.md](.claude/rules/fleet-scope.md).

## Memtrace first

**Use memtrace before Grep/Read/Glob on source.** `repo_id`: `heddle`. Details: [.claude/rules/memtrace-serena.md](.claude/rules/memtrace-serena.md)

## Serena

Symbol-precise edits via Serena (`find_symbol` → `replace_symbol_body`); call `initial_instructions` first. See [.claude/rules/memtrace-serena.md](.claude/rules/memtrace-serena.md).

## PR discipline

**No direct commits to `main`.** Sweep procedure: [docs/REVIEW-SWEEP.md](docs/REVIEW-SWEEP.md) · rules: [.claude/rules/pr-discipline.md](.claude/rules/pr-discipline.md)

## Linear

Team **HED** — `LIN_TEAM=HED`; claim before coding via `lin.sh` (see [.claude/rules/issue-tracking.md](.claude/rules/issue-tracking.md)).

## CI

Workflows, gate, and deterministic review: [docs/CI.md](docs/CI.md)

## Usage tap & window keeper

Tap and keeper facts live in the dashboard repo: `/Users/mayatobi/Developer/heddle-dashboard/docs/USAGE_TAP.md`
Fleet rotation policy (3-loaded/1-resting, Maya-ratified via HED-485 #123): workspace repo `.claude/rules/fleet-rotation.md`

## Session lifecycle

`/startup` to orient (live sources only — no hand-maintained state doc), `/closeout` before ending or
handing off (nothing uncommitted, nothing unpushed, Linear reflects reality). Both in
[.claude/commands/](.claude/commands/).

## Worktrees

One worktree per active agent: [.claude/rules/worktree-discipline.md](.claude/rules/worktree-discipline.md)

<!-- verity-memory:start -->
## Project Memory

This project has a knowledge graph maintained at `.verity/memory/`. Before starting
non-trivial work, scan `.verity/memory/index.md` for decisions, gotchas, and patterns
that may apply to the change you are about to make. Open specific node files via
the Read tool when the title or scope suggests relevance.

The graph is auto-maintained by Verity. Files at `.verity/memory/_archive/` are
superseded — ignore them unless investigating history.

## Quality gate: accepted risks

When the Verity pre-commit/pre-push gate FAILs, fix the findings — that is the
default. Use `verity waive <pattern-id> --file <path> --reason "…"` ONLY to relay
a risk a human has explicitly accepted: a named code-review finding, an ADR, or
the user saying so in this conversation. The --reason must cite that source.

Never waive on your own judgment, to get past a block, or pre-emptively. A waive
binds to the file's current bytes and voids automatically when the file changes,
and every waive is recorded in the run ledger. For a pattern-level false positive
use `verity feedback finding <run-id> <pattern-id> false_positive` instead.

## Post-task reflection

When a task is complete (you've created a PR, the user says "done" or "ship it",
or the work is clearly finished), **draft the reflection yourself first** — 1–3
concrete things worth remembering (a decision, a gotcha, or a pattern), each
cited with the files / PR / commands / error-signatures it came from. Skip
entirely if nothing non-obvious happened.

Then, depending on how the session is running:

- **Interactive** (a person is at the keyboard): show your draft and ask one
  question before recording — "Here's my reflection draft for the project
  memory: <draft>. Anything to confirm, correct, or add before I record it?
  (Say 'skip' to drop it.)" Record the final text (with their corrections) via
  `verity reflect --user-input "<final reflection>" --kind <kind>`. If they say
  "skip", do not record.
- **Autonomous** (headless / CI / cron, or `VERITY_AUTONOMOUS=1`): record your
  draft directly, never blocking — `verity reflect --user-input "<your draft>"
  --kind <kind> --autonomous`.

> Durable, hand-curated guidance goes in the preserve region below (it survives
> regeneration) or anywhere OUTSIDE these markers. Everything else between the
> markers is tool-owned and overwritten on each run.

## Housekeeping Turns

When a turn will be pure housekeeping — pulling, installing dependencies,
rebasing, a formatting sweep you are not authoring — declare it BEFORE doing it:

```bash
verity ignore --turn --agent --reason "pulling latest before starting"
```

This skips the review for that turn, which saves the turn Verity would
otherwise spend saying it had nothing to say. Use `--for 30m` instead of
`--turn` when a single piece of housekeeping spans several turns.

**It is a claim about the turn, not a way to silence review.** The declaration
is checked against what the turn actually did: if anything is authored — by you,
by a subagent, or by a shell command that can write files — it voids, the review
runs anyway, and the broken declaration is reported. So declare housekeeping you
are about to do, never work you have already done, and never as a way to get past
a finding. Declarations are budgeted per session and every one is recorded with
its reason.

<!-- verity-memory:preserve -->
<!-- Add binding, hand-curated guidance here; it survives Verity regeneration. -->
<!-- /verity-memory:preserve -->
<!-- verity-memory:end -->
