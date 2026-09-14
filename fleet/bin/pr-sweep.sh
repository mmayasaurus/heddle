#!/usr/bin/env bash
#
# pr-sweep.sh — mechanized Commandment #3 sweep (see .claude/rules/pr-review-sweep.md)
#
# Fetches ALL review channels for a PR in one shot — every author, no name filtering —
# and applies the mechanical gates. It guarantees COMPLETENESS of the data, not judgment:
# the agent must still read and address every listed item (fix, or reply + resolve with
# rationale) before calling the PR clean.
#
#   pr-sweep.sh <n>             full sweep report + mechanical verdict
#
# (The pre-PR adversarial review is dispatched BEFORE opening the PR — see pr-review-sweep.md §1;
#  the retired /deepreview + gitar trigger ritual is gone, so there is no --trigger step.)
#
# Channels:
#   (a) issue comments      (b) review bodies (non-empty = finding)      (c) inline threads
#   (d) code-scanning alerts OPEN for this PR (SARIF from semgrep/gitleaks/zizmor on the heddle
#       repos; any repo with code scanning)      (e) checks at HEAD (non-green ones listed)
# Mechanical gates (exit 2 if any fail; exit 0 = mechanically clean):
#   - 0 unresolved inline threads
#   - 0 OPEN code-scanning alerts for the PR (fix, or dismiss with a reason in the Security tab —
#     that IS the disposition). Only an explicit GitHub no-code-scanning signal is reported as
#     "unavailable"; every other API failure retries once, then fails CLOSED (SPI-924).
#   (e) is informational only: required-ness is not knowable here and some jobs are red by design
#       (heddle-dashboard `lint` until HED-14) — read them, don't ignore them.
# Also reported (informational, agent must read ALL): every comment + review body; likely
# rate-limit/cap notices from known bots are DEMOTED into a collapsed but still-VISIBLE group
# (never dropped — SKIM it before declaring clean, it is not an auto-clear); items that landed
# AFTER the last push (late bots); pr-own.sh ownership.
#
# Run from inside the inner app repo or any of its worktrees (uses `gh` repo context).
# Exit codes: 0 mechanically clean · 2 gates failed / items need attention · 3 fetch error.

set -uo pipefail

# Absolute path to this script's dir, resolved once, so the python block can import its
# helpers (pr_sweep_cap_notice.py, pr_sweep_cs.py) regardless of CWD — a bare dirname would break the moment
# anything cd's before the python call (SPI-898).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Fail CLOSED: if the dir didn't resolve or either helper isn't beside this script, refuse to
# run rather than silently fall back to a CWD import/search path (SPI-898 review — copilot).
[ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/pr_sweep_cap_notice.py" ] && [ -f "$SCRIPT_DIR/pr_sweep_cs.py" ] || { echo "pr-sweep: required helper not found (SCRIPT_DIR='$SCRIPT_DIR') — refusing to run with an unknown import path" >&2; exit 3; }

PR="${1:-}"
[ -n "$PR" ] || { echo "usage: pr-sweep.sh <pr#>" >&2; exit 3; }
case "$PR" in *[!0-9]*) echo "pr-sweep: PR must be numeric, got '$PR'" >&2; exit 3;; esac
[ "$#" -le 1 ] || echo "pr-sweep: ignoring extra arg(s) '${*:2}' — the --trigger flag was retired (SPI-920)" >&2

command -v gh >/dev/null 2>&1 || { echo "pr-sweep: gh not found" >&2; exit 3; }

# Repo owner/name — derived GraphQL-free from the git remote (HED-269). `gh repo view --json` is
# GraphQL-backed, so it not only charges the shared pool but FAILS when that pool is drained — the
# exact scenario this economization targets — which would break the sweep at line 1. Honor
# `gh repo set-default` (remote.origin.gh-resolved names a specific repo when set); fall back to gh's
# GraphQL lookup only if the remote can't be parsed.
_resolved=$(git config --get remote.origin.gh-resolved 2>/dev/null)
if printf '%s' "$_resolved" | grep -q '/'; then
  NWO="$_resolved"
else
  NWO=$(git config --get remote.origin.url 2>/dev/null | sed -E 's#\.git$##; s#^.*github\.com[/:]##')
fi
[ -n "$NWO" ] || NWO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)
[ -n "$NWO" ] || { echo "pr-sweep: not inside a gh-connected repo" >&2; exit 3; }

# ── Fetch all channels + PR metadata ────────────────────────────────────────────────────
TMP=$(mktemp -d "${TMPDIR:-/tmp}/pr-sweep.XXXXXX") || exit 3
trap 'rm -rf "$TMP"' EXIT

