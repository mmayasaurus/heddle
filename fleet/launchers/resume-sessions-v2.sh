#!/usr/bin/env bash
# resume-sessions-v2.sh
# Restart the whole Claude Code agent fleet (single-letter agents, A–Q as of 2026-07-24)
# each in its own terminal tab, resuming the EXACT prior session with its name intact.
#
# Why a v2 (vs resume-sessions.sh):
#   The old script hard-coded session IDs and resumed them ALL from the workspace
#   root. That only works if every session's on-disk history lives under the root
#   project dir. It doesn't anymore: a Claude Code session is stored under
#   ~/.claude/projects/<sanitized-cwd>/<id>.jsonl, and `/cd` RELOCATES that file
#   when an agent changes directory. So the fleet is now split — some sessions live
#   under their worktree dir, some under the root — and each MUST be resumed from the
#   directory whose path maps to where its .jsonl physically sits, or `--resume`
#   silently won't find it.
#
# What this script does instead (no hard-coding, re-derived every run):
#   1. Scans ~/.claude/projects for labelled sessions and keeps the CURRENT FLEET
#      GENERATION: every label whose freshest session is within FLEET_SPAN_HOURS
#      (default 168h) of the NEWEST labelled session. The window is anchored to the
#      fleet's own last activity, not the wall clock, so the whole fleet is found
#      no matter how long the machine sat idle. (Setting MAX_AGE_HOURS forces the
#      old absolute now-minus-N-hours filter; a 90-day hard cap keeps old archives
#      from resurrecting.)
#   2. Keeps the ones Claude Code labelled via /rename with a short tag (A..Z) —
#      that tag is persisted in the .jsonl as a `custom-title` record, so it survives
#      resume and is what we read back here.
#   3. For each agent it computes the SAFE resume directory: the cwd recorded inside
#      the freshest .jsonl whose sanitized form equals that file's actual project dir
#      (i.e. where the file physically lives — not the agent's last transient cwd,
#      which is often a subdir like node_modules or a scratchpad).
#   4. Opens one tab per agent, in A→Z order, titled with the agent tag, running
#      `cd <safe-cwd> && claude --model <m> --effort <e> --resume <id>`.
#
# MODEL / EFFORT (Maya-directed):
#   The fleet defaults to claude-opus-4-8 @ high. Only the explicit TAIL_AGENTS Fable set
#   (default R Y) uses claude-fable-5 @ max. `--model` overrides a resumed session's saved
#   model, so every relaunch applies this economy. Set TAIL_AGENTS to choose a different
#   explicit Fable set; TAIL_MODEL and TAIL_EFFORT customize that set when needed.
#
# Result: correct resume for moved-worktree agents, deterministic A→Z tab order, and
# names intact both on the terminal tab (set here) AND inside Claude Code (its own
# /rename custom-title replays from the session file).
#
# ACCOUNT SWITCH: select a logged-in registry account with --account <id> or
# FLEET_ACCOUNT=<id> (the flag wins). Its config directory must first share
# ~/.claude/projects, ~/.claude/sessions, and ~/.claude/settings.json via
# .claude/bin/heddle-account-share.sh <id>; .claude.json deliberately stays per-dir.
# HEDDLE HOME: heddle-fleet letters (R..Z, case-insensitive exact) always resume with cwd forced to
# $HEDDLE_HOME — claude >= 2.1.223 documents cross-project --resume (installed 2.1.240), and the
# session's ambient context (CLAUDE.md, project MCPs) follows the resume-time cwd.
# With no account selection, the launcher batch-picks accounts for the final discovered set via
# `heddle account pick --for <labels> --json`; it never resumes on a tab's stale implicit account.
# HEDDLE_CLI_OVERRIDE=<executable> is test-only: it replaces the default CLI path so picker
# refusal handling can be exercised without changing real account meters.
#
# FLEET COMMS: set --comms push|pull|off or FLEET_COMMS=push|pull|off (the flag wins).
# Push is the default: every tab joins heddle-comms and receives live broadcast injection;
# Claude Code shows one development-channels consent screen per tab (one keypress each).
# Pull joins the same rooms but does not inject broadcasts live: agents use check_inbox,
# read_transcript, and post_message for full room membership. Off preserves the pre-comms
# launcher command exactly (no comms environment, MCP definition, or channels flag).
#
# Usage:
#   bash resume-sessions-v2.sh            # show the discovered fleet, confirm, open tabs
#   bash resume-sessions-v2.sh --list     # print the discovered table + commands, open nothing
#   bash resume-sessions-v2.sh --list --only U  # batch-pick and show U's account, open nothing
#   bash resume-sessions-v2.sh --account acct3 --only G  # pin every launched tab to acct3
#   FLEET_ACCOUNT=acct3 bash resume-sessions-v2.sh -y    # same account selection via environment
#   bash resume-sessions-v2.sh --comms pull --only G     # join heddle-comms without live push injection
#   FLEET_COMMS=off bash resume-sessions-v2.sh --list    # inspect the legacy no-comms composition
#   bash resume-sessions-v2.sh -y         # skip the confirmation prompt
#   bash resume-sessions-v2.sh --only G   # open JUST agent G (test one before all 12)
#   FLEET_SPAN_HOURS=336 bash resume-sessions-v2.sh  # widen the fleet-generation span
#   MAX_AGE_HOURS=72 bash resume-sessions-v2.sh   # force the old absolute-window filter
#   SKIP_PERMS='' bash resume-sessions-v2.sh      # resume WITHOUT --dangerously-skip-permissions
#   TAIL_AGENTS='O Q' bash resume-sessions-v2.sh  # use Fable @ max for O and Q instead of R and Y
#   TAIL_MODEL=claude-fable-5 TAIL_EFFORT=max bash resume-sessions-v2.sh  # customize the explicit Fable set
#   FLEET_MODEL=claude-opus-4-8 FLEET_EFFORT=high bash resume-sessions-v2.sh  # pin the non-Fable fleet
#   FLEET_SETTINGS_FILE=~/.heddle/s3b-recorder.settings.json bash resume-sessions-v2.sh  # S3b pocket-prompt overlay (DEFAULT OFF; Maya's activation lever)
#   EXPECTED_AGENTS=18 bash resume-sessions-v2.sh # raise the "fleet looks short" floor as it grows
#   RESTORE_WORKTREES=1 bash resume-sessions-v2.sh # if a worktree is gone, `git worktree add` it back
#                                                  # (default: recreate an empty dir so resume still works)
#   NOTE: in the default LABEL_MODE=letters these run the single-letter fleet only; pure-digit
#         /rename tags (the claudex GPT-5.6 numbered fleet) are excluded. resume-sessions-gpt.sh
#         drives THIS engine with LABEL_MODE=digits + FLEET_BIN=claudex + MODEL_PINS=off to launch
#         that fleet — one engine since HED-306 (no separate fork).
set -euo pipefail

# ---- arg parse: --only <LABEL> filters; --account <ID> pins launched tabs ------------
ONLY=""
ACCOUNT_FLAG=""
COMMS_FLAG=""
ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --only)
      [[ -n "${2:-}" ]] || { echo "--only requires one quoted comma/space-separated label list." >&2; exit 2; }
      ONLY="$2"; shift 2
      ;;
    --account)
      [[ -n "${2:-}" ]] || { echo "--account requires an id." >&2; exit 2; }
      ACCOUNT_FLAG="$2"; shift 2
      ;;
    --comms)
      [[ -n "${2:-}" ]] || { echo "--comms requires push, pull, or off." >&2; exit 2; }
      COMMS_FLAG="$2"; shift 2
      ;;
    *) ARGS+=("$1"); shift ;;
  esac
done
set -- "${ARGS[@]+"${ARGS[@]}"}"

