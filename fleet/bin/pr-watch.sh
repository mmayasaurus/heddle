#!/usr/bin/env bash
# pr-watch.sh <pr-number> [--repo <owner/repo>] [--seed] [--reset] — SPI-910
#
# READ-ONLY, EXIT-DRIVEN PR review/CI watcher. ONE poll pass per invocation: it prints one line per
# NEW item since the last pass (deduped via a per-PR state file) and exits. It NEVER sleeps and never
# mutates the PR — no push, no merge, no comment, no re-trigger, no runner scaling. Wrap it in a
# persistent Monitor (the Monitor supplies the ~60s interval and wakes you on new stdout); do NOT
# add an internal sleep loop — the whole point (SPI-910) is exit-driven wake, not sleep-and-check.
#
# Watches the three channels that carry actionable review/CI signal (pr-review-sweep.md §6):
#   [thread] <author> <path>:<line> id=<thread-id>   — a NEW unresolved inline review thread
#   [review] <author> <state> @<ts>                  — a NEW non-empty review body (a finding)
#   [gate]   <conclusion> @<sha>                      — the required `gate` check terminal at a HEAD sha
#   [watch-error] <what> …                            — a gh/API call FAILED (surfaced, never swallowed:
#                                                        a broken watcher must not look like "nothing new")
#
# SCOPE / authority: this is a CONVENIENCE watcher, not the completeness gate. It reads the newest 100
# threads and up to 100 reviews (GraphQL/`gh` page limits) — plenty for an active review round, but on
# a PR with >100 threads it is best-effort. **`pr-sweep.sh <n>` is the authoritative completeness check**
# (run it before declaring clean / merging); this tool only tells you what ARRIVED so you can act on
# each item as it lands instead of blocking on a single sleep (and missing a late one). It does not
# watch issue comments (the retired Deep-Reviewer canonicals lived there; det-tier markers there are
# caught by pr-sweep.sh).
#
# macOS ships bash 3.2 — no associative arrays, no `mapfile`. State is a plain newline file; membership
# is `grep -qxF`. Keep it that way. NB: this polls REMOTE state; a genuinely concurrent second watcher
# on the SAME PR could double-emit an item (check-then-append is not atomic) — harmless for the normal
# one-watcher-per-PR case; do not rely on it for exactly-once across parallel watchers.
set -uo pipefail   # NOT -e: a transient gh/API failure must surface as [watch-error], never abort the poll

PR=""; REPO=""; SEED=0; RESET=0
while [ $# -gt 0 ]; do
  case "$1" in
    --repo)  REPO="${2:?--repo needs a value}"; shift 2;;
    --seed)  SEED=1; shift;;    # record current items as seen WITHOUT printing (watch only what arrives next)
    --reset) RESET=1; shift;;   # clear this PR's state and start fresh
    -h|--help) sed -n '2,24p' "$0"; exit 0;;
    -*) echo "pr-watch: unknown flag '$1'" >&2; exit 2;;
    *) if [ -z "$PR" ]; then PR="$1"; else echo "pr-watch: unexpected arg '$1'" >&2; exit 2; fi; shift;;
  esac
done
[ -n "$PR" ] || { echo "usage: pr-watch.sh <pr-number> [--repo owner/repo] [--seed] [--reset]" >&2; exit 2; }
case "$PR" in *[!0-9]*) echo "pr-watch: PR must be a number, got '$PR'" >&2; exit 2;; esac

# Repo: explicit --repo wins; else infer from cwd (gh needs a repo context).
if [ -z "$REPO" ]; then
  REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)"
fi
[ -n "$REPO" ] || { echo "pr-watch: no repo (pass --repo owner/repo or run inside a repo)" >&2; exit 2; }
OWNER="${REPO%%/*}"; NAME="${REPO##*/}"

