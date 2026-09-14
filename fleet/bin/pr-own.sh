#!/usr/bin/env bash
#
# pr-own.sh — PR ownership helper (see .claude/rules/pr-ownership.md)
#
# Records ownership ON the PR (a `claimed` label + a machine-readable PR-OWNER marker
# comment) so it survives compaction and is visible to every instance. Owner id = this
# worktree's name. Non-destructive: never force-pushes, never deletes another owner's marker.
#
#   pr-own.sh whoami          print this worktree's owner id
#   pr-own.sh claim   <n>     claim PR <n>, or (if already yours) bump its heartbeat
#   pr-own.sh check   <n>     YOURS | UNOWNED | STALE | OWNED:<wt> — with a verdict line
#   pr-own.sh mine            list open PRs this worktree owns
#   pr-own.sh release <n>     hand off: drop the label + post a release note
#
# Staleness threshold: PR_OWN_STALE_HOURS (default 4).
#
# Exit codes for `check` (so callers can branch): 0 YOURS/UNOWNED/STALE (ok to proceed
# after claiming), 3 OWNED-by-another-and-fresh (STAND DOWN). Any tool error → exit 0
# (fail-open: this helper must never block real work).

set -uo pipefail
STALE_HOURS="${PR_OWN_STALE_HOURS:-4}"
MARK_PREFIX="<!-- PR-OWNER"

die_open() { echo "pr-own: $*" >&2; exit 0; }   # fail-open on any environmental problem
command -v gh  >/dev/null 2>&1 || die_open "gh not found"

owner_id() {
  local top base id
  top=$(git rev-parse --show-toplevel 2>/dev/null) || { printf 'unknown'; return; }
  base=$(basename "$top")
  id="${base#Rebuild-Project-Root.}"                 # Rebuild-Project-Root.forms -> forms
  id="${id#heddle-dashboard.}"                       # heddle sibling worktrees (transitional, HED-82)
  id="${id#heddle.}"
  [ "$id" = "Rebuild-Project-Root" ] && id="main"    # main working copy (no suffix)
  [ "$id" = "heddle" ] && id="main"                  # heddle main checkouts (HED-82)
  [ "$id" = "heddle-dashboard" ] && id="main"
  [ -z "$id" ] && id="main"
  printf '%s' "$id"
}

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

iso_to_epoch() {  # macOS/BSD date; falls back to GNU date
  date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "$1" +%s 2>/dev/null || date -u -d "$1" +%s 2>/dev/null
}

repo_nwo() { gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null; }

# Body of the latest PR-OWNER marker comment on PR $1 (empty if none).
latest_marker_body() {
  gh pr view "$1" --json comments \
    -q "[.comments[] | select(.body|startswith(\"$MARK_PREFIX\"))] | last | .body // \"\"" 2>/dev/null
}
# Numeric issue-comment id of that marker (for in-place edit), empty if none.
latest_marker_id() {
  local url
  url=$(gh pr view "$1" --json comments \
    -q "[.comments[] | select(.body|startswith(\"$MARK_PREFIX\"))] | last | .url // \"\"" 2>/dev/null)
  [ -n "$url" ] && printf '%s' "${url##*issuecomment-}"
}
field() { printf '%s' "$1" | grep -oE "$2=[^ ]+" | head -1 | cut -d= -f2; }

# Parse latest marker → sets M_OWNER, M_SINCE, M_HB, M_AGE_H (hours, integer). Returns 1 if no marker.
parse_marker() {
  local body; body=$(latest_marker_body "$1")
  [ -z "$body" ] && return 1
  M_OWNER=$(field "$body" owner); M_SINCE=$(field "$body" since); M_HB=$(field "$body" heartbeat)
  [ -z "$M_OWNER" ] && return 1
  local hb_e now_e; hb_e=$(iso_to_epoch "$M_HB"); now_e=$(date -u +%s)
  if [ -n "$hb_e" ]; then M_AGE_H=$(( (now_e - hb_e) / 3600 )); else M_AGE_H=9999; fi
  return 0
}

marker_body() { printf '%s owner=%s since=%s heartbeat=%s -->\n\n_PR ownership marker — managed by `.claude/bin/pr-own.sh` (see pr-ownership.md). Owner = the worktree driving this PR to green._' "$MARK_PREFIX" "$1" "$2" "$3"; }

ensure_label() { gh label create claimed --color BFDADC --description "A worktree owns/drives this PR (see pr-ownership.md)" >/dev/null 2>&1 || true; }

cmd=${1:-}; pr=${2:-}
me=$(owner_id)