WORKDIR="/Users/mayatobi/Developer/Spinventory-Rebuild-App"
INNER_REPO="$WORKDIR/Spinventory-Rebuild-Official/Rebuild-Project-Root"   # the repo the worktrees belong to
FLEET_BIN="${FLEET_BIN:-claude}"   # override to `claudex` for the numbered/proxy fleet (resume-sessions-gpt.sh)
CLAUDE_BIN="$(command -v "$FLEET_BIN" || echo "$HOME/.local/bin/$FLEET_BIN")"
PROJECTS="$HOME/.claude/projects"
ACCOUNTS_FILE="$HOME/.heddle/accounts.json"
HEDDLE_CLI_PATH="${HEDDLE_CLI_OVERRIDE:-$HOME/Developer/heddle/dist/cli.js}"
# ACCOUNT_MODE — how tabs are assigned to accounts when NO --account pin is given (a pin always wins):
#   picker (default) — ask the heddle CLI headroom router (`heddle account pick`). Best when meters are
#                      fresh; but it EXCLUDES accounts whose usage meter is stale/missing, so after an
#                      idle stretch (the usual bulk-resume case) it collapses the fleet onto the one
#                      account with a live meter (all N tabs on acct1). See spread_accounts().
#   spread          — meter-INDEPENDENT even split across the logged-in accounts in $ACCOUNTS_FILE.
#                      resume-sessions-hed.sh defaults to this. --account still overrides it.
ACCOUNT_MODE="${ACCOUNT_MODE:-picker}"
FLEET_ACCOUNT_ID="${ACCOUNT_FLAG:-${FLEET_ACCOUNT:-}}"
FLEET_COMMS="${COMMS_FLAG:-${FLEET_COMMS:-push}}"
ACCOUNT_CONFIG_DIR=""
ACCOUNT_EMAIL=""
ACCOUNT_LABEL="default"
BATCH_ACCOUNT_MAP=""
BATCH_ACCOUNT_JSON=""
# Discovery window: default is fleet-generation mode — anchor on the NEWEST labelled session
# and keep labels last active within FLEET_SPAN_HOURS of it (survives any idle gap; 90-day
# hard cap). Setting MAX_AGE_HOURS forces an absolute now-minus-N-hours window instead (the
# old 48h default silently shrank the fleet to 1 agent after a 3-day break — 2026-07-11 bug).
MAX_AGE_HOURS="${MAX_AGE_HOURS:-}"
FLEET_SPAN_HOURS="${FLEET_SPAN_HOURS:-168}"
# If a session's directory is gone (worktree removed), resume is impossible until a directory
# exists again at that exact path (resume is cwd-scoped — verified). By default we recreate an
# EMPTY dir there (proven sufficient for --resume) and print the git command to restore the files.
# Set RESTORE_WORKTREES=1 to instead auto-run `git worktree add <path> <branch>` for a full restore.
RESTORE_WORKTREES="${RESTORE_WORKTREES:-}"
# Fleet agents run bypassed; set SKIP_PERMS='' to resume with normal permission prompts.
SKIP_PERMS="${SKIP_PERMS:---dangerously-skip-permissions}"
# Fleet split (2026-08-15): LABEL_FILTER = optional space-separated tag whitelist — the
# resume-sessions-spi.sh (A–Q) / resume-sessions-hed.sh (R+) wrappers use it to launch one
# project's fleet at a time. EXTRA_ENV = optional 'VAR=val' exported in each tab before claude
# starts (the HED wrapper sets LIN_TEAM=HED so those agents default to the Heddle Linear team).
LABEL_FILTER="${LABEL_FILTER:-}"
EXTRA_ENV="${EXTRA_ENV:-}"
# LABEL_MODE selects the tag CLASS this run resumes: 'letters' (single-letter agents A..Z, the
# default) or 'digits' (the claudex numbered fleet 1..FLEET_MAX — resume-sessions-gpt.sh sets this).
LABEL_MODE="${LABEL_MODE:-letters}"
FLEET_MAX="${FLEET_MAX:-6}"     # digit mode only: the numbered fleet is 1..FLEET_MAX
# The only Heddle-specific variables introduced per tab are HEDDLE_AGENT and, for push mode,
# HEDDLE_COMMS_PUSH. Do not add role or token environment variables here.
HEDDLE_COMMS_SERVER="/Users/mayatobi/Developer/heddle/dist/comms/channel-server.js"
# CAVEAT: resolving a server:<name> development channel from an --mcp-config-registered server
# is undocumented. If a one-tab test does not load the channel, use a user-scope or per-cwd
# .mcp.json entry instead of --mcp-config.
# ---- model + reasoning effort per agent ------------------------------------------
# MODEL ECONOMY (Maya, firsthand 2026-08-29): the fleet resumes on Opus 4.8 @ high. Opus 4.8 is
# 200K native / 1M on Max; the [1m] suffix makes the 1M window explicit and tier-proof.
# LIVE-VERIFIED 2026-09-05: `claude -p --model 'claude-opus-4-8[1m]' --output-format json` returns
# modelUsage key 'claude-opus-4-8[1m]' with is_error false. ONLY the letters in TAIL_AGENTS (default
# 'R Y') get TAIL_MODEL = Fable 5 @ max. TAIL_MODEL stays claude-fable-5: Fable 5 is 1M native and
# no suffix is documented for it. Opus 5 is NEVER used in this repo. The previous default (whole
# fleet on Fable @ max) silently re-pinned every agent to the most expensive tier on every relaunch
# for a week and burned real-money overage. `--model` overrides the model saved in the session file,
# so this re-pins it every resume.
# Effort levels accepted by `claude --effort`: low | medium | high | xhigh | max.
FLEET_MODEL="${FLEET_MODEL:-claude-opus-4-8[1m]}"
FLEET_EFFORT="${FLEET_EFFORT:-high}"
FLEET_SETTINGS_FILE="${FLEET_SETTINGS_FILE:-}"
TAIL_MODEL="${TAIL_MODEL:-claude-fable-5}"
TAIL_EFFORT="${TAIL_EFFORT:-max}"
TAIL_AGENTS="${TAIL_AGENTS:-R}"  # R ONLY (Maya, firsthand 2026-09-06: Y off Fable — she found Y pinned and switched it; never again)  # the explicit Fable set (Maya's economy: R + Y only)
# MODEL_PINS=off (claudex/proxy fleet): emit no --model/--effort and drop the MODEL/EFFORT column —
# the proxy selects the model, so pinning one is meaningless. Default 'on' keeps letter-fleet behavior.
MODEL_PINS="${MODEL_PINS:-on}"
# Floor for the completeness check below: warn if FEWER than this many agents turn up (a
# truncated discovery window). Bump it as the fleet grows; finding more never warns.
EXPECTED_AGENTS="${EXPECTED_AGENTS:-17}"

die() { echo "ERROR: $*" >&2; exit 1; }

