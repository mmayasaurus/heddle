#!/usr/bin/env bash
# fleet-relaunch.sh — relaunch ONE fleet agent, optionally onto a different account.
#
# THE blessed single-agent relaunch primitive (R, 2026-08-17, built for HED-117's rotator
# supervisor and HED-129's in-app launch button — both call THIS, never raw env incantations,
# so the invocation contract lives in exactly one place).
#
#   bash fleet-relaunch.sh S --account acct3            # relaunch Agent S pinned to acct3
#   bash fleet-relaunch.sh Q                            # relaunch Agent Q (no pin — the wrapper's ACCOUNT_MODE picks the account)
#   bash fleet-relaunch.sh T --account acct2 --model claude-opus-4-8 --effort high
#   bash fleet-relaunch.sh R --model claude-fable-5 --list  # inspect one-agent composition; opens nothing
#
# Semantics (all inherited from resume-sessions-v2.sh, the single engine):
#   * Resumes the agent's EXISTING conversation (same --resume id) in a fresh iTerm tab with
#     the same per-agent env (HEDDLE_AGENT, comms push + channels flag, LIN_TEAM via the
#     letter's fleet). The account (CLAUDE_CONFIG_DIR) is chosen by the owning wrapper's
#     ACCOUNT_MODE when no --account is given (HED: spread even-split, resume-sessions-hed.sh
#     :20-24; SPI: picker), so a relaunch WITHOUT --account can land the agent on a different
#     account than its home — pass --account to pin a specific one.
#   * --account preflights via heddle-account-share.sh registry checks (refuses unregistered/
#     unshared/logged-out dirs) — the same guarantees as a full-fleet launch.
#   * Does NOT kill the agent's old process/tab. The caller (rotator supervisor, or a human)
#     owns quiesce-then-kill; this script only launches. That split is deliberate: launching
#     is idempotent-safe to retry, killing is not.
#   * A-Q resolve through the SPI wrapper, R-Z through the HED wrapper, and numbered agents through
#     the GPT/claudex wrapper. Per-fleet model policy stays in the wrappers, not here.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

usage() { sed -n '3,26p' "${BASH_SOURCE[0]}"; exit 2; }
[ $# -ge 1 ] || usage
LETTER=$(printf '%s' "$1" | tr '[:lower:]' '[:upper:]'); shift
# Validate the agent selector at parse time so a bad one is an EARLY clear reject, not a late
# "no matching session" after routing. Numbered agents mirror resume-sessions-v2.sh discovery:
# ~L674 caps a label at 1..3 chars, and ~L680-683 keeps only label == str(int(label)) with
# 1 <= n <= FLEET_MAX (no 0, no leading zeros). So the effective ceiling is min(FLEET_MAX, 999) and a
# >3-digit selector is undiscoverable. FLEET_MAX is consulted ONLY in the numbered branch (v2 never
# parses ambient FLEET_MAX for letter fleets).
if [[ "$LETTER" =~ ^[A-Z]$ ]]; then
  :   # single agent letter A-Z — routed to the SPI/HED wrapper below
elif [[ "$LETTER" =~ ^[1-9][0-9]*$ ]]; then
  # Length cap first (discovery-independent of FLEET_MAX): v2 (~L674) ignores any label >3 chars, so a
  # >3-digit selector would pass here only to be dropped at discovery — the late failure this guards against.
  if [ "${#LETTER}" -gt 3 ]; then
    echo "fleet-relaunch: numbered agent must be at most 3 digits — resume-sessions-v2.sh discovery ignores longer labels, got '$LETTER'" >&2; exit 2
  fi
  fm="${FLEET_MAX:-6}"   # numbered (claudex) fleet is 1..FLEET_MAX; resume-sessions-gpt.sh uses the same ${FLEET_MAX:-6}
  [[ "$fm" =~ ^[1-9][0-9]*$ ]] || { echo "fleet-relaunch: FLEET_MAX must be a positive integer (got '$fm')" >&2; exit 2; }
  # Compare only when FLEET_MAX is itself <=3 digits: if it is >=1000, every <=3-digit selector (<=999)
  # is in range — matching discovery's arbitrary-precision int — and skipping avoids a bash-int overflow
  # on a huge FLEET_MAX. Both operands are then <=999, so this -le can never overflow or error.
  if [ "${#fm}" -le 3 ]; then
    [ "$LETTER" -le "$fm" ] || { echo "fleet-relaunch: numbered agent must be 1..$fm (the claudex fleet), got '$LETTER'" >&2; exit 2; }
  fi
else
  echo "fleet-relaunch: first arg must be an agent letter (A-Z) or a numbered agent 1..${FLEET_MAX:-6} (claudex), got '$LETTER'" >&2; exit 2
fi

ACCOUNT=""; MODEL=""; EFFORT=""; LIST_MODE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --account) ACCOUNT="${2:?--account needs a value}"; shift 2;;
    --model)   MODEL="${2:?--model needs a value}"; shift 2;;
    --effort)  EFFORT="${2:?--effort needs a value}"; shift 2;;
    --list)    LIST_MODE=--list; shift;;
    -h|--help) usage;;
    *) echo "fleet-relaunch: unknown flag '$1'" >&2; exit 2;;
  esac
