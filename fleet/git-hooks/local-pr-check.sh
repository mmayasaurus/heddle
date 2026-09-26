#!/bin/bash
# local-pr-check.sh — run a repository's hygiene check on a PR's exact head, on this Mac,
# and report the result to GitHub as a commit status. Commit statuses are free; no GitHub
# Actions minutes are used.
#
# Usage:
#   local-pr-check.sh <PR-number> [--dry-run]
#   local-pr-check.sh --sha <commit> --source <local-repo> [--dry-run]     (testing)
#
# Settings (environment; a per-project wrapper sets them):
#   HEDDLE_CHECK_REPO     GitHub owner/name for the PR and the status
#   HEDDLE_CHECK_CANON    local repository whose objects are borrowed (read-only)
#   HEDDLE_CHECK_ROOT     where per-check folders are made (never inside the repository)
#   HEDDLE_CHECK_HYGIENE  the pinned hygiene script to run
#   HEDDLE_CHECK_PATHS    paths materialized on disk for the checks that read files
#   HEDDLE_CHECK_CONTEXT  status context name
#
# How it stays safe:
#   * Each run makes a NEW folder <root>/<sha12>-<utc>; nothing is ever deleted or reused,
#     and the repository's own checkout, index and refs are never touched.
#   * The folder is a plain `git init` repository that borrows the canonical repository's
#     objects through objects/info/alternates (no copy, no clone, no worktree). Missing
#     objects are fetched from GitHub into that folder only.
#   * The LFS filter is switched off for the materialized paths, so LFS files are written as
#     their small pointer files: nothing is downloaded or copied. The checks need paths only.
#   * The hygiene script comes from a pinned copy outside the PR, so a PR cannot weaken it.
set -u

REPO="${HEDDLE_CHECK_REPO:?set HEDDLE_CHECK_REPO to owner/name}"
CANON="${HEDDLE_CHECK_CANON:?set HEDDLE_CHECK_CANON to the local repository}"
ROOT="${HEDDLE_CHECK_ROOT:?set HEDDLE_CHECK_ROOT to a folder outside the repository}"
HYGIENE="${HEDDLE_CHECK_HYGIENE:?set HEDDLE_CHECK_HYGIENE to the pinned check script}"
PATHS="${HEDDLE_CHECK_PATHS:-.gitleaks.toml .gitleaksignore}"
CONTEXT="${HEDDLE_CHECK_CONTEXT:-local/repo-hygiene}"

pr=""; sha=""; source_repo=""; dry=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry=1 ;;
    --sha) sha="${2:-}"; shift ;;
    --source) source_repo="${2:-}"; shift ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) pr="$1" ;;
  esac
  shift
done

die() { echo "local-pr-check: $*" >&2; exit 2; }

[ -f "$HYGIENE" ] || die "pinned hygiene script not found: $HYGIENE"
common="$(git -C "$CANON" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || die "not a git repository: $CANON"

if [ -n "$pr" ]; then
  sha="$(gh pr view "$pr" --repo "$REPO" --json headRefOid --jq .headRefOid)" || die "cannot read PR #$pr"
fi
[ -n "$sha" ] || die "give a PR number, or --sha with --source"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
dir="$ROOT/${sha:0:12}-$stamp"
mkdir -p "$ROOT" || die "cannot create $ROOT"
[ -e "$dir" ] && die "refusing to reuse existing folder $dir"
git init -q "$dir" || die "git init failed"
printf '%s\n' "$common/objects" > "$dir/.git/objects/info/alternates"

if ! git -C "$dir" cat-file -e "$sha^{commit}" 2>/dev/null; then
  if [ -n "$source_repo" ]; then
    git -C "$dir" fetch -q "$source_repo" "$sha" || die "cannot fetch $sha from $source_repo"
  elif [ -n "$pr" ]; then
    git -C "$dir" fetch -q "https://github.com/$REPO.git" "refs/pull/$pr/head" || die "cannot fetch PR #$pr"
  fi
fi
git -C "$dir" cat-file -e "$sha^{commit}" 2>/dev/null || die "commit $sha is not available"

git -C "$dir" update-ref refs/heads/check "$sha" || die "update-ref failed"
git -C "$dir" symbolic-ref HEAD refs/heads/check
git -C "$dir" read-tree "$sha" || die "read-tree failed"
# shellcheck disable=SC2086
git -C "$dir" ls-files -z -- $PATHS \
  | GIT_LFS_SKIP_SMUDGE=1 git -C "$dir" -c filter.lfs.smudge= -c filter.lfs.process= -c filter.lfs.required=false \
      checkout-index -f -z --stdin \
  || die "could not write the checked paths"
[ "$(git -C "$dir" rev-parse HEAD)" = "$sha" ] || die "HEAD is not $sha"

log="$dir.log"
( cd "$dir" && HYGIENE_STRICT=1 bash "$HYGIENE" ) > "$log" 2>&1
rc=$?
when="$(date -u +%Y-%m-%dT%H:%MZ)"
case "$rc" in
  0) state=success; desc="repo-hygiene passed on the local Mac, $when" ;;
  1) state=failure; desc="repo-hygiene FAILED on the local Mac, $when; see its log" ;;
  *) state=error;   desc="repo-hygiene could not run on the local Mac, $when; see its log" ;;
esac

echo "commit:  $sha"
echo "result:  $state (exit $rc)"
echo "log:     $log"
tail -n 3 "$log" | sed 's/^/  | /'

if [ "$dry" -eq 1 ]; then
  echo "dry run: would run: gh api -X POST repos/$REPO/statuses/$sha -f state=$state -f context=$CONTEXT -f description=\"$desc\""
  exit 0
fi
gh api -X POST "repos/$REPO/statuses/$sha" -f state="$state" -f context="$CONTEXT" -f description="$desc" >/dev/null \
  || die "could not post the status (the check result above still stands)"
echo "posted:  $CONTEXT = $state on $REPO@${sha:0:12}"
[ "$state" = success ]