# HED-482: a fleet launched without its explicit S3b recorder overlay is a silent policy miss;
# fail before discovery, account picking, or any tab launch, matching the forbidden-model guards.
# The die messages render the value via %q so a newline/ANSI-bearing path cannot forge extra
# stderr lines (PR #62 adversarial review, finding 6).
if [[ -n "$FLEET_SETTINGS_FILE" ]]; then
  [[ -f "$FLEET_SETTINGS_FILE" && -r "$FLEET_SETTINGS_FILE" ]] || die "FLEET_SETTINGS_FILE=$(printf '%q' "$FLEET_SETTINGS_FILE") is set but not a readable file"
  # Finding 1 (HIGH): a relative path validates against the LAUNCHER's cwd but executes after
  # `cd <agent-cwd>` inside the tab — a different file (or none) would load than the one that
  # passed the fail-loud check. Canonicalize once here; every tab gets the vetted absolute path.
  FLEET_SETTINGS_FILE="$(cd -- "$(dirname -- "$FLEET_SETTINGS_FILE")" && pwd)/$(basename -- "$FLEET_SETTINGS_FILE")"
  # Finding 2: the emitted word runs in an INTERACTIVE tab shell whose rc may enable zsh
  # expansions that bash's %q does not quote (^ under extended_glob, leading = equals-expansion,
  # ! history expansion). Rather than gamble on quoting for every rc, allow only characters
  # proven to round-trip both shells (the suite executes them) and die loudly on the rest.
  case "$FLEET_SETTINGS_FILE" in
    *[!]A-Za-z0-9/._,+@%\ [-]*) die "FLEET_SETTINGS_FILE=$(printf '%q' "$FLEET_SETTINGS_FILE") contains characters unsafe for tab-shell emission (allowed: letters digits space and / . _ , + @ % [ ] -)" ;;
  esac
fi

trim_model() {
  printf '%s' "$1" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//'
}

FLEET_MODEL="$(trim_model "$FLEET_MODEL")"
TAIL_MODEL="$(trim_model "$TAIL_MODEL")"
FLEET_MODEL_MATCH="$(printf '%s' "$FLEET_MODEL" | tr '[:upper:]' '[:lower:]')"
TAIL_MODEL_MATCH="$(printf '%s' "$TAIL_MODEL" | tr '[:upper:]' '[:lower:]')"

# Reject the previous expensive defaults before discovery or account picking can launch anything.
# Fable is valid only as the explicit per-agent tail model; a fleet-wide Fable pin is forbidden.
case "$FLEET_MODEL_MATCH" in
  *opus-5*|*opus5*) die "FLEET_MODEL='$FLEET_MODEL' is forbidden; unset FLEET_MODEL or use claude-opus-4-8 for the fleet and reserve claude-fable-5 for TAIL_MODEL." ;;
  *fable-5*|*fable5*) die "FLEET_MODEL='$FLEET_MODEL' is forbidden; unset FLEET_MODEL or use claude-opus-4-8 for the fleet and set TAIL_MODEL=claude-fable-5 only for explicit TAIL_AGENTS." ;;
esac
case "$TAIL_MODEL_MATCH" in
  *opus-5*|*opus5*) die "TAIL_MODEL='$TAIL_MODEL' is forbidden; unset TAIL_MODEL or use claude-fable-5 for the explicit TAIL_AGENTS set." ;;
esac

for arg in ${ARGS[@]+"${ARGS[@]}"}; do
  case "$arg" in
    --list|-y) ;;
    *) die "unexpected positional argument '$arg'; --only accepts one quoted comma/space-separated label list (for example: --only \"S T\")." ;;
  esac
done

cleanup_batch_account_files() {
  [[ -n "$BATCH_ACCOUNT_MAP" && -f "$BATCH_ACCOUNT_MAP" ]] && rm -f "$BATCH_ACCOUNT_MAP"
  [[ -n "$BATCH_ACCOUNT_JSON" && -f "$BATCH_ACCOUNT_JSON" ]] && rm -f "$BATCH_ACCOUNT_JSON"
}
trap cleanup_batch_account_files EXIT
trap 'cleanup_batch_account_files; trap - EXIT; exit 129' HUP
trap 'cleanup_batch_account_files; trap - EXIT; exit 130' INT
trap 'cleanup_batch_account_files; trap - EXIT; exit 143' TERM

is_list_mode() { [[ "${1:-}" == "--list" ]]; }

case "$FLEET_COMMS" in
  push|pull|off) ;;
  *) die "--comms/FLEET_COMMS must be push, pull, or off (got '$FLEET_COMMS')." ;;
esac

case "$LABEL_MODE" in
  letters|digits) ;;
  *) die "LABEL_MODE must be 'letters' or 'digits' (got '$LABEL_MODE')." ;;
esac
# FLEET_MAX is a digit-mode-only knob — validate it here so a misconfigured range fails loudly, and
# never let an ambient non-numeric value break the letter-fleet (SPI/HED) launchers.
if [[ "$LABEL_MODE" == "digits" && ! "$FLEET_MAX" =~ ^[1-9][0-9]*$ ]]; then
  die "digit mode requires a positive-integer FLEET_MAX (got '$FLEET_MAX')."
fi

if [[ "$FLEET_COMMS" != "off" && ! -f "$HEDDLE_COMMS_SERVER" ]]; then
  echo "WARNING: heddle comms server missing: $HEDDLE_COMMS_SERVER" >&2
  echo "WARNING: downgrading fleet comms to off; tabs will launch without a broken MCP definition." >&2
  FLEET_COMMS="off"
fi

print_comms_banner() {
  [[ "$FLEET_COMMS" != "off" ]] || return 0
  echo "fleet comms: $FLEET_COMMS (server: heddle-comms)"
  if [[ "$FLEET_COMMS" == "push" ]]; then
    echo "each tab shows a dev-channels consent screen on launch (one keypress per tab)"
  fi
}

resolve_selected_account() {
  [[ -n "$FLEET_ACCOUNT_ID" ]] || return 0
  [[ -f "$ACCOUNTS_FILE" ]] || die "account registry not found: $ACCOUNTS_FILE"
  local row
  row="$(FLEET_ACCOUNT_ID="$FLEET_ACCOUNT_ID" ACCOUNTS_FILE="$ACCOUNTS_FILE" python3 - <<'PY'
import json, os

with open(os.environ['ACCOUNTS_FILE']) as f:
    accounts = json.load(f).get('claude', [])
account_id = os.environ['FLEET_ACCOUNT_ID']
found = next((a for a in accounts if a.get('id') == account_id), None)
if found is None:
    print('UNKNOWN\t' + ', '.join(str(a.get('id', '')) for a in accounts if a.get('id')))
else:
    print('\t'.join([
        str(found.get('id', '')), str(found.get('configDir') or ''),
        str(found.get('email') or ''), 'true' if found.get('loggedIn') else 'false',
        str(found.get('note') or '').replace('\n', ' '),
    ]))
PY
)" || die "could not read account registry: $ACCOUNTS_FILE"
  if [[ "$row" == UNKNOWN$'\t'* ]]; then
    die "unknown fleet account '$FLEET_ACCOUNT_ID'. Known ids: ${row#*$'\t'}"
  fi
  local logged_in note
  IFS=$'\t' read -r ACCOUNT_LABEL ACCOUNT_CONFIG_DIR ACCOUNT_EMAIL logged_in note <<< "$row"
  [[ "$logged_in" == "true" ]] || die "fleet account '$ACCOUNT_LABEL' is marked loggedIn:false. ${note:-Log into that config directory first.}"
  if [[ -n "$ACCOUNT_CONFIG_DIR" ]]; then
    local name target link auth_json auth_fields auth_email auth_logged_in
    for name in projects sessions settings.json; do
      target="$HOME/.claude/$name"
      link="$ACCOUNT_CONFIG_DIR/$name"
      [[ -L "$link" && "$(readlink "$link")" == "$target" ]] || \
        die "fleet account '$ACCOUNT_LABEL' is not shared correctly; run .claude/bin/heddle-account-share.sh $ACCOUNT_LABEL first"
    done
    auth_json="$(CLAUDE_CONFIG_DIR="$ACCOUNT_CONFIG_DIR" "$CLAUDE_BIN" auth status)" || :
    auth_fields="$(printf '%s' "$auth_json" | python3 -c '
