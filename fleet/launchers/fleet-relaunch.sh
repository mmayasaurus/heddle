#!/usr/bin/env bash
# fleet-relaunch.sh — relaunch ONE fleet agent, optionally onto a different account.
#
# THE blessed single-agent relaunch primitive (R, 2026-08-17, built for HED-117's rotator
# supervisor and HED-129's in-app launch button — both call THIS, never raw env incantations,
# so the invocation contract lives in exactly one place).
#
#   bash fleet-relaunch.sh S --account acct3            # relaunch Agent S pinned to acct3
#   bash fleet-relaunch.sh Q                            # relaunch Agent Q on the default account
#   bash fleet-relaunch.sh T --account acct2 --model claude-opus-4-8 --effort high
#   bash fleet-relaunch.sh R --model claude-fable-5 --list  # inspect one-agent composition; opens nothing
#
# Semantics (all inherited from resume-sessions-v2.sh, the single engine):
#   * Resumes the agent's EXISTING conversation (same --resume id) in a fresh iTerm tab with
#     the same per-agent env (HEDDLE_AGENT, comms push + channels flag, LIN_TEAM via the
#     letter's fleet), differing only in CLAUDE_CONFIG_DIR when --account is given.
#   * --account preflights via heddle-account-share.sh registry checks (refuses unregistered/
#     unshared/logged-out dirs) — the same guarantees as a full-fleet launch.
#   * Does NOT kill the agent's old process/tab. The caller (rotator supervisor, or a human)
#     owns quiesce-then-kill; this script only launches. That split is deliberate: launching
#     is idempotent-safe to retry, killing is not.
#   * A-Q resolve through the SPI wrapper and R-Z through the HED wrapper — EXCEPT X, the SPI-side
#     CI/infra agent, which routes to SPI too. Per-fleet model policy stays in the wrappers, not here.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

usage() { sed -n '3,20p' "${BASH_SOURCE[0]}"; exit 2; }
[ $# -ge 1 ] || usage
LETTER=$(printf '%s' "$1" | tr '[:lower:]' '[:upper:]'); shift
case "$LETTER" in [A-Z]|[1-9]) ;; *) echo "fleet-relaunch: first arg must be an agent letter/digit, got '$LETTER'" >&2; exit 2;; esac

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
case "$LETTER" in
  [A-Q]|[1-9]) WRAPPER=./resume-sessions-spi.sh;;   # X is heddle-fleet since 2026-08-23 (fleet-scope.md, HED-355) → hed wrapper below
  *)             WRAPPER=./resume-sessions-hed.sh;;
esac

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
