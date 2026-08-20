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
# Non-destructive to the repo and the graph store: it only updates remote-tracking refs
# (git fetch) and appends to its own log — no working-tree change, no history rewrite, no
# .memdb write. Safe to run unattended or ad-hoc.
#
# ── Exit codes ───────────────────────────────────────────────────────────────────────────
#   0  graph is current (origin/main == last-indexed marker)
#   1  graph is STALE — a re-index is needed (details on stderr + in the log)
#   2  cannot establish a verdict (canonical missing, git unavailable, or fetch/resolve failed).
#      A fetch failure is deliberately NOT reported as 0 "current" — a persistent network/auth
#      failure must never silently mask staleness (the exact rot this guards against).
#
# ── Install ──────────────────────────────────────────────────────────────────────────────
# NOT installed by default. Loading the launchd template (scripts/com.heddle.memtrace-staleness.plist)
# is Maya's firsthand call — see docs/MEMTRACE-FRESHNESS.md. Run ad-hoc any time:
#   sh scripts/memtrace-staleness-check.sh
set -u

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

# Canonical checkout that gets indexed as repo_id=heddle. A fixed default (overridable) — NOT
# derived from $0: the script is also invoked from worktree COPIES, and $0-derivation would then
# point at the worktree instead of the canonical the live graph is indexed from. Override for
# other machines/tests with HEDDLE_CANON.
CANON="${HEDDLE_CANON:-/Users/mayatobi/Developer/heddle}"
# Marker: the commit last indexed into the LIVE server. A local runtime file (gitignored),
# written by whoever runs the MCP re-index (see the ACTION block below).
MARKER="${HEDDLE_MEMTRACE_MARKER:-$CANON/.memtrace-heddle-indexed-commit}"
LOG="${HEDDLE_MEMTRACE_LOG:-$CANON/.memtrace-staleness.log}"

# If the log path is not writable, fall back to /dev/null so no redirection can fail the run.
# Wrap in a SUBSHELL: `:` is a POSIX special built-in and a redirection error on one exits a strict
# POSIX shell (dash) outright — the subshell contains that failure so the parent takes the `||`.
( : >> "$LOG" ) 2>/dev/null || LOG=/dev/null

ts() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }
logline() { printf '[%s] %s\n' "$(ts)" "$1" >> "$LOG" 2>/dev/null || true; }

[ -d "$CANON/.git" ] || { printf 'memtrace-staleness-check: canonical is not a git repo: %s\n' "$CANON" >&2; exit 2; }
command -v git >/dev/null 2>&1 || { printf 'memtrace-staleness-check: git not found on PATH\n' >&2; exit 2; }

# Fetch origin/main — updates remote-tracking refs only; no working-tree change.
if ! git -C "$CANON" fetch origin main --quiet 2>>"$LOG"; then
  # Do NOT exit 0: a persistent network/auth/remote failure would read as "current" and silently
  # suppress staleness detection. Report inability-to-verify (2) instead.
  logline "ERROR: git fetch origin main failed — cannot establish a freshness verdict"
  printf 'memtrace-staleness-check: git fetch failed — cannot verify freshness (exit 2)\n' >&2
  exit 2
fi

origin="$(git -C "$CANON" rev-parse origin/main 2>/dev/null || printf '')"
head="$(git -C "$CANON" rev-parse HEAD 2>/dev/null || printf '')"

# Read the marker's FIRST line, hex-validate it (cheap pre-filter + injection guard; one line so a
# multi-line file cannot collapse into a false-valid concatenation — gitar), THEN canonicalize it to a
# FULL commit id via git so an ABBREVIATED marker (e.g. ea31787) still compares equal to the full
# origin/main SHA (cubic P2). rev-parse --verify also confirms it names a real commit in the repo.
# Any step failing → "none" (→ needs-reindex); raw is never interpolated into a git revision.
raw="$(head -n1 "$MARKER" 2>/dev/null)"
if printf '%s' "$raw" | grep -Eq '^[0-9a-fA-F]{7,40}$' &&
   indexed="$(git -C "$CANON" rev-parse --verify --quiet "${raw}^{commit}" 2>/dev/null)" && [ -n "$indexed" ]; then
  : # indexed is now the full 40-char commit SHA
else
  [ -n "$raw" ] && logline "WARN: marker $MARKER does not resolve to a commit in the repo — treating as unindexed"
  indexed="none"
fi

if [ -z "$origin" ]; then
  logline "ERROR: could not resolve origin/main — cannot establish a freshness verdict"
  printf 'memtrace-staleness-check: could not resolve origin/main (exit 2)\n' >&2
  exit 2
fi

if [ "$origin" = "$indexed" ]; then
  logline "OK: heddle graph current (origin/main = indexed = $origin)"
  exit 0
fi

# Drift — build a signal-rich nag. behind-count is best-effort (fails if marker is unknown/absent).
if [ "$indexed" = "none" ]; then
  behind="unknown (no valid marker — assume a re-index is needed)"
else
  behind="$(git -C "$CANON" rev-list --count "${indexed}..origin/main" 2>/dev/null || printf '?')"
  behind="$behind commits"
fi

# Note whether the canonical checkout itself differs from origin (it must be reconciled before
# indexing, because index_directory reads the checkout at $CANON). Do not assert a direction:
# it is usually behind, but could be ahead or diverged if something left the canonical off main.
ff_note=""
if [ -n "$head" ] && [ "$head" != "$origin" ]; then
  ff_note="
  NOTE: the canonical checkout is at $head, which does NOT match origin/main — index_directory
        reads the checkout, so reconcile it first (normally: git -C $CANON merge --ff-only origin/main;
        if it is ahead or diverged, resolve that before indexing)."
fi

MSG="STALE: heddle memtrace graph is behind origin/main.
  origin/main : $origin
  last indexed: $indexed  ($behind)$ff_note
  ACTION — an agent must run the re-index (a shell job cannot reach the live :50051 store):
    1. reconcile the canonical to origin/main if the NOTE above applies
    2. MCP: index_directory(path=$CANON, repo_id=heddle, incremental=true, branch=main)
    3. record the commit ACTUALLY indexed (HEAD after the ff, not a fresh origin/main):
         git -C $CANON rev-parse HEAD > $MARKER
  Full procedure: docs/MEMTRACE-FRESHNESS.md."

logline "$MSG"
printf '%s\n' "$MSG" >&2
# Best-effort macOS desktop nudge — never let it fail the job.
if command -v osascript >/dev/null 2>&1; then
  osascript -e "display notification \"heddle memtrace graph stale ($behind) — agent re-index needed\" with title \"memtrace staleness\"" >/dev/null 2>&1 || true
fi
exit 1