import json, sys
data = json.load(sys.stdin)
print(("true" if data.get("loggedIn") else "false") + "\t" + (data.get("email") or ""))
')" || die "claude auth status did not return JSON for fleet account '$ACCOUNT_LABEL'"
    IFS=$'\t' read -r auth_logged_in auth_email <<< "$auth_fields"
    [[ "$auth_logged_in" == "true" ]] || die "claude auth status reports loggedIn:false for fleet account '$ACCOUNT_LABEL'"
    if [[ -n "$ACCOUNT_EMAIL" && "$auth_email" != "$ACCOUNT_EMAIL" ]]; then
      echo "WARNING: FLEET ACCOUNT EMAIL MISMATCH — registry=$ACCOUNT_EMAIL auth=${auth_email:-<none>}" >&2
    fi
  fi
}

print_account_banner() {
  local usage_line
  if [[ -n "$ACCOUNT_CONFIG_DIR" ]]; then
    echo "fleet account: $ACCOUNT_LABEL $ACCOUNT_EMAIL ($ACCOUNT_CONFIG_DIR)"
  else
    echo "fleet account: $ACCOUNT_LABEL ${ACCOUNT_EMAIL:-<default>} (<default dir>)"
  fi
  [[ -n "$FLEET_ACCOUNT_ID" ]] || return 0
  usage_line="$(FLEET_ACCOUNT_ID="$ACCOUNT_LABEL" python3 - <<'PY'
import datetime as dt, json, os

# Both capture shapes use epoch SECONDS (numbers, not ISO): the statusline-tap file nests the
# window under rate_limits.five_hour and stamps capturedAt; the keeper anchor is flat
# {startedAt, resets_at, used}. Freshest capture wins — same rule as the window-keeper.
base = os.path.expanduser('~/.heddle/usage')
acct = os.environ['FLEET_ACCOUNT_ID']
rows = []
for name in ('claude-%s.json' % acct, 'claude-%s.keeper.json' % acct):
    try:
        with open(os.path.join(base, name)) as f:
            data = json.load(f)
    except (OSError, ValueError):
        continue
    fh = (data.get('rate_limits') or {}).get('five_hour') or {}
    used = fh.get('used_percentage', data.get('used'))
    resets = fh.get('resets_at') or data.get('resets_at')
    stamp = data.get('capturedAt') or data.get('startedAt') or 0
    if resets:
        rows.append((stamp, used, resets))
if not rows:
    raise SystemExit
stamp, used, resets = max(rows, key=lambda row: row[0])
reset_text = dt.datetime.fromtimestamp(resets).strftime('%H:%M')
state = 'resets' if resets > dt.datetime.now().timestamp() else 'EXPIRED at'
print('fleet usage: 5h %s%% used, %s %s (captured %s)' % (
    used if used is not None else '?', state, reset_text,
    dt.datetime.fromtimestamp(stamp).strftime('%H:%M') if stamp else '?'))
PY
)"
  [[ -n "$usage_line" ]] && echo "$usage_line"
}

spread_accounts() { # $1=comma-separated final labels — meter-INDEPENDENT even split (ACCOUNT_MODE=spread)
  # The bulk-resume-after-idle path. batch_pick_accounts (the headroom router) drops any account whose
  # usage meter is stale/missing (account-pick.ts: headroomPct===null → excluded), and after days idle
  # that is most of them — so the router's residency round-robin collapses onto the one account with a
  # live meter and the whole fleet lands on acct1. This path consults NO meters: it round-robins the
  # fleet into contiguous, as-even-as-possible blocks across the logged-in accounts in $ACCOUNTS_FILE
  # (registry order preserved; first labels → first account). Deliberate tradeoff: it does NOT honor
  # floored / dispatch-excluded / residency-cap state — there are no fresh meters to honor at resume
  # time; each resumed agent's own per-turn usage line + meter alerts are the safety net. Output is the
  # IDENTICAL BATCH_ACCOUNT_MAP TSV batch_pick_accounts writes (label<TAB>account<TAB>configDir<TAB>
  # unsetConfigDir), so build_cmd/lookup_batch_account consume it unchanged. --account <id> pins one
  # account and short-circuits this call (the caller gates on an empty FLEET_ACCOUNT_ID).
  BATCH_ACCOUNT_MAP="$(mktemp "${TMPDIR:-/tmp}/resume-sessions-v2-accounts.XXXXXX")" || die "could not create batch account map tempfile"
  # Also claim the JSON slot batch_pick_accounts uses (left empty here — spread reads no picker JSON) so
  # the shared EXIT-trap cleanup finds both files and the script exits 0 on success, exactly like the
  # picker path; without it the trap's final BATCH_ACCOUNT_JSON test is false and returns a stray exit 1.
  BATCH_ACCOUNT_JSON="$(mktemp "${TMPDIR:-/tmp}/resume-sessions-v2-picker.XXXXXX")" || die "could not create batch picker tempfile"
  ACCOUNTS_FILE="$ACCOUNTS_FILE" SPREAD_MAP="$BATCH_ACCOUNT_MAP" SPREAD_LABELS="$1" python3 - <<'PY' || die "spread_accounts could not assign accounts (see error above)"
import json, os
labels = [x for x in os.environ['SPREAD_LABELS'].split(',') if x]
try:
    with open(os.environ['ACCOUNTS_FILE']) as f:
        data = json.load(f)
except (OSError, ValueError) as exc:
    raise SystemExit('could not read account registry %s: %s' % (os.environ['ACCOUNTS_FILE'], exc))
accts = [a for a in (data.get('claude') or []) if a.get('loggedIn')]
if not accts:
    raise SystemExit('no logged-in Claude accounts in %s (spread mode needs at least one)' % os.environ['ACCOUNTS_FILE'])
if not labels:
    raise SystemExit('cannot spread accounts for an empty fleet')
K, N = len(accts), len(labels)
base, rem = divmod(N, K)                                    # first `rem` accounts carry one extra
sizes = [base + (1 if i < rem else 0) for i in range(K)]    # contiguous, as-even-as-possible blocks
rows, pos = [], 0
for i, acct in enumerate(accts):
    for _ in range(sizes[i]):
        label = labels[pos]; pos += 1
        cfg = acct.get('configDir')
        unset = cfg is None or cfg == ''                   # mirror account-pick.ts: unsetConfigDir = configDir===null
        aid = str(acct.get('id') or '<default>')
        fields = (label, aid, '' if unset else str(cfg), 'true' if unset else 'false')
        if any('\t' in v or '\n' in v or '\r' in v for v in fields):
            raise SystemExit('unsafe tab/newline in account registry entry for %s' % label)
        rows.append(fields)
        print('%s → %s (spread: even split across %d logged-in account(s))' % (label, aid, K))
with open(os.environ['SPREAD_MAP'], 'w') as out:
    for fields in rows:
        out.write('\t'.join(fields) + '\n')
PY
}

