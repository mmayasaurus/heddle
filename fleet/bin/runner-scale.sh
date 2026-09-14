#!/bin/bash
# runner-scale.sh — elastic Fly review-runner pool (Maya-approved 2026-07-20).
#
# The Fly pool runs a 6-machine BASELINE (~$71/mo). Any agent may bump it to 30
# when the review queue is lagging, and drops it back when the queue clears.
# (Burst cap raised 10 → 20 on 2026-07-20 during the DR-round congestion
# incident, then 20 → 30 on 2026-07-21 — both Maya-approved. Reviews are
# one-job-per-runner, so the cap IS the max number of PRs whose reviewers can
# run simultaneously; see pr-review-sweep.md.) Billing is PER-SECOND while a
# machine runs (~2¢/machine-hour; verified fly.io/docs/about/pricing
# 2026-07-21) and `down` DESTROYS extras (then $0) — bursts are near-free IF
# someone scales down when the queue quiets. That is everyone's job.
# Scale-up creates machines with FRESH ids (fresh runner names — no ghost-session
# conflicts); scale-down destroys extras, so it is GUARDED: refuse while the queue
# is deep (a destroyed machine kills any job it is running; the freshness checks
# + /deepreview N recover, but don't do it avoidably).
#
#   runner-scale.sh status      queue depth + runner + machine counts
#   runner-scale.sh up [N]      scale to N (default 30) — do this when queued > ~30
#   runner-scale.sh down [N]    scale to N (default 6) — only when queued <= 5 (see --force)
#
# WHEN TO BUMP (the rule of thumb, from the 2026-07-20 congestion incident):
#   queued > ~30 review runs, or your round has sat queued > ~15 min → `up`.
#   Queue < ~5 and no heavy fleet activity → `down` (whoever notices; check status).
# Dropped DISPATCHES (a reviewer whose run never spawned) are NOT a capacity
# problem — no scale fixes those; use `/deepreview N` per pr-review-sweep.md.
set -euo pipefail

APP="spinventory-ci-runner"
REPO="mmayasaurus/Spinventory-V2-Official-App-Rebuild"
BASELINE=6
BURST=30

need() { command -v "$1" >/dev/null 2>&1 || { echo "ERROR: $1 not on PATH" >&2; exit 1; }; }
need fly; need gh

queued() { gh api "repos/$REPO/actions/runs?status=queued&per_page=1" --jq '.total_count' 2>/dev/null || echo "?"; }
machines() {
  # Distinguish "fly failed" from "zero started" — the old 2>/dev/null |
  # grep -c masked CLI failures as a scary-but-false 0 (observed live
  # 2026-07-22: an expired fly login printed "fly machines: 0" while all 6
  # baseline machines were up serving the whole review round).
  local out
  if ! out=$(fly machine list -a "$APP" 2>/dev/null); then
    echo "?"
    return 0
  fi
  printf '%s\n' "$out" | grep -c started || true
}

case "${1:-status}" in
  status)
    Q=$(queued)
    M=$(machines)
    R=$(gh api "repos/$REPO/actions/runners" --jq '{online: [.runners[] | select(.status=="online")] | length, busy: [.runners[] | select(.busy==true)] | length}' 2>/dev/null || echo "?")
    echo "queued runs:      $Q"
    echo "fly machines:     $M (baseline $BASELINE, burst $BURST)"
    echo "runners (all):    $R"
    if [ "$M" = "?" ]; then
      echo "→ fly CLI could not list machines (expired login? run 'fly auth login') — machine count unknown; scale up/down will not work until fly auth is restored."
    elif [ "$Q" != "?" ] && [ "$Q" -gt 30 ] && [ "$M" -lt "$BURST" ]; then
      echo "→ queue is deep: consider '$(basename "$0") up'"
    elif [ "$Q" != "?" ] && [ "$Q" -le 5 ] && [ "$M" -gt "$BASELINE" ]; then
      echo "→ queue is clear: consider '$(basename "$0") down'"
    fi
    ;;
  up)
    N="${2:-$BURST}"
    echo "Scaling $APP to $N machines (queued: $(queued))..."
    fly scale count "$N" -a "$APP" --yes 2>&1 | grep -Ev "Metrics token" | tail -6
    echo "Done. New machines register with fresh runner names within ~1 min."
    ;;
  down)
    N="${2:-$BASELINE}"
    Q=$(queued)
    if [ "${3:-}" != "--force" ] && { [ "$Q" = "?" ] || [ "$Q" -gt 5 ]; }; then
      echo "REFUSED: queue is $Q (> 5). Scale-down destroys machines and can kill in-flight"
      echo "review jobs. Wait for the queue to clear, or pass --force as the 3rd arg."
      exit 2
    fi
    # A quiet queue is NOT enough: busy fly-runners mean in-flight jobs ON the
    # machines this destroys (runner names embed machine ids). Observed twice
    # live on 2026-07-22 — downs at queued=0 killed running review jobs, which
    # then re-ran on rerequeue or went red. Macs are never destroyed, so only
    # fly-runner-* busyness blocks; an API failure blocks too (can't attest).
    BF=$(gh api "repos/$REPO/actions/runners" --jq '[.runners[] | select(.busy==true) | select(.name | startswith("fly-runner-"))] | length' 2>/dev/null || echo "?")
    if [ "${3:-}" != "--force" ] && { [ "$BF" = "?" ] || [ "$BF" -gt 0 ]; }; then
      echo "REFUSED: $BF fly-runner(s) are BUSY — destroying machines now kills their in-flight"
      echo "jobs (observed live 2026-07-22 ×2). Wait for them to finish, or pass --force."
      exit 2
    fi
    echo "Scaling $APP to $N machines (queued: $Q)..."
    fly scale count "$N" -a "$APP" --yes 2>&1 | grep -Ev "Metrics token" | tail -6
    echo "Done. Destroyed machines' registrations go offline-stale; the watchdog reports them."
    ;;
  *)
    sed -n '2,20p' "$0"; exit 1 ;;
esac
