# Vendored discipline hooks (HED-107)

The heddle repos' `.claude/settings.json` invoked the fleet discipline hooks via a guard that
SILENTLY skipped them if the Spinventory checkout moved — invisibly dropping the whole discipline
layer. HED-107 fixes that with a loud-fail-open wrapper on **every** hook invocation, and vendors
the SAFE hooks into this directory so they are self-contained.

## What is vendored here (the 3 safe hooks)

- `agent-identity.py` — SessionStart identity primer
- `delegation-nudge.py` — Edit/Write delegation nudge
- `remind-owned-prs.py` — UserPromptSubmit owned-PR reminder (PR-ownership tool path comes from
  `HEDDLE_PR_OWN`, not a baked-in repo path)

These run from `$CLAUDE_PROJECT_DIR/.claude/hooks/` and survive the Spinventory checkout moving.

## What is NOT vendored (the 2 deep hooks — deferred to HED-96)

`require-memtrace-first.py` and `require-pr-sweep.py` stay wired to the **Spinventory canonical**
(absolute path in `settings.json`), still wrapped in the loud-else guard so a missing canonical
screams and fails open rather than vanishing silently.

They are deliberately NOT vendored here because they are **location-coupled**: their behaviour
depends on `PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent`. Copying them into this
repo would flip `PROJECT_ROOT` to the heddle checkout, which — combined with
`ENFORCEMENT_ROOTS[~/Developer/heddle] = True` — would ACTIVATE the memtrace-first hard-gate for
every heddle session (deny Grep/Read/Glob until Memtrace is queried). That is a real, tested,
announced, Maya-tier decision — never a silent side-effect of a vendoring PR. Verified head-to-head:
the vendored copy denies a heddle-cwd Grep where the Spinventory copy allows it.

HED-96 relocates the canonical to `~/.heddle`, does the repo-discovery refactor that makes vendoring
these two behaviour-neutral, and is where the deliberate enforcement flip lives (Maya's call).

## hook_utils

`hook_utils` (imported by the two deep hooks) is NOT here either — it lives at the stable,
home-relative `~/.claude/lib` and already survives the checkout moving. If HED-96 relocates it, that
is a one-line `sys.path` edit fleet-wide, not this ticket's job.

## The loud-fail-open contract (HED-107)

`.claude/settings.json` invokes every hook as
`if [ -f "$DIR/X.py" ]; then python3 "$DIR/X.py" ARGS; else echo "… MISSING …" >&2; fi`
(`$DIR` = `$CLAUDE_PROJECT_DIR/.claude/hooks` for the vendored 3, the Spinventory canonical for the
deep 2). An ABSENT hook prints a loud banner to stderr and is skipped (exit 0) — never blocks a tool
call, never silently disappears.

## Drift

`scripts/check-vendored-hook-drift.sh` (advisory, local-only) checks the 3 vendored copies against
the Spinventory canonical, separating real pass-through drift from the one intentional local mod
(`remind-owned-prs.py`). The 2 deep hooks are not checked — they ARE the canonical.