batch_pick_accounts() { # $1=comma-separated final labels
  local picker_status
  if [[ -n "${HEDDLE_CLI_OVERRIDE:-}" ]]; then
    [[ -x "$HEDDLE_CLI_PATH" ]] || die "heddle CLI override is not executable: $HEDDLE_CLI_PATH (pass --account <id> to bypass account picking)"
  else
    command -v node >/dev/null 2>&1 || die "node is required for batch account picking (pass --account <id> to bypass): $HEDDLE_CLI_PATH"
    [[ -f "$HEDDLE_CLI_PATH" ]] || die "heddle CLI not found for batch account picking: $HEDDLE_CLI_PATH (pass --account <id> to bypass)"
  fi

  BATCH_ACCOUNT_MAP="$(mktemp "${TMPDIR:-/tmp}/resume-sessions-v2-accounts.XXXXXX")" || die "could not create batch account map tempfile"
  BATCH_ACCOUNT_JSON="$(mktemp "${TMPDIR:-/tmp}/resume-sessions-v2-picker.XXXXXX")" || die "could not create batch picker tempfile"
  if [[ -n "${HEDDLE_CLI_OVERRIDE:-}" ]]; then
    if "$HEDDLE_CLI_PATH" account pick --for "$1" --json >"$BATCH_ACCOUNT_JSON"; then
      picker_status=0
    else
      picker_status=$?
    fi
  else
    if node "$HEDDLE_CLI_PATH" account pick --for "$1" --json >"$BATCH_ACCOUNT_JSON"; then
      picker_status=0
    else
      picker_status=$?
    fi
  fi
  case "$picker_status" in
    0) ;;
    1) [[ -s "$BATCH_ACCOUNT_JSON" ]] && { echo "batch picker refusal detail:" >&2; cat "$BATCH_ACCOUNT_JSON" >&2; echo >&2; }
       die "batch account picker refused this fleet; no tabs were launched" ;;
    2) die "batch account picker requires fresh meters; pass --account <id> explicitly or refresh the meters" ;;
    *) die "batch account picker failed with exit $picker_status" ;;
  esac

  PICKER_JSON="$BATCH_ACCOUNT_JSON" PICKER_MAP="$BATCH_ACCOUNT_MAP" PICKER_LABELS="$1" python3 - <<'PY'
import json
import os
import sys

try:
    with open(os.environ['PICKER_JSON']) as f:
        data = json.load(f)
except (OSError, ValueError) as exc:
    raise SystemExit('account picker returned invalid JSON: %s' % exc)
if not isinstance(data, dict):
    raise SystemExit('account picker JSON must be a top-level object')

labels = os.environ['PICKER_LABELS'].split(',')
warnings = data.get('warnings', [])
if warnings:
    if not isinstance(warnings, list):
        raise SystemExit('account picker warnings must be an array')
    print('account picker warnings: ' + '; '.join(str(w) for w in warnings), file=sys.stderr)
assignments = data.get('assignments', data)
if len(labels) == 1 and isinstance(data.get('for'), str):
    if data['for'] != labels[0]:
        raise SystemExit('account picker singleton result is for %s, expected %s' % (data['for'], labels[0]))
    assignments = {labels[0]: data}
if not isinstance(assignments, dict):
    raise SystemExit('account picker assignments must be an object')

with open(os.environ['PICKER_MAP'], 'w') as out:
    for label in labels:
        pick = assignments.get(label)
        if not isinstance(pick, dict):
            raise SystemExit('account picker omitted label %s' % label)
        config_dir = pick.get('configDir')
        unset_config_dir = pick.get('unsetConfigDir')
        if config_dir is not None and not isinstance(config_dir, str):
            raise SystemExit('account picker configDir for %s must be a string or null' % label)
        if not isinstance(unset_config_dir, bool):
            raise SystemExit('account picker unsetConfigDir for %s must be boolean' % label)
        if unset_config_dir:
            config_dir = ''
        elif not config_dir:
            raise SystemExit('account picker gave %s no configDir without unsetConfigDir' % label)
        fields = (label, str(pick.get('account') or '<default>'), config_dir or '',
                  'true' if unset_config_dir else 'false')
        if any('\t' in value or '\n' in value or '\r' in value for value in fields):
            raise SystemExit('account picker returned unsafe tab/newline data for %s' % label)
        out.write('\t'.join(fields) + '\n')
        reason = str(pick.get('reason') or 'no reason supplied').replace('\n', ' ').replace('\r', ' ')
        print('%s → %s (%s)' % (label, fields[1], reason))
PY
}

lookup_batch_account() { # $1=label -> account<TAB>configDir<TAB>unsetConfigDir
  awk -F '\t' -v label="$1" '$1 == label { print $2 "\t" $3 "\t" $4; found=1; exit } END { exit(found ? 0 : 1) }' "$BATCH_ACCOUNT_MAP"
}

# --list intentionally bypasses explicit-account registry validation; no-account list runs still
# batch-pick so the table/commands expose the account assignment without opening tabs.
if ! is_list_mode "$@"; then
  resolve_selected_account
  print_account_banner
fi

# ---- discovery: emit one TAB-separated "label<TAB>id<TAB>resume-cwd" per agent -----
discover() {
  MAX_AGE_HOURS="$MAX_AGE_HOURS" FLEET_SPAN_HOURS="$FLEET_SPAN_HOURS" PROJECTS="$PROJECTS" LABEL_MODE="$LABEL_MODE" FLEET_MAX="$FLEET_MAX" python3 - <<'PY'
import os, json, glob, time
base = os.environ['PROJECTS']
maxage_env = os.environ.get('MAX_AGE_HOURS', '').strip()      # explicit absolute-window override
span = float(os.environ.get('FLEET_SPAN_HOURS') or 168) * 3600
HARD_CAP = 90 * 86400   # fleet-generation mode never digs past this, whatever the span
LABEL_MODE = os.environ.get('LABEL_MODE', 'letters')       # 'letters' (A..Z) or 'digits' (claudex 1..FLEET_MAX)
FLEET_MAX = int(os.environ.get('FLEET_MAX') or 0) if LABEL_MODE == 'digits' else 0   # digit-mode knob; never parse ambient FLEET_MAX for letter fleets
def san(p): return p.replace('/', '-').replace('.', '-')   # Claude Code's project-dir sanitize

# freshest .jsonl per session id (a moved session has copies under >1 project dir)
byid = {}
for p in glob.glob(os.path.join(base, '*', '*.jsonl')):
    sid = os.path.basename(p)[:-6]; mt = os.path.getmtime(p)
    if sid not in byid or mt > byid[sid][0]:
        byid[sid] = (mt, p)

now = time.time()
rows = {}   # label -> (mtime, id, resume_cwd)
newest_labelled = None   # mtime of the freshest labelled session = the fleet-generation anchor
for sid, (mt, p) in sorted(byid.items(), key=lambda kv: -kv[1][0]):   # newest first
    # Newest-first lets every cutoff be a break (everything after is older still).
    if maxage_env:
        if now - mt > float(maxage_env) * 3600:
            break
    elif now - mt > HARD_CAP:
        break
    elif newest_labelled is not None and newest_labelled - mt > span:
        break   # predates the current fleet generation
    parent = os.path.basename(os.path.dirname(p))   # the project dir this file physically lives in
    cwds = []; label = None; branch = None
    try:
        with open(p, errors="replace") as f:
            for line in f:
                try: o = json.loads(line)
                except Exception: continue
                c = o.get('cwd')
                if c and c not in cwds:
                    cwds.append(c)
                if o.get('gitBranch'):
                    branch = o['gitBranch']         # for restoring a deleted worktree
                if o.get('type') == 'custom-title':
                    v = o.get('customTitle')
                    if isinstance(v, str): label = v
    except OSError:
        continue
    if not label:
        continue
    label = label.strip()
    if not (1 <= len(label) <= 3):      # fleet labels are short tags; ignore long titles
        continue
    if not label.isalnum():             # a comma/space/glob in a title would split the picker CSV or mangle commands (round 2)
        continue
    if LABEL_MODE == 'digits':
        # numbered/claudex fleet: keep ONLY pure ascii digits 1..FLEET_MAX (no leading zeros, no 0)
        if not (label.isascii() and label.isdigit()):
            continue
        if label != str(int(label)) or not (1 <= int(label) <= FLEET_MAX):
            continue
    else:
        # letter fleet (default): pure-digit tags are the claudex fleet, driven separately by
        # resume-sessions-gpt.sh (LABEL_MODE=digits) — exclude them here.
        if label.isdigit():
            continue
    # SAFE resume dir = the cwd in this file whose sanitize() == the file's own project dir.
    # That's guaranteed to be where `--resume` will look (resume is cwd-scoped: resuming from
    # any other dir returns "No conversation found"). The agent's LAST cwd is unreliable (often a
    # transient subdir like node_modules), so we pick by physical-location match, newest first.
    match = [c for c in cwds if san(c) == parent]
    if not match:
        continue                        # can't prove a safe cwd; skip rather than mis-resume
    resume = match[-1]
    if label not in rows or mt > rows[label][0]:
        rows[label] = (mt, sid, resume, branch)
        if newest_labelled is None:
            newest_labelled = mt        # anchor = newest session actually KEPT (newest-first scan) —
                                        # a label whose safe-cwd match failed must not gate the window (Bugbot, PR #18)

# digit mode sorts numerically (1,2,…,10) — lexicographic would misorder >9 and drive tab/tail
# order wrong; letter mode keeps default A→Z. One label class per run, so the key stays homogeneous.
sort_key = (lambda k: int(k)) if LABEL_MODE == 'digits' else None
for label in sorted(rows, key=sort_key):
    mt, sid, cwd, br = rows[label]
    print(f"{label}\t{sid}\t{cwd}\t{br or ''}")
PY
}