STATE_DIR="${PR_WATCH_STATE_DIR:-$HOME/.claude/spinventory-fleet/pr-watch}"
mkdir -p "$STATE_DIR"
STATE="$STATE_DIR/$(printf '%s' "$REPO" | tr '/:' '__')-$PR.seen"
[ "$RESET" -eq 1 ] && : > "$STATE"
[ -f "$STATE" ] || : > "$STATE"

# emit KEY DISPLAY... : if KEY is new, print DISPLAY (unless seeding) and record KEY. READ-ONLY.
emit() {
  local key="$1"; shift
  grep -qxF "$key" "$STATE" 2>/dev/null && return 0
  printf '%s\n' "$key" >> "$STATE"
  [ "$SEED" -eq 1 ] || printf '%s\n' "$*"
}

# HEAD sha discriminates the gate key so a later push/re-run that also succeeds re-emits (a fresh gate
# result the agent should see), instead of being deduped against the prior identical conclusion.
SHA="$(gh pr view "$PR" --repo "$REPO" --json headRefOid --jq '.headRefOid[0:9]' 2>/dev/null || true)"
[ -n "$SHA" ] || SHA="?"

# (c) NEW unresolved inline review threads — newest 100 (a watcher wants the recently-arrived ones).
# `if out=$(...)` keeps the poll alive under set -u/pipefail: a failed gh surfaces as [watch-error].
if out=$(gh api graphql -f query='
query($o:String!,$n:String!,$p:Int!){ repository(owner:$o,name:$n){ pullRequest(number:$p){
  reviewThreads(last:100){ nodes{ id isResolved comments(first:1){ nodes{ author{login} path line } } } } } } }' \
  -F o="$OWNER" -F n="$NAME" -F p="$PR" \
  --jq '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved==false)
        | [.id, (.comments.nodes[0].author.login // "?"), (.comments.nodes[0].path // "?"), ((.comments.nodes[0].line // 0)|tostring)] | @tsv' \
  2>/dev/null); then
  printf '%s\n' "$out" | while IFS="$(printf '\t')" read -r tid login path line; do
    [ -n "$tid" ] || continue
    emit "thread:$tid" "[thread] $login $path:$line id=$tid"
  done
else
  emit "watch-error:threads:$SHA" "[watch-error] review-threads query failed (gh/graphql) — re-check auth/rate-limit; pr-sweep.sh is authoritative"
fi

# (b) NEW non-empty review bodies (qodo, bugbot, coderabbit, copilot, chatgpt-codex, humans, …).
if out=$(gh pr view "$PR" --repo "$REPO" --json reviews \
  --jq '.reviews[] | select((.body // "") != "") | [(.author.login // "?"), (.submittedAt // ""), (.state // "")] | @tsv' \
  2>/dev/null); then
  printf '%s\n' "$out" | while IFS="$(printf '\t')" read -r login ts state; do
    [ -n "$login" ] || continue
    emit "review:$login@$ts" "[review] $login $state @$ts"
  done
else
  emit "watch-error:reviews:$SHA" "[watch-error] reviews query failed (gh) — re-check auth/rate-limit; pr-sweep.sh is authoritative"
fi

# (e) required `gate` check reaching a terminal state (emit on FAILURE too — silence must never read as
# "still running"). Handles BOTH CheckRuns (.status/.conclusion) and legacy Statuses (.state). Keyed on
# sha+conclusion so each fresh gate result surfaces once.
if out=$(gh pr view "$PR" --repo "$REPO" --json statusCheckRollup \
  --jq '.statusCheckRollup[]? | select((.name // .context // "") == "gate")
        | select((.status // "") == "COMPLETED" or (.conclusion // "") != "" or (.state // "") != "")
        | (.conclusion // .state // "UNKNOWN")' \
  2>/dev/null); then
  printf '%s\n' "$out" | while read -r concl; do
    [ -n "$concl" ] || continue
    emit "gate:$SHA:$concl" "[gate] $concl @$SHA"
  done
else
  emit "watch-error:gate:$SHA" "[watch-error] gate/status query failed (gh) — re-check auth/rate-limit; pr-sweep.sh is authoritative"
fi

exit 0