# PR metadata + merge-state via REST (HED-269): `gh pr view --json` is GraphQL-backed and drains the
# shared mmayasaurus pool (5000→0 in ~5min under 6 agents). Every field here has a REST home; state /
# mergeable / mergeStateStatus are mapped to the gh-pr-view vocabulary so the report below is identical
# to the old GraphQL path. comments/reviews are (and always were) re-fetched paginated below — the
# --json path silently capped them at 100.
gh api "repos/$NWO/pulls/$PR" > "$TMP/prmeta.json" 2>"$TMP/err" \
  || { echo "pr-sweep: failed to fetch PR #$PR:"; cat "$TMP/err"; exit 3; }
gh api "repos/$NWO/pulls/$PR/commits?per_page=100" --paginate 2>"$TMP/err" \
  | jq -s '[add[]? | {committedDate: (.commit.committer.date // .commit.author.date // "")}]' \
  > "$TMP/commits.json" \
  || { echo "pr-sweep: paginated commits fetch failed:"; cat "$TMP/err"; exit 3; }
jq --slurpfile cm "$TMP/commits.json" '{
    number: .number,
    title: (.title // ""),
    state: (if .merged then "MERGED" elif (.state // "") == "closed" then "CLOSED" else "OPEN" end),
    headRefOid: (.head.sha // ""),
    commits: ($cm[0] // []),
    mergeable: (if .mergeable == true then "MERGEABLE" elif .mergeable == false then "CONFLICTING" else "UNKNOWN" end),
    mergeStateStatus: ((.mergeable_state // "unknown") | ascii_upcase)
  }' "$TMP/prmeta.json" > "$TMP/pr.json" \
  || { echo "pr-sweep: failed to build pr.json from REST"; exit 3; }

# `gh pr view --json comments/reviews` silently CAPS both lists at 100. A PR past that
# (e.g. #2083 after 8 review rounds, 2026-07-17) got a truncated sweep that read as complete —
# the newest comments/reviews were invisible. Re-fetch BOTH channels
# via the paginated REST API and splice them into pr.json in the shape the report expects.
gh api "repos/$NWO/issues/$PR/comments?per_page=100" --paginate 2>"$TMP/err" \
  | jq -s '[add[]? | {author: {login: (.user.login // "?")}, createdAt: (.created_at // ""), body: (.body // "")}]' \
  > "$TMP/comments.json" \
  || { echo "pr-sweep: paginated comments fetch failed:"; cat "$TMP/err"; exit 3; }
gh api "repos/$NWO/pulls/$PR/reviews?per_page=100" --paginate 2>"$TMP/err" \
  | jq -s '[add[]? | {author: {login: (.user.login // "?")}, submittedAt: (.submitted_at // ""), state: (.state // ""), body: (.body // "")}]' \
  > "$TMP/reviews.json" \
  || { echo "pr-sweep: paginated reviews fetch failed:"; cat "$TMP/err"; exit 3; }
jq --slurpfile c "$TMP/comments.json" --slurpfile r "$TMP/reviews.json" \
  '.comments = $c[0] | .reviews = $r[0]' "$TMP/pr.json" > "$TMP/pr2.json" \
  && mv "$TMP/pr2.json" "$TMP/pr.json" \
  || { echo "pr-sweep: failed to splice paginated channels"; exit 3; }

OWNER="${NWO%%/*}"; REPO="${NWO##*/}"
gh api graphql -f query='
  query($owner:String!, $repo:String!, $pr:Int!) {
    repository(owner:$owner, name:$repo) {
      pullRequest(number:$pr) {
        reviewThreads(first:100) {
          totalCount
          nodes {
            isResolved isOutdated path
            comments(first:1) { nodes { author { login } body createdAt } }
          }
        }
      }
    }
  }' -F owner="$OWNER" -F repo="$REPO" -F pr="$PR" > "$TMP/threads.json" 2>"$TMP/err2" \
  || { echo "pr-sweep: reviewThreads fetch failed:"; cat "$TMP/err2"; exit 3; }

# ── Ownership (informational; honors pr-ownership.md) ─────────────────────────────────
OWN_SH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/pr-own.sh"
if [ -x "$OWN_SH" ]; then
  echo "── Ownership: $("$OWN_SH" check "$PR" 2>/dev/null || true)"
  echo
fi

# ── (d) code-scanning alerts + (e) checks at HEAD (added 2026-08-15, HED-16 — the heddle det tier
# reports through code scanning, not PR comments). Code scanning fails CLOSED unless its error text
# is the one benign no-code-scanning signal (SPI-924); checks remain informational.
CS_ERR=""; CS_JSON=""; SWEEP_CS_STATUS="error"
_cs_api() {
  gh api "repos/$OWNER/$REPO/code-scanning/alerts?pr=$PR&state=open&per_page=100" 2>"$TMP/cs.err"
}
# Capture GitHub's error text on EVERY failure branch (incl. notenabled) so the report can show the
# exact message that drove the classification — audit/observability (codacy + qodo, PR #27).
_cs_grab_err() { CS_ERR=$(head -c 200 "$TMP/cs.err" | tr '\n' ' '); }
if CS_JSON=$(_cs_api); then
  SWEEP_CS_STATUS="ok"
elif python3 -B "$SCRIPT_DIR/pr_sweep_cs.py" is-not-enabled "$TMP/cs.err"; then
  SWEEP_CS_STATUS="notenabled"; _cs_grab_err
else
  sleep 2
  if CS_JSON=$(_cs_api); then
    SWEEP_CS_STATUS="ok"
  elif python3 -B "$SCRIPT_DIR/pr_sweep_cs.py" is-not-enabled "$TMP/cs.err"; then
    SWEEP_CS_STATUS="notenabled"; _cs_grab_err
  else
    CS_JSON=""; _cs_grab_err
  fi
fi
export SWEEP_CS_JSON="${CS_JSON:-}" SWEEP_CS_ERR="${CS_ERR:-}" SWEEP_CS_STATUS
# Checks at HEAD via REST (HED-269): check-runs + legacy commit statuses, merged into the
# {name/context, conclusion/state/status} shape the report already accepts (it .upper()s and treats
# SUCCESS/SKIPPED/NEUTRAL as green). HEAD sha from the REST pr.json above.
HEAD_SHA=$(jq -r '.headRefOid // ""' "$TMP/pr.json" 2>/dev/null)
if [ -n "$HEAD_SHA" ]; then
  _CR=$(gh api "repos/$NWO/commits/$HEAD_SHA/check-runs?per_page=100" --paginate 2>/dev/null \
        | jq -s '[.[].check_runs[]? | {name, status, conclusion}]' 2>/dev/null)
  _ST=$(gh api "repos/$NWO/commits/$HEAD_SHA/status?per_page=100" --paginate 2>/dev/null \
        | jq -s '[.[].statuses[]? | {context, state}]' 2>/dev/null)
  CHECKS_JSON=$(jq -cn --argjson a "${_CR:-[]}" --argjson b "${_ST:-[]}" '$a + $b' 2>/dev/null) || CHECKS_JSON=""
else
  CHECKS_JSON=""
fi
# Merge-state is the AUTHORITY on required checks (S, HED-142 live validation 2026-08-18): GitHub's
# ruleset resolves required contexts from the newest check SUITE, while the REST check list above keys
# on newest RUN — on slow builds they diverge and the checks can read green while the PR is blocked.
MERGESTATE_JSON=$(jq -c '{mergeable, mergeStateStatus}' "$TMP/pr.json" 2>/dev/null) || MERGESTATE_JSON=""
export SWEEP_CHECKS_JSON="${CHECKS_JSON:-}"
export SWEEP_MERGESTATE_JSON="${MERGESTATE_JSON:-}"

# ── Report + mechanical gates ──────────────────────────────────────────────────────────
python3 -B - "$TMP/pr.json" "$TMP/threads.json" "$SCRIPT_DIR" <<'PYEOF'
import json, os, re, sys
from datetime import datetime, timezone

sys.path.insert(0, sys.argv[3])
from pr_sweep_cap_notice import is_cap_notice, render_demoted
from pr_sweep_cs import classify_cs

pr = json.load(open(sys.argv[1]))
th = json.load(open(sys.argv[2]))

def ts(s):
    try: return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception: return None

def excerpt(body, n=110):
    line = next((l.strip() for l in (body or "").splitlines() if l.strip()), "")
    return (line[:n] + "…") if len(line) > n else (line or "(empty)")

head = pr.get("headRefOid") or ""
commits = pr.get("commits") or []
last_push = max((ts(c.get("committedDate", "")) for c in commits if ts(c.get("committedDate", ""))), default=None)

print(f"══ PR #{pr['number']} — {pr.get('title','')!s}  [{pr.get('state','')}]")
print(f"   HEAD {head[:12]}   last commit {last_push.isoformat() if last_push else '?'}")
print()

late_items = []
demoted = []  # (login, body, after_push) — cap notices shown collapsed in a VISIBLE group, never dropped

# (a) issue comments — every author
comments = pr.get("comments") or []
print(f"── (a) Issue comments: {len(comments)}")
for c in comments:
    a = (c.get("author") or {}).get("login", "?")
    t = c.get("createdAt", "")
    body = (c.get("body") or "").strip()
    if is_cap_notice(a, body):
        demoted.append((a, body, bool(last_push and ts(t) and ts(t) > last_push), t, "comment"))
        continue
    flag = ""
    if last_push and ts(t) and ts(t) > last_push:
        flag = "  ⏰ AFTER last push"; late_items.append(f"comment by {a}")
    if body.startswith("<!-- PR-OWNER"):
        flag += "  [ownership marker]"
    print(f"   • {a}  {t}{flag}\n     {excerpt(body)}")
print()

# (b) reviews — non-empty body = finding, unless a disposition RECEIPT covers it.
# Receipt convention (2026-07-19, #2203-era): an issue comment containing
#   <!-- dispositioned: <login> <submittedAt> -->
# marks that EXACT review body as read+addressed (put one marker line per
# review in your disposition comment; login + timestamp exactly as this
# sweep prints them). Keyed on author+timestamp, so a LATER review by the
# same author still flags — completeness is preserved; only re-reading the
# same already-dispositioned body every round is eliminated.
# Login normalization: REST review objects carry `foo[bot]`, GraphQL carries
# `foo` — accept either spelling in the marker so a receipt generated from
# `gh pr view --json reviews` still matches the sweep's REST-merged rows.
def _norm(login):
    return login[:-5] if login.endswith("[bot]") else login
receipts = set()
for c in comments:
    for m in re.finditer(r"<!--\s*dispositioned:\s*(\S+)\s+(\S+)\s*-->", c.get("body", "")):
        receipts.add((_norm(m.group(1)), m.group(2)))
reviews = pr.get("reviews") or []
nonempty = []
print(f"── (b) Reviews: {len(reviews)}")
for r in reviews:
    a = (r.get("author") or {}).get("login", "?")
    t = r.get("submittedAt", "") or ""
    state = r.get("state", "")
    body = (r.get("body") or "").strip()
    flags = []
    if is_cap_notice(a, body):
        demoted.append((a, body, bool(last_push and ts(t) and ts(t) > last_push), t, f"review {state}".strip()))
        continue
    if last_push and ts(t) and ts(t) > last_push:
        flags.append("⏰ AFTER last push"); late_items.append(f"review by {a}")
    if body:
        if (_norm(a), t) in receipts:
            flags.append("✓ dispositioned (receipt on record)")
        else:
            nonempty.append(a)
            flags.append("📝 NON-EMPTY BODY — read it")
    print(f"   • {a}  {state}  {t}  {' '.join(flags)}")
    if body:
        print(f"     {excerpt(body)}")
print()

# (c) inline threads
nodes = th["data"]["repository"]["pullRequest"]["reviewThreads"]["nodes"]
total = th["data"]["repository"]["pullRequest"]["reviewThreads"]["totalCount"]
unresolved = [n for n in nodes if not n.get("isResolved")]
print(f"── (c) Inline review threads: {total} total, {len(unresolved)} UNRESOLVED")
for n in unresolved:
    c0 = (n.get("comments", {}).get("nodes") or [{}])[0]
    a = (c0.get("author") or {}).get("login", "?")
    print(f"   ✗ {n.get('path','?')}  by {a}{'  (outdated)' if n.get('isOutdated') else ''}\n     {excerpt(c0.get('body',''))}")
thread_overflow = total > len(nodes)
if thread_overflow:
    print(f"   ⚠️ only first {len(nodes)} threads fetched — {total - len(nodes)} more exist; check the PR page")
print()

# ── (d) code-scanning alerts OPEN for this PR (heddle det tier: semgrep/gitleaks/zizmor SARIF) ──
cs_alerts, cs_unavailable, cs_error = classify_cs(
    os.environ.get("SWEEP_CS_STATUS", ""),
    os.environ.get("SWEEP_CS_JSON", ""),
)
if cs_unavailable:
    err = os.environ.get("SWEEP_CS_ERR", "").strip()
    print("── (d) Code-scanning alerts: code scanning is NOT ENABLED on this repo — benign, pass-by-silence" + (f" — {err[:120]}" if err else ""))
    print("   (only the explicit not-enabled/disabled signal reaches here — permission/transient errors FAIL CLOSED as an API error below; if this repo DOES upload SARIF, that's a misconfig to fix)")
elif cs_error:
    err = os.environ.get("SWEEP_CS_ERR", "").strip()
    print("── (d) Code-scanning API ERROR (not the not-enabled signal) — FAIL-CLOSED" + (f" — {err[:120]}" if err else ""))
else:
    print(f"── (d) Code-scanning alerts OPEN for this PR: {len(cs_alerts)}")
    for a in cs_alerts[:25]:
        tool = ((a.get("tool") or {}).get("name") or "?")
        rule = ((a.get("rule") or {}).get("id") or "?")
        loc = ((a.get("most_recent_instance") or {}).get("location") or {})
        sev = ((a.get("rule") or {}).get("security_severity_level") or (a.get("rule") or {}).get("severity") or "")
        print(f"   ✗ #{a.get('number','?')} [{tool}] {rule} — {loc.get('path','?')}:{loc.get('start_line','?')} {('('+sev+')') if sev else ''}  {a.get('html_url','')}")
    if len(cs_alerts) > 25:
        print(f"   … {len(cs_alerts)-25} more — see the Security tab")
print()

# ── (e) checks at HEAD — non-green ones (informational: required-ness unknown; some are red by design) ──
_ck = os.environ.get("SWEEP_CHECKS_JSON", "")
_ms = os.environ.get("SWEEP_MERGESTATE_JSON", "")
try:
    checks = json.loads(_ck) if _ck.strip() else []
except Exception:
    checks = []
GREEN = {"SUCCESS", "SKIPPED", "NEUTRAL"}
nongreen = []
for c in checks or []:
    name = c.get("name") or c.get("context") or "?"
    concl = (c.get("conclusion") or c.get("state") or c.get("status") or "").upper()
    if concl not in GREEN:
        nongreen.append((name, concl or "?"))
print(f"── (e) Checks at HEAD: {len(checks or [])} total, {len(nongreen)} non-green")
for name, concl in nongreen[:30]:
    print(f"   • {name}: {concl}")
if checks and not nongreen:
    print("   ✓ all green (or skipped)")
print()

# ── Demoted rate-limit / cap notices (VISIBLE, collapsed — NEVER dropped; skim before clean) ──
_demoted_block = render_demoted(demoted)
if _demoted_block:
    print(_demoted_block)
    print()

# ── Mechanical verdict ──
fails = []
if unresolved: fails.append(f"{len(unresolved)} unresolved inline thread(s)")
if thread_overflow: fails.append("inline-thread list truncated at 100 — sweep is INCOMPLETE")
if cs_alerts:  fails.append(f"{len(cs_alerts)} OPEN code-scanning alert(s) for this PR (fix, or dismiss with a reason)")
if cs_error: fails.append("code-scanning API error — retried once, still failing; failing closed, no scan confirmed (SPI-924)")
print("══ MECHANICAL VERDICT")
if fails:
    print("   ✗ NOT CLEAN: " + "; ".join(fails))
else:
    print("   ✓ mechanical gates pass (0 unresolved threads; 0 open code-scanning alerts" + (" — code scanning unavailable, checked by hand?" if cs_unavailable else "") + ")")
if nonempty:
    print(f"   📝 {len(nonempty)} non-empty review bod{'y' if len(nonempty)==1 else 'ies'} to read/address: {', '.join(sorted(set(nonempty)))}")
if late_items:
    print(f"   ⏰ {len(late_items)} item(s) landed after the last push — bots land late; re-sweep before declaring clean")
if nongreen:
    print(f"   🔴 {len(nongreen)} non-green check(s) at HEAD — read (e) above; only the ruleset knows which are required, and some are red by design")
# Merge-state authority line (S, HED-142): rollup green ≠ mergeable. The ruleset reads the newest
# check SUITE; the rollup reads newest RUN. Print the authority, and scream on divergence.
try:
    _msd = json.loads(_ms) if _ms.strip() else {}
except Exception:
    _msd = {}
if _msd:
    _mg, _mss = _msd.get("mergeable", "?"), _msd.get("mergeStateStatus", "?")
    print(f"   ⚖️  merge-state AUTHORITY: mergeable={_mg} state={_mss} (UNKNOWN = still computing — poll before trusting)")
    if _mss == "BLOCKED" and not nongreen:
        print("   🚨 DIVERGENCE: rollup reads green but merge-state is BLOCKED — the ruleset sees a failing/absent required context in the NEWEST SUITE (gh pr checks keys on newest RUN and can lie here). Do NOT trust the green; see HED-142 suite-vs-run semantics.")
# (Retired 2026-08-20, SPI-920: the elastic review-runner-pool 🐏/🐑 hints are gone — the self-hosted
#  review pool no longer runs review jobs post-reset. Any gate-pool scaling guidance is SPI-902's.)
print("   Reminder: the script proves completeness, not judgment — read every item above.")
sys.exit(2 if fails else 0)
PYEOF