# capture discovery once (so we don't rescan per tab, and so pipefail can't surprise us)
TABLE="$(discover)" || { echo "discovery FAILED (python error above) — not 'no sessions'." >&2; exit 1; }
if [[ -z "$TABLE" ]]; then
  if [[ -n "$MAX_AGE_HOURS" ]]; then
    echo "No labelled fleet sessions found active in the last ${MAX_AGE_HOURS}h."
    echo "Unset MAX_AGE_HOURS to auto-detect the fleet regardless of how long it sat idle."
  else
    echo "No labelled fleet sessions found (scanned the last 90 days)."
    if [[ "$LABEL_MODE" == "digits" ]]; then
      echo "Fleet sessions are matched by their pure-digit /rename tag (1..$FLEET_MAX) — check the tags are still set."
    else
      echo "Fleet sessions are matched by their short /rename tag (A..Z) — check the tags are still set."
    fi
  fi
  exit 1
fi

# LABEL_FILTER: keep only whitelisted tags. TAIL_AGENTS is an explicit label set, independent of
# table order, so filtering does not change which labels receive the tail model.
if [[ -n "$LABEL_FILTER" ]]; then
  TABLE="$(printf '%s\n' "$TABLE" | awk -F'\t' -v f="$(printf '%s' "$LABEL_FILTER" | tr '[:lower:]' '[:upper:]')" \
    'BEGIN{n=split(f,a," "); for(i=1;i<=n;i++) keep[a[i]]=1} NF && (toupper($1) in keep)')"
  if [[ -z "$TABLE" ]]; then
    echo "No fleet sessions matching LABEL_FILTER='$LABEL_FILTER' found."
    echo "(An agent only becomes resumable after its first session is /rename'd with that tag.)"
    exit 1
  fi
fi

# --only <LABELS>: keep just those agents — a comma/space list, case-insensitive exact matches.
# FAIL-LOUD: any requested label that matches no discovered agent aborts BEFORE composing or
# launching anything (HED-445: a zero-match filter must never launch a different set than named).
if [[ -n "$ONLY" ]]; then
  WANT_UP="$(printf '%s' "$ONLY" | tr ',' ' ' | tr '[:lower:]' '[:upper:]')"
  MISSING=""
  for w in $WANT_UP; do
    printf '%s\n' "$TABLE" | awk -F'\t' -v want="$w" 'toupper($1)==want{f=1} END{exit(f?0:1)}' || MISSING="$MISSING $w"
  done
  if [[ -n "$MISSING" ]]; then
    echo "No agent labelled:$MISSING — nothing launched. Discovered labels: $(printf '%s\n' "$TABLE" | awk -F'\t' 'NF{print $1}' | tr '\n' ' ')" >&2
    exit 1
  fi
  TABLE="$(printf '%s\n' "$TABLE" | awk -F'\t' -v want=" $WANT_UP " 'index(want, " " toupper($1) " ")')"
fi

COUNT="$(printf '%s\n' "$TABLE" | grep -c .)"

# An explicit pin keeps its established one-account behavior. Without one, choose every
# final tab in a single CLI call after LABEL_FILTER and --only have narrowed the fleet.
# Batch-pick is for the CLAUDE letter fleet only: the claudex/digit wrapper (LABEL_MODE=digits,
# FLEET_BIN=claudex) authenticates via the proxy's own login and must never receive a Claude
# CLAUDE_CONFIG_DIR pin (review round 1, finding 1 — it also forbids --account by design).
if [[ -z "$FLEET_ACCOUNT_ID" && "$LABEL_MODE" == "letters" && "$FLEET_BIN" == "claude" ]]; then
  PICKER_LABELS="$(printf '%s\n' "$TABLE" | awk -F'\t' 'NF{print $1}' | paste -sd, -)"
  [[ -n "$PICKER_LABELS" ]] || die "cannot batch-pick accounts for an empty fleet"
  case "$ACCOUNT_MODE" in
    spread) spread_accounts "$PICKER_LABELS" ;;
    picker) batch_pick_accounts "$PICKER_LABELS" ;;
    *) die "ACCOUNT_MODE must be 'picker' or 'spread' (got '$ACCOUNT_MODE')" ;;
  esac
fi

# Is this agent in the Fable set (TAIL_AGENTS)? (case-insensitive; bash 3.2 has no ${x^^})
is_tail_agent() { # $1=label
  local want l
  want="$(printf '%s' "$1" | tr '[:lower:]' '[:upper:]')"
  for l in $TAIL_AGENTS; do
    [[ "$(printf '%s' "$l" | tr '[:lower:]' '[:upper:]')" == "$want" ]] && return 0
  done
  return 1
}
# Pick this agent's model + effort -> sets AGENT_MODEL / AGENT_EFFORT
select_model() { # $1=label
  if is_tail_agent "$1"; then
    AGENT_MODEL="$TAIL_MODEL"; AGENT_EFFORT="$TAIL_EFFORT"
  else
    AGENT_MODEL="$FLEET_MODEL"; AGENT_EFFORT="$FLEET_EFFORT"
  fi
}
model_tag() { # $1=label -> short "model/effort" for the table
  select_model "$1"; printf '%s/%s' "${AGENT_MODEL#claude-}" "$AGENT_EFFORT"
}

# HEDDLE HOME (Maya, firsthand 2026-08-28 / HED-415): heddle-fleet sessions are NEVER resumed into
# the Spinventory workspace — its app-heavy ambient context (CLAUDE.md, app MCPs) is a proven
# scope-confusion vector. Every heddle-fleet letter resumes with cwd forced to $HEDDLE_HOME
# (default ~/Developer/heddle). Requires claude >= 2.1.223 (documented cross-project --resume:
# the session is found from any directory; CLAUDE.md/ambient context follows the resume cwd).
HEDDLE_HOME="${HEDDLE_HOME:-$HOME/Developer/heddle}"
# HED-415: single decider — a heddle-fleet LETTER (exact single char, case-normalized) always lands
# in $HEDDLE_HOME; digit/claudex tags and everything else keep their discovered dir.
missing_mark() { # $1=effective-cwd $2=branch — table annotation when the resume dir is absent
  [[ -d "$1" ]] && return 0
  if [[ "$1" == "$HEDDLE_HOME" ]]; then
    printf '  <-- MISSING heddle home (launch will mkdir EMPTY — restore your heddle checkout!)'
  else
    printf '  <-- MISSING DIR (will recreate: git worktree add + %s)' "${2:-<branch>}"
  fi
}
effective_cwd() { # $1=label $2=discovered-cwd
  case "$(printf %s "$1" | tr a-z A-Z)" in
    R|S|T|U|V|W|X|Y|Z) printf %s "$HEDDLE_HOME" ;;
    *) printf %s "$2" ;;
  esac
}

