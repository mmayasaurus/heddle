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

# Keep the log bounded (last ~2000 lines once it passes ~1 MB).
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 1048576 ]; then
  tail -n 2000 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
fi

{
  echo "=== $(ts) poll start ==="
  "$PY" "$SCRIPT"
  rc=$?
  echo "=== $(ts) poll end (exit $rc) ==="
  echo
} >> "$LOG" 2>&1

exit "${rc:-0}"
