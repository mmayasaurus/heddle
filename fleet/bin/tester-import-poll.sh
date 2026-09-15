#!/bin/bash
# Poll the tester bug-report Google Sheet and import any new rows into Linear.
#
# Run unattended by the com.spinventory.tester-import launchd agent (every 15 min).
# The Python importer dedups via ~/.claude/spinventory-fleet/tester-import-state.json,
# so a poll with no new rows is a safe no-op, and the Linear token self-re-mints —
# nothing here needs Maya's login.
#
# Manual use:  .claude/bin/tester-import-poll.sh   (runs one poll, appends to the log)
set -uo pipefail

PY="/opt/homebrew/opt/python@3.12/libexec/bin/python3"
SCRIPT="/Users/mayatobi/Developer/Spinventory-Rebuild-App/.claude/bin/import-tester-issues.py"
LOG="$HOME/.claude/spinventory-fleet/tester-import-poll.log"

ts() { date "+%Y-%m-%d %H:%M:%S"; }

# Refuse to poll unless the dedup STATE FILE already exists. It lives in the fleet dir
# ($HOME/.claude/spinventory-fleet) next to the log — but that dir also holds lin.sh's OAuth
# tokens and pr-sync state, so its mere existence says nothing about whether tester-import
# has been seeded; the STATE FILE does. If it is absent, the importer would load an EMPTY
# state (load_state -> {"imported": {}}) and mass-create a duplicate Linear issue for every
# unfixed sheet row, unattended, from the 15-min launchd tick. Seeding is a DELIBERATE,
# attended step (run import-tester-issues.py directly; --dry-run to preview) — this wrapper
# only ever MAINTAINS an existing state. So fail CLOSED when it is missing. ([ -f "$STATE" ]
# implies the dir exists, so this also subsumes the original finding: an absent dir made the
# `>> "$LOG"` redirect fail, the poll block never ran, and the old `exit "${rc:-0}"` reported
# a false success.)
STATE="$(dirname "$LOG")/tester-import-state.json"
[ -f "$STATE" ] || { echo "tester-import-poll: no dedup state at $STATE — seed with import-tester-issues.py first (--dry-run to preview); refusing to poll" >&2; exit 1; }

# Keep the log bounded (last ~2000 lines once it passes ~1 MB).
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 1048576 ]; then
  tail -n 2000 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
fi

# Initialize rc to FAILURE so an inherited rc=0 from the environment cannot mask a poll
# block that never ran (a failed `>> "$LOG"` redirect skips the block entirely). A real poll
# overwrites this with the importer's exit code.
rc=1
{
  echo "=== $(ts) poll start ==="
  "$PY" "$SCRIPT"
  rc=$?
  echo "=== $(ts) poll end (exit $rc) ==="
  echo
} >> "$LOG" 2>&1

# Fail CLOSED: rc is the FAILURE default (1) unless the poll block ran and overwrote it. A
# false success would hide a broken poll (e.g. an unwritable "$LOG") from the launchd agent
# that runs this every 15 min.
exit "$rc"