done

# Route to the owning fleet wrapper so per-fleet model defaults apply.
if [[ "$LETTER" =~ ^[0-9]+$ ]]; then
  # numbered/claudex fleet (resume-sessions-gpt.sh): default store, proxy-picked model
  if [ -n "$ACCOUNT" ] || [ -n "$MODEL" ] || [ -n "$EFFORT" ]; then
    echo "fleet-relaunch: --account/--model/--effort are not supported for numbered (claudex) agents — the proxy fleet uses the default store and the proxy picks the model." >&2
    exit 2
  fi
  WRAPPER=./resume-sessions-gpt.sh
else
  case "$LETTER" in
    [A-Q]) WRAPPER=./resume-sessions-spi.sh;;   # X (>Q) falls through to hed — heddle fleet
    *)     WRAPPER=./resume-sessions-hed.sh;;
  esac
fi

export LABEL_FILTER="$LETTER"
export EXPECTED_AGENTS=1
[ -n "$ACCOUNT" ] && export FLEET_ACCOUNT="$ACCOUNT"
# A Fable override is a single-agent tail pin: never export it fleet-wide, where v2 correctly
# rejects it. Other model/effort overrides keep the existing dual-pin behavior.
FABLE_TAIL=0
if [ -n "$MODEL" ]; then
  MODEL="$(printf '%s' "$MODEL" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
  case "$(printf '%s' "$MODEL" | tr '[:upper:]' '[:lower:]')" in
    *fable-5*|*fable5*)
      FABLE_TAIL=1
      unset FLEET_MODEL FLEET_EFFORT
      export TAIL_MODEL="$MODEL" TAIL_AGENTS="$LETTER"
      [ -n "$EFFORT" ] && export TAIL_EFFORT="$EFFORT"
      ;;
    *)
      export FLEET_MODEL="$MODEL" TAIL_MODEL="$MODEL"
      [ -n "$EFFORT" ] && export FLEET_EFFORT="$EFFORT" TAIL_EFFORT="$EFFORT"
      ;;
  esac
elif [ -n "$EFFORT" ]; then
  export FLEET_EFFORT="$EFFORT" TAIL_EFFORT="$EFFORT"
fi

# Wrappers own their fixed tails unconditionally. A custom Fable relaunch therefore calls the
# shared engine directly, after recreating the owning wrapper's normal tab environment.
if [ "$FABLE_TAIL" -eq 1 ]; then
  case "$LETTER" in
    [A-Q]|[1-9])
      export EXTRA_ENV="${EXTRA_ENV:-LIN_TEAM=SPI HEDDLE_PACKS=/Users/mayatobi/Developer/Spinventory-Rebuild-App/Spinventory-Rebuild-Official/Rebuild-Project-Root/.heddle/packs}"
      ;;
    *) export EXTRA_ENV="${EXTRA_ENV:-LIN_TEAM=HED}" ;;
  esac
  WRAPPER=./resume-sessions-v2.sh
fi

exec bash "$WRAPPER" "${LIST_MODE:--y}"