case "$cmd" in
  whoami) echo "$me" ;;

  check)
    [ -n "$pr" ] || die_open "usage: pr-own.sh check <pr#>"
    if ! parse_marker "$pr"; then echo "UNOWNED — PR #$pr has no owner. Claim it before you work it: pr-own.sh claim $pr"; exit 0; fi
    # A released marker means the prior owner handed off — adoptable immediately, regardless of
    # the release note's (fresh) heartbeat. Without this, release→adopt was impossible until the
    # stale window passed, stranding handed-off PRs for hours (SPI-529).
    if [ "$M_OWNER" = "released" ]; then
      echo "RELEASED — PR #$pr was handed off by its prior owner and is free to adopt: pr-own.sh claim $pr"; exit 0
    fi
    if [ "$M_OWNER" = "$me" ]; then echo "YOURS — you ($me) own PR #$pr (heartbeat ${M_AGE_H}h ago). Proceed."; exit 0; fi
    if [ "$M_AGE_H" -ge "$STALE_HOURS" ]; then
      echo "STALE — PR #$pr was owned by '$M_OWNER' but the heartbeat is ${M_AGE_H}h old (>= ${STALE_HOURS}h). Reclaimable: pr-own.sh claim $pr"; exit 0
    fi
    echo "OWNED:$M_OWNER (fresh, heartbeat ${M_AGE_H}h ago) — STAND DOWN. Another instance is actively driving PR #$pr. Do not push/merge/deepreview; coordinate with Maya if you think it should be yours."; exit 3 ;;

  claim)
    [ -n "$pr" ] || die_open "usage: pr-own.sh claim <pr#>"
    now=$(now_iso); since="$now"
    if parse_marker "$pr"; then
      # 'released' is a handoff, not an owner — adoptable no matter how fresh the release note is (SPI-529).
      if [ "$M_OWNER" != "$me" ] && [ "$M_OWNER" != "released" ] && [ "$M_AGE_H" -lt "$STALE_HOURS" ]; then
        echo "REFUSED — PR #$pr is owned by '$M_OWNER' (fresh, ${M_AGE_H}h). STAND DOWN or coordinate with Maya." >&2; exit 3
      fi
      [ "$M_OWNER" = "$me" ] && since="$M_SINCE"   # keep original since; just bump heartbeat
      if [ "$M_OWNER" = "released" ]; then
        gh pr comment "$pr" --body "♻️ Adopting PR #$pr — released by its prior owner, now owned by '$me'." >/dev/null 2>&1
      elif [ "$M_OWNER" != "$me" ]; then
        gh pr comment "$pr" --body "♻️ Reclaiming PR #$pr — prior owner '$M_OWNER' heartbeat was ${M_AGE_H}h stale (>= ${STALE_HOURS}h). Now owned by '$me'." >/dev/null 2>&1
      fi
      cid=$(latest_marker_id "$pr"); nwo=$(repo_nwo)
      if [ -n "$cid" ] && [ -n "$nwo" ]; then
        gh api "repos/$nwo/issues/comments/$cid" -X PATCH -f body="$(marker_body "$me" "$since" "$now")" >/dev/null 2>&1 \
          && { ensure_label; gh pr edit "$pr" --add-label claimed >/dev/null 2>&1 || true; echo "OK — PR #$pr owned by '$me' (heartbeat bumped $now)"; exit 0; }
      fi
    fi
    ensure_label
    gh pr edit "$pr" --add-label claimed >/dev/null 2>&1 || true
    gh pr comment "$pr" --body "$(marker_body "$me" "$since" "$now")" >/dev/null 2>&1 \
      && echo "OK — PR #$pr claimed by '$me' ($now)" || die_open "could not post claim marker"
    ;;

  release)
    [ -n "$pr" ] || die_open "usage: pr-own.sh release <pr#>"
    gh pr edit "$pr" --remove-label claimed >/dev/null 2>&1 || true
    gh pr comment "$pr" --body "$MARK_PREFIX owner=released since=- heartbeat=$(now_iso) --> · '$me' is releasing PR #$pr — free for another instance to adopt (pr-own.sh claim $pr)." >/dev/null 2>&1 \
      && echo "OK — PR #$pr released by '$me'" || die_open "could not post release note" ;;

  mine)
    for n in $(gh pr list --label claimed --state open --limit 100 --json number -q '.[].number' 2>/dev/null); do
      if parse_marker "$n" && [ "$M_OWNER" = "$me" ]; then
        flag=""; [ "$M_AGE_H" -ge "$STALE_HOURS" ] && flag="  ⚠️ heartbeat ${M_AGE_H}h STALE — bump or release"
        echo "#$n  (heartbeat ${M_AGE_H}h ago)$flag"
      fi
    done
    ;;

  *) echo "usage: pr-own.sh {whoami|claim <n>|check <n>|release <n>|mine}   (see .claude/rules/pr-ownership.md)" >&2; exit 0 ;;
esac
