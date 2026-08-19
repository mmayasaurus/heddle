#!/bin/sh
# Advisory, local-only drift check (HED-107). NOT run in CI -- CI has no Spinventory
# checkout to diff against. Compares each vendored bridge hook in .claude/hooks/ against
# the Spinventory canonical it was copied from. Tolerant of the canonical being absent
# (exits 0 either way). Exit code is always 0 -- this is advisory, never a gate.
#
# HED-107 vendors only the 3 SAFE hooks (the 2 deep hooks — require-memtrace-first,
# require-pr-sweep — stay at the Spinventory canonical, behavior-neutral, deferred to
# HED-96, so they are NOT checked here). Two classes of vendored hook:
#   PASS-THROUGH  - byte-identical copies. A diff here is REAL drift: the canonical
#                   evolved and the vendored copy should be re-synced (plain cp).
#   LOCALLY-MODIFIED - de-hardcoded for HED-107, so it diverges from canonical BY DESIGN.
#                   A diff is expected; the check instead warns if the expected divergence
#                   is MISSING (a lost local mod), and reminds that a changed canonical
#                   must be reconciled by hand (not a blind cp).
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
VENDORED_DIR="$REPO_ROOT/.claude/hooks"
CANONICAL_DIR="${SPINVENTORY_HOOKS_DIR:-/Users/mayatobi/Developer/Spinventory-Rebuild-App/.claude/hooks}"

PASSTHROUGH="agent-identity.py delegation-nudge.py"
LOCALLY_MODIFIED="remind-owned-prs.py"

if [ ! -d "$CANONICAL_DIR" ]; then
  echo "check-vendored-hook-drift: canonical dir not found at $CANONICAL_DIR -- skipping (set SPINVENTORY_HOOKS_DIR to override)"
  exit 0
fi

drift=0

for h in $PASSTHROUGH; do
  vendored="$VENDORED_DIR/$h"; canonical="$CANONICAL_DIR/$h"
  if [ ! -f "$vendored" ]; then echo "MISSING vendored copy: $h"; drift=1; continue; fi
  if [ ! -f "$canonical" ]; then echo "no canonical to compare (heddle-only?): $h"; continue; fi
  if ! diff -q "$canonical" "$vendored" >/dev/null 2>&1; then
    echo "DRIFT (pass-through): $h differs from canonical -- re-sync with: cp \"$canonical\" \"$vendored\""
    drift=1
  fi
done

for h in $LOCALLY_MODIFIED; do
  vendored="$VENDORED_DIR/$h"; canonical="$CANONICAL_DIR/$h"
  if [ ! -f "$vendored" ]; then echo "MISSING vendored copy: $h"; drift=1; continue; fi
  if [ ! -f "$canonical" ]; then echo "no canonical to compare (heddle-only?): $h"; continue; fi
  if diff -q "$canonical" "$vendored" >/dev/null 2>&1; then
    echo "WARNING: $h is byte-identical to canonical but should carry HED-107 local mods -- a local modification may have been lost"
    drift=1
  else
    echo "info: $h is locally modified for HED-107 (expected divergence). If the canonical ALSO changed, reconcile by hand -- do NOT blind-cp: diff \"$canonical\" \"$vendored\""
  fi
done

if [ "$drift" -eq 0 ]; then
  echo "check-vendored-hook-drift: no unexpected drift against $CANONICAL_DIR"
fi
exit 0
