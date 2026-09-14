#!/usr/bin/env bash
# resume-sessions-spi.sh — launch the Spinventory (SPI) fleet: Agents A–Q (A = Fable orchestrator). X is heddle-fleet since 2026-08-23 (fleet-scope.md / HED-355) and rides resume-sessions-hed.sh.
#
# Thin wrapper over resume-sessions-v2.sh (the single engine — discovery, model/effort, tab
# opening all live there; don't duplicate logic here). Added 2026-08-15 when the fleet split into
# two projects: A–Q stay on Spinventory work (Linear team SPI); R+ build heddle (team HED, see
# resume-sessions-hed.sh). Same flags/env as v2 pass straight through:
#   bash resume-sessions-spi.sh --list        # show the SPI fleet, launch nothing
#   bash resume-sessions-spi.sh -y            # launch without the confirm prompt
#
# MODEL: the SPI fleet launches on **Opus 4.8** by default (id claude-opus-4-8[1m], verified resolving
# 2026-09-05). EXCEPTION (Maya, 2026-08-20): Agent A is the SPI-side Fable orchestrator — the mirror
# of R in the hed wrapper — pinned to Fable via the TAIL_* block below. Override per run with
# FLEET_MODEL / TAIL_*.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
export LABEL_FILTER="${LABEL_FILTER:-A B C D E F G H I J K L M N O P Q}"   # X → hed wrapper (fleet-scope.md, HED-355; SPI-907 had added it here)
# HEDDLE_PACKS (SPI-895): point heddle's skill-pack search path at the SPI consumer pack dir so a
# pre-PR adversarial-review dispatch resolves `spi-adversarial-review` (searched BEFORE heddle's
# built-ins). Canonical MAIN inner-repo path (stable across every A–Q worktree; the pack ships on
# main). MCP servers spawn as children of the tab shell, so they inherit this. Space-separated in
# EXTRA_ENV → v2 emits `export LIN_TEAM=SPI HEDDLE_PACKS=…` (bash export takes multiple; no spaces in path).
export EXTRA_ENV="${EXTRA_ENV:-LIN_TEAM=SPI HEDDLE_PACKS=/Users/mayatobi/Developer/Spinventory-Rebuild-App/Spinventory-Rebuild-Official/Rebuild-Project-Root/.heddle/packs}"
export EXPECTED_AGENTS="${EXPECTED_AGENTS:-17}"    # A–Q (17); X rides the hed wrapper
export FLEET_MODEL="${FLEET_MODEL:-claude-opus-4-8[1m]}"
export FLEET_EFFORT="${FLEET_EFFORT:-high}"
# ORCHESTRATOR PIN (Maya, 2026-08-20): Agent A is the SPI-side Fable orchestrator — the mirror of
# R in the heddle wrapper — so A rides Fable @ max while the rest of A–Q ride the Opus 4.8
# default above. This wrapper unconditionally owns the A tail: inherited TAIL_AGENTS must never
# reroute SPI agents. TAIL_MODEL and TAIL_EFFORT retain their defaults unless explicitly supplied.
export TAIL_AGENTS="A"
export TAIL_MODEL="${TAIL_MODEL:-claude-fable-5}"
export TAIL_EFFORT="${TAIL_EFFORT:-max}"
exec bash ./resume-sessions-v2.sh "$@"
