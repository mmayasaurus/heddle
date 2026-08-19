# Vendored discipline hooks (HED-107)

These five hooks are vendored bridge copies of the fleet discipline hooks, copied from the
Spinventory canonical so heddle's discipline layer keeps working even if that checkout moves
or is unavailable — instead of silently vanishing (the bug HED-107 fixes).

- `agent-identity.py` — SessionStart identity primer
- `delegation-nudge.py` — Edit/Write delegation nudge
- `remind-owned-prs.py` — UserPromptSubmit owned-PR reminder
- `require-memtrace-first.py` — PreToolUse memtrace discipline gate (record-only today)
- `require-pr-sweep.py` — Stop/PostToolUse sweep discipline

This is a **bridge, not the final home**: HED-96 relocates the canonical copy to `~/.heddle`.
Until then, check for drift against the Spinventory canonical with:

    scripts/check-vendored-hook-drift.sh

`hook_utils` (imported by `require-memtrace-first.py` and `require-pr-sweep.py`) intentionally
stays at the stable, home-relative `~/.claude/lib` — it is NOT vendored here (it already survives
the checkout moving). If HED-96 relocates `~/.claude/lib`, that is a one-line `sys.path` edit
fleet-wide, not this ticket's job.

## The loud-fail-open contract (HED-107)

Two layers ensure a missing OR broken discipline hook screams but never bricks a tool call:

1. `.claude/settings.json` invokes each hook as
   `if [ -f "$CLAUDE_PROJECT_DIR/.claude/hooks/X.py" ]; then python3 … ; else echo "… MISSING …" >&2; fi`
   — an **absent** hook file prints a loud banner and is skipped (exit 0), never blocks.
2. The two gate hooks (`require-memtrace-first`, `require-pr-sweep`) wrap their body in try/except:
   any internal error (ImportError, traceback) prints a loud banner and exits 0 — a gate hook must
   never block a tool call on its own bug (`except SystemExit: raise` preserves a legitimate deny).
