#!/usr/bin/env bash
# resume-sessions-gpt.sh — launch the NUMBERED fleet (Agents 1..FLEET_MAX): the claudex fleet
# (Claude Code harness on GPT-5.6 Codex models via claude-code-proxy, on Maya's ChatGPT sub).
#
# Thin wrapper over resume-sessions-v2.sh (the single engine since HED-306 — discovery, safe-cwd
# resume, one-window tab opening, worktree healing all live there; do not duplicate). Drives v2 in
# the claudex configuration: pure-digit /rename tags 1..FLEET_MAX (LABEL_MODE=digits), the `claudex`
# binary (FLEET_BIN), and no model pins (MODEL_PINS=off — the proxy picks the model). Flags/env pass
# straight through, e.g.:  --list (show, launch nothing) | -y (skip confirm) | --only 3 | FLEET_MAX=8.
# AUTH: log into the proxy's ChatGPT session first (claude-code-proxy codex auth status, not
# Anthropic). --account (a Claude-store concept) is rejected — the proxy fleet uses the default store.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
# Account selection is a Claude-store concept (validates a Claude account, exports CLAUDE_CONFIG_DIR)
# — invalid for the proxy fleet, which uses the default store. Neutralise BOTH entry points: the
# FLEET_ACCOUNT env var and the --account / --account=… flag forms (the old fork always unset it).
unset FLEET_ACCOUNT
for a in "$@"; do
  case "$a" in
    --account|--account=*) echo "resume-sessions-gpt.sh: --account is not supported for the claudex numbered fleet (default store only)." >&2; exit 2 ;;
  esac
done
export FLEET_BIN=claudex
export LABEL_MODE=digits
export FLEET_MAX="${FLEET_MAX:-6}"
export MODEL_PINS=off
export FLEET_COMMS="${FLEET_COMMS:-off}"
export EXPECTED_AGENTS="${EXPECTED_AGENTS:-$FLEET_MAX}"   # short-fleet warning tracks the (possibly raised) FLEET_MAX
exec bash ./resume-sessions-v2.sh "$@"