build_cmd() { # $1=id  $2=cwd  $3=label
  local cwd
  cwd="$(effective_cwd "$3" "$2")"
  local account_config_dir="$ACCOUNT_CONFIG_DIR"
  set -- "$1" "$cwd" "$3"
  # MODEL_PINS=off (claudex/proxy fleet): emit no --model/--effort. On (default): pin per agent.
  local model_flags=""
  if [[ "$MODEL_PINS" != "off" ]]; then
    select_model "$3"
    model_flags="$(printf -- '--model %q --effort %q ' "$AGENT_MODEL" "$AGENT_EFFORT")"
    # %q keeps [1m] literal in any tab shell; readability in --list is secondary to portability.
  fi
  # HED-482: only Claude Code accepts the S3b recorder overlay; the claudex proxy wrapper must
  # never receive a flag it may not support, matching the deliberate batch-pick exclusion above.
  local settings_flags=""
  if [[ -n "$FLEET_SETTINGS_FILE" && "$FLEET_BIN" == "claude" ]]; then
    settings_flags="$(printf -- '--settings %q ' "$FLEET_SETTINGS_FILE")"
  fi
  # Fleet shell doctrine: pin the Bash tool to bash in every tab (canary PASS 2026-08-21,
  # S msg 844 — both shell snapshots freeze the same launch-time PATH, so node/fnm/brew are
  # shell-independent; zero regression). Two distinct opt-outs, on purpose: RESUME_SHELL=zsh
  # (exact token) skips this printf entirely; and because the pin is FIRST in the command
  # string, an explicit EXTRA_ENV CLAUDE_CODE_SHELL=... exports after it and wins — a
  # deliberate escape hatch, accepted doctrine cost.
  [[ "${RESUME_SHELL:-bash}" == "zsh" ]] || printf 'export CLAUDE_CODE_SHELL=/bin/bash && '
  # EXTRA_ENV still applies to the whole session. Pin/unset CLAUDE_CONFIG_DIR after it
  # so a caller cannot accidentally override the selected account (or leak one into default).
  [[ -n "$EXTRA_ENV" ]] && printf 'export %s && ' "$EXTRA_ENV"
  if [[ -n "$BATCH_ACCOUNT_MAP" ]]; then
    local batch_account batch_config_dir batch_unset_config_dir batch_row
    batch_row="$(lookup_batch_account "$3")" || die "batch account picker returned no assignment for agent $3"
    batch_account="$(printf '%s\n' "$batch_row" | awk -F'\t' '{print $1}')"
    batch_config_dir="$(printf '%s\n' "$batch_row" | awk -F'\t' '{print $2}')"
    batch_unset_config_dir="$(printf '%s\n' "$batch_row" | awk -F'\t' '{print $3}')"
    if [[ "$batch_unset_config_dir" == "true" ]]; then
      printf 'unset CLAUDE_CONFIG_DIR && '
    elif [[ "$batch_unset_config_dir" == "false" && -n "$batch_config_dir" ]]; then
      printf 'export CLAUDE_CONFIG_DIR=%q && ' "$batch_config_dir"
    else
      die "invalid batch account assignment for agent $3"
    fi
  elif [[ -n "$account_config_dir" ]]; then
    printf 'export CLAUDE_CONFIG_DIR=%q && ' "$account_config_dir"
  else
    printf 'unset CLAUDE_CONFIG_DIR && '
  fi
  if [[ "$FLEET_COMMS" != "off" ]]; then
    local comms_mcp_config
    if [[ "$FLEET_COMMS" == "push" ]]; then
      comms_mcp_config='{"mcpServers":{"heddle-comms":{"command":"node","args":["/Users/mayatobi/Developer/heddle/dist/comms/channel-server.js"],"env":{"HEDDLE_AGENT":"'"$3"'","HEDDLE_COMMS_PUSH":"1"}}}}'
      printf 'export HEDDLE_AGENT=%q && export HEDDLE_COMMS_PUSH=1 && ' "$3"
    else
      comms_mcp_config='{"mcpServers":{"heddle-comms":{"command":"node","args":["/Users/mayatobi/Developer/heddle/dist/comms/channel-server.js"],"env":{"HEDDLE_AGENT":"'"$3"'"}}}}'
      printf 'export HEDDLE_AGENT=%q && ' "$3"
    fi
    printf 'cd %q && %q %s %s%s--resume %q --mcp-config %q' \
      "$2" "$CLAUDE_BIN" "$SKIP_PERMS" "$model_flags" "$settings_flags" "$1" "$comms_mcp_config"
    if [[ "$FLEET_COMMS" == "push" ]]; then
      printf ' --dangerously-load-development-channels server:heddle-comms'
    fi
  else
    printf 'cd %q && %q %s %s%s--resume %q' \
      "$2" "$CLAUDE_BIN" "$SKIP_PERMS" "$model_flags" "$settings_flags" "$1"
  fi
}

print_table() {
  if [[ "$MODEL_PINS" == "off" ]]; then   # claudex fleet: 3-col table (no MODEL/EFFORT — proxy-selected)
    printf '%-6s %-38s %s\n' "AGENT" "SESSION-ID" "RESUME FROM"
    while IFS=$'\t' read -r label id cwd branch; do
      [[ -z "$label" ]] && continue
      cwd="$(effective_cwd "$label" "$cwd")"   # HED-415: show the dir the tab will really use
      local mark; mark="$(missing_mark "$cwd" "$branch")"
      printf '%-6s %-38s %s%s\n' "$label" "$id" "${cwd/#$WORKDIR/…}" "$mark"
    done <<< "$TABLE"
    return
  fi
  printf '%-6s %-38s %-16s %s\n' "AGENT" "SESSION-ID" "MODEL/EFFORT" "RESUME FROM"
  while IFS=$'\t' read -r label id cwd branch; do
    [[ -z "$label" ]] && continue
    cwd="$(effective_cwd "$label" "$cwd")"   # HED-415: show the dir the tab will really use
    local mark; mark="$(missing_mark "$cwd" "$branch")"
    printf '%-6s %-38s %-16s %s%s\n' "$label" "$id" "$(model_tag "$label")" "${cwd/#$WORKDIR/…}" "$mark"
  done <<< "$TABLE"
}

# ---- --list mode: print and exit, launch nothing --------------------------------
if [[ "${1:-}" == "--list" ]]; then
  print_comms_banner
  print_table
  echo
  while IFS=$'\t' read -r label id cwd branch; do
    [[ -z "$label" ]] && continue
    printf '# Agent %s\n%s\n\n' "$label" "$(build_cmd "$id" "$cwd" "$label")"
  done <<< "$TABLE"
  exit 0
fi

# ---- confirmation ---------------------------------------------------------------
if [[ -n "$MAX_AGE_HOURS" ]]; then
  WINDOW_DESC="active within ${MAX_AGE_HOURS}h"
else
  WINDOW_DESC="current fleet generation: within ${FLEET_SPAN_HOURS}h of the newest labelled session"
fi
echo "Discovered $COUNT fleet agents ($WINDOW_DESC):"
echo
print_comms_banner
print_table
echo
if [[ "$MODEL_PINS" != "off" ]]; then
  if [[ -n "$TAIL_AGENTS" ]]; then
    echo "Models: ${FLEET_MODEL} @ ${FLEET_EFFORT} for the fleet; ${TAIL_MODEL} @ ${TAIL_EFFORT} for: ${TAIL_AGENTS% }"
  else
    echo "Models: ${FLEET_MODEL} @ ${FLEET_EFFORT} for the whole fleet (no Fable set)."
  fi
  echo
