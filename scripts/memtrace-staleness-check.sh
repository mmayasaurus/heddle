#!/bin/sh
# memtrace-staleness-check — detect when the heddle memtrace graph has drifted behind
# origin/main and NAG loudly, so an agent re-indexes it via the MCP `index_directory` tool.
#
# ── Why this is a DETECTOR, not an auto-indexer ────────────────────────────────────────
# The live fleet graph is served by ONE persistent memcore-server on 127.0.0.1:50051
# (--data-dir …/Rebuild-Project-Root/.memdb). The ONLY path proven to update THAT store is
# the MCP `index_directory` tool, which is agent-driven. The `memtrace index` CLI, when given
# MEMTRACE_MEMDB_DATA_DIR, spins up a SIDECAR memcore-server against a throwaway .memdb that
# nobody serves — verified from Spinventory's own refresh log ("sidecar memcore-server (data
# dir: …/Spinventory-Rebuild-App/.memdb)"). A launchd shell job cannot call MCP tools. So a
# shell job can only DETECT drift and nag; a human/agent performs the actual re-index.
# Full rationale + topology: docs/MEMTRACE-FRESHNESS.md. Tickets: HED-233 (this), HED-234
# (proper unattended indexer — blocked on the memtrace 0.8.63→1.1.5 upgrade + a Maya decision).
#
# ── Safety ─────────────────────────────────────────────────────────────────────────────
# NON-DESTRUCTIVE: fetches origin (updates remote-tracking refs only), never touches the
# working tree, never writes any .memdb store. Safe to run unattended or ad-hoc.
#
# ── Exit codes ───────────────────────────────────────────────────────────────────────────
#   0  graph is current (origin/main == last-indexed marker)
#   1  graph is STALE — a re-index is needed (details on stderr + in the log)
#   2  setup error (canonical missing / git unavailable)
#
# ── Install ──────────────────────────────────────────────────────────────────────────────
# NOT installed by default. Loading the launchd template (scripts/com.heddle.memtrace-staleness.plist)
# is Maya's firsthand call — see docs/MEMTRACE-FRESHNESS.md. Run ad-hoc any time:
#   sh scripts/memtrace-staleness-check.sh
set -u

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

# Canonical checkout that gets indexed as repo_id=heddle. Overridable for other machines/tests.
CANON="${HEDDLE_CANON:-/Users/mayatobi/Developer/heddle}"
# Marker: the commit last indexed into the LIVE server. A local runtime file (gitignored),
# written by whoever runs the MCP re-index (see the ACTION block below).
MARKER="${HEDDLE_MEMTRACE_MARKER:-$CANON/.memtrace-heddle-indexed-commit}"
LOG="${HEDDLE_MEMTRACE_LOG:-$CANON/.memtrace-staleness.log}"

ts() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }
logline() { printf '[%s] %s\n' "$(ts)" "$1" >> "$LOG" 2>/dev/null || true; }

[ -d "$CANON/.git" ] || { printf 'memtrace-staleness-check: canonical is not a git repo: %s\n' "$CANON" >&2; exit 2; }
command -v git >/dev/null 2>&1 || { printf 'memtrace-staleness-check: git not found on PATH\n' >&2; exit 2; }

# Fetch origin/main — updates remote-tracking refs only; no working-tree change.
if ! git -C "$CANON" fetch origin main --quiet 2>>"$LOG"; then
  logline "WARN: git fetch origin main failed — skipping this check (no verdict)"
  printf 'memtrace-staleness-check: git fetch failed — skipping\n' >&2
  exit 0
fi

origin="$(git -C "$CANON" rev-parse origin/main 2>/dev/null || printf '')"
head="$(git -C "$CANON" rev-parse HEAD 2>/dev/null || printf '')"
indexed="$(cat "$MARKER" 2>/dev/null | tr -d '[:space:]')"
[ -n "$indexed" ] || indexed="none"

if [ -z "$origin" ]; then
  logline "WARN: could not resolve origin/main — skipping"
  printf 'memtrace-staleness-check: could not resolve origin/main\n' >&2
  exit 0
fi

if [ "$origin" = "$indexed" ]; then
  logline "OK: heddle graph current (origin/main = indexed = $origin)"
  exit 0
fi

# Drift — build a signal-rich nag. behind-count is best-effort (fails if marker is unknown/absent).
if [ "$indexed" = "none" ]; then
  behind="unknown (no marker — assume a re-index is needed)"
else
  behind="$(git -C "$CANON" rev-list --count "${indexed}..origin/main" 2>/dev/null || printf '?')"
  behind="$behind commits"
fi

# Note whether the canonical checkout itself is behind origin (it must be ff'd before indexing,
# because index_directory reads the checkout at $CANON).
ff_note=""
[ -n "$head" ] && [ "$head" != "$origin" ] && ff_note="
  NOTE: the canonical checkout is at $head, behind origin/main — ff it first (git -C $CANON merge --ff-only origin/main)."

MSG="STALE: heddle memtrace graph is behind origin/main.
  origin/main : $origin
  last indexed: $indexed  ($behind)$ff_note
  ACTION (an agent must run this — a shell job cannot reach the live :50051 store):
    1. (if the note above applies) ff the canonical to origin/main
    2. MCP: index_directory(path=$CANON, repo_id=heddle, incremental=true, branch=main)
    3. printf '%s' '$origin' > '$MARKER'    # record what was actually indexed
  See docs/MEMTRACE-FRESHNESS.md."

logline "$MSG"
printf '%s\n' "$MSG" >&2
# Best-effort macOS desktop nudge — never let it fail the job.
if command -v osascript >/dev/null 2>&1; then
  osascript -e "display notification \"heddle memtrace graph stale ($behind) — agent re-index needed\" with title \"memtrace staleness\"" >/dev/null 2>&1 || true
fi
exit 1
