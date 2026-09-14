#!/usr/bin/env bash
# resume-sessions-hed.sh — launch ONLY the heddle build fleet: Agents R–X (+ reserved Y, Z). X moved
#                          here 2026-08-23 (fleet-scope.md / HED-355): porting Spinventory INTO heddle is heddle work.
#
# Thin wrapper over resume-sessions-v2.sh (the single engine). Added 2026-08-15: A–Q stay on
# Spinventory (see resume-sessions-spi.sh); R+ are the heddle-project orchestrators/workers,
# tracked in Linear team HED — EXTRA_ENV exports LIN_TEAM=HED into every tab so `lin.sh` in
# those sessions defaults to the Heddle team without anyone remembering to set it.
#
# NOTE: an agent only shows up here once its first session has been /rename'd (S, T … are
# provisioned in Linear but appear in this launcher after their first named session exists).
# Same flags/env as v2 pass straight through. This wrapper unconditionally owns the R/Y Fable tail
# @ max: inherited TAIL_AGENTS must never reroute Heddle agents. TAIL_MODEL and TAIL_EFFORT retain
# their v2 defaults unless explicitly supplied.
#   bash resume-sessions-hed.sh --list  |  -y  |  --only S
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
export LABEL_FILTER="${LABEL_FILTER:-R S T U V W X Y Z}"   # X is heddle-fleet (fleet-scope.md, HED-355; SPI-907 had parked it in the SPI wrapper)
export EXTRA_ENV="${EXTRA_ENV:-LIN_TEAM=HED}"
# Even-split the heddle fleet across all logged-in accounts, meter-independently (v2's spread mode).
# The default headroom picker drops stale-meter accounts, so a bulk resume after idle piles the whole
# fleet onto the one account with a live meter (observed 2026-09-13: all of R–Z → acct1). spread mode
# splits them evenly regardless of meter freshness. Override with ACCOUNT_MODE=picker; --account still wins.
export ACCOUNT_MODE="${ACCOUNT_MODE:-spread}"
export TAIL_AGENTS="R"
export EXPECTED_AGENTS="${EXPECTED_AGENTS:-1}"      # small fleet while heddle is being built
exec bash ./resume-sessions-v2.sh "$@"