fi
if [[ -n "$FLEET_SETTINGS_FILE" ]]; then
  if [[ "$FLEET_BIN" == "claude" ]]; then
    echo "Settings overlay (HED-482): ${FLEET_SETTINGS_FILE}"
  else
    # HED-482: build_cmd suppresses the flag for non-claude fleets — say so instead of implying it applies.
    echo "Settings overlay (HED-482): ${FLEET_SETTINGS_FILE} (FLEET_BIN=${FLEET_BIN}: flag NOT applied — claude fleets only)"
  fi
fi
# ---- fleet-completeness sanity check --------------------------------------------
# Two ways the discovery window can quietly hand back a short fleet: a gap in the middle
# (an agent renamed/retired) or a truncated tail (the window cut off the newest agents).
# Gap detection is derived from the labels themselves so it can't go stale the way the old
# hardcoded "expected 12 (A–L)" did the moment the fleet grew past L. EXPECTED_AGENTS is a
# FLOOR for the tail case — it only warns when fewer turn up, so adding agent R is silent.
# Skipped entirely under --only (1-row table is the point) and under LABEL_FILTER (a filtered
# fleet is intentionally "gappy" vs A–Z).
if [[ -z "$ONLY" && -z "$LABEL_FILTER" ]]; then
  LABELS_UP="$(printf '%s\n' "$TABLE" | awk -F'\t' 'NF{print toupper($1)}')"
  if [[ "$COUNT" -lt "$EXPECTED_AGENTS" ]]; then
    echo "NOTE: expected at least $EXPECTED_AGENTS agents but found $COUNT — the discovery window may have"
    echo "      cut off the newest agents. Widen it with FLEET_SPAN_HOURS, or check the table above."
    echo
  fi
  # Gap check only makes sense while every tag is a single letter (the fleet's convention).
  if ! printf '%s\n' "$LABELS_UP" | grep -qvE '^[A-Z]$'; then
    LAST_LABEL="$(printf '%s\n' "$LABELS_UP" | tail -n 1)"
    MISSING=""
    for L in {A..Z}; do
      printf '%s\n' "$LABELS_UP" | grep -qx "$L" || MISSING="$MISSING $L"
      [[ "$L" == "$LAST_LABEL" ]] && break
    done
    if [[ -n "$MISSING" ]]; then
      echo "NOTE: fleet runs A–$LAST_LABEL but these tags are missing:$MISSING"
      echo "      (renamed, retired, or outside the discovery window — check the table above.)"
      echo
    fi
  fi
fi
if [[ "${1:-}" != "-y" ]]; then
  if [[ "$MODEL_PINS" == "off" ]]; then
    echo "About to open $COUNT tabs, each running:  cd <dir> && $(basename "$CLAUDE_BIN") $SKIP_PERMS --resume <id>"
    echo "(Auth is the launcher's own login — e.g. the claudex proxy's ChatGPT session, not Anthropic.)"
  else
    echo "About to open $COUNT tabs, each running:  cd <dir> && claude $SKIP_PERMS --model <model> --effort <effort> --resume <id>"
    echo "(Make sure you've already logged into the target account.)"
  fi
  read -r -p "Proceed? [y/N] " ans
  [[ "$ans" == "y" || "$ans" == "Y" ]] || { echo "Aborted."; exit 0; }
fi

# ---- terminal openers -----------------------------------------------------------
# iTerm: put every agent in ONE new window, as tabs in A→Z order (deterministic — no scramble).
open_iterm_first() { # $1=title $2=cmd  -> new window
  osascript - "$1" "$2" <<'OSA'
on run argv
  tell application "iTerm"
    activate
    set w to (create window with default profile)
    tell current session of w
      set name to (item 1 of argv)
      -- kill-line guard: clear any pending operator keystrokes before injecting (2026-08-28 incident)
      write text (character id 21) newline no
      write text (item 2 of argv)
    end tell
  end tell
end run
OSA
}
open_iterm_tab() { # $1=title $2=cmd  -> tab in current (the new) window
  osascript - "$1" "$2" <<'OSA'
on run argv
  tell application "iTerm"
    tell current window
      set t to (create tab with default profile)
      tell current session of t
        set name to (item 1 of argv)
        write text (character id 21) newline no
        write text (item 2 of argv)
      end tell
    end tell
  end tell
end run
OSA
}
open_terminal_window() { # $1=command (Terminal.app: one window per call)
  osascript - "$1" <<'OSA'
on run argv
  tell application "Terminal"
    activate
    do script (item 1 of argv)
  end tell
end run
OSA
}

case "${TERM_PROGRAM:-}" in
  iTerm.app)      MODE=iterm ;;
  Apple_Terminal) MODE=terminal ;;
  *)              MODE=iterm ;;
esac
echo "Launching into: $MODE"

heal_missing_dir() { # $1=label $2=cwd $3=branch  — make the path exist so cwd-scoped --resume can find it
  local label="$1" cwd="$2" branch="$3"
  [[ -d "$cwd" ]] && return 0
  echo "        resume dir MISSING (worktree removed): $cwd"
  if [[ "$cwd" == "$HEDDLE_HOME" ]]; then
    mkdir -p "$cwd"
    echo "        ⚠ heddle home was MISSING — recreated EMPTY so the session can resume."
    echo "          Restore the real checkout there (git clone the heddle repo); a Spinventory"
    echo "          worktree is NEVER planted on the heddle home."
    return 0
  fi
  if [[ -n "$RESTORE_WORKTREES" && -n "$branch" ]]; then
    echo "        restoring worktree on '$branch' ..."
    local err
    if err="$(git -C "$INNER_REPO" worktree add -- "$cwd" "$branch" 2>&1)"; then
      echo "        ✓ worktree restored (branch $branch, files back)"; return 0
    fi
    echo "        ✗ git worktree add failed: $err"
    echo "        ✗ RESTORE_WORKTREES=1 was explicit — NOT falling back to an empty dir. Fix the branch"
    echo "          (deleted? checked out elsewhere?) or rerun without RESTORE_WORKTREES to accept empty-dir resume."
    return 1
  fi
  mkdir -p "$cwd"
  echo "        ✓ recreated an EMPTY dir — the session RESUMES (conversation intact), but its files are gone."
  [[ -n "$branch" ]] && echo "        to restore the code, run:  git -C \"$INNER_REPO\" worktree add \"$cwd\" \"$branch\""
  return 0   # without this, an empty $branch makes the && above the function's (non-zero) exit status and set -e kills the launch loop
}

i=0; opened=0; skipped=0
while IFS=$'\t' read -r label id cwd branch; do
  [[ -z "$label" ]] && continue
  i=$((i+1))
  cwd="$(effective_cwd "$label" "$cwd")"   # HED-415: display + heal the dir the tab will really use
  echo "[$i/$COUNT] Agent $label  ->  ${cwd/#$WORKDIR/…}"
  heal_missing_dir "$label" "$cwd" "$branch" || { echo "  SKIPPING $label (worktree restore failed)"; skipped=$((skipped+1)); continue; }
  cmd="$(build_cmd "$id" "$cwd" "$label")"
  if [[ "$MODE" == "iterm" ]]; then
    # first SUCCESSFUL open gets the new fleet window — a skipped first agent must not
    # demote the rest into whatever window happens to be current (Bugbot, PR #18)
    if [[ "$opened" -eq 0 ]]; then open_iterm_first "$label" "$cmd"; else open_iterm_tab "$label" "$cmd"; fi
  else
    open_terminal_window "$cmd"
  fi
  opened=$((opened+1))
  sleep 0.6   # let the terminal settle so tabs land in order
done <<< "$TABLE"

SKIP_NOTE=""; [[ "$skipped" -gt 0 ]] && SKIP_NOTE=" ($skipped skipped — see above)"
echo "Done — opened tabs for $opened agent(s).$SKIP_NOTE"
