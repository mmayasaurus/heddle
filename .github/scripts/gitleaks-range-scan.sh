#!/usr/bin/env sh
# Extracted from deterministic-review.yml (HED-113) so the fixture matrix can run
# it directly. POSIX sh on purpose: this runs inside the gitleaks container image,
# where the runner's default shell is `sh -e`, not bash. Inputs: BASE, HEAD,
# GITHUB_WORKSPACE, GITHUB_STEP_SUMMARY, RUNNER_TEMP (all provided by the workflow).
#
# `set -e` is REQUIRED here, not stylistic: inline in the workflow this body ran
# under the container runner's default `sh -e`, and the code is written for that —
# see the `|| rc=$?` comment further down, which exists precisely because errexit
# would otherwise abort on gitleaks' exit-2 before the completeness checks run.
# Extracting the script without `-e` silently dropped errexit and weakened the
# fail-closed guarantee this scan exists to provide (caught in review by copilot,
# codex and qodo on the HED-113 PRs — a real regression, not a nit).
set -eu
# Container jobs: see the semgrep step — without this every git call
# (ours AND gitleaks' own) fails with "dubious ownership".
git config --global --add safe.directory "$GITHUB_WORKSPACE"
echo "scanning $BASE..$HEAD"
# Scanned-volume guard, empirically calibrated on gitleaks v8.30.1
# (HED-88): gitleaks "commits scanned" counts non-merge commits with
# ADDED or MODIFIED content — it skips merges, --allow-empty commits,
# deletion-only commits, and pure renames (measured: A/M/M-dellines
# scanned; empty/rename-only/delete-only skipped → 3 of 6). So the
# guard's LOWERBOUND = per-commit `diff-tree -M --diff-filter=AM`
# (exact same 3). A per-commit loop ON PURPOSE: pathspec rev-list
# (with or without --full-history) mis-attributes in merge
# topologies via parent rewriting — measured. Every git call fails
# CLOSED. No skip path: an all-empty range yields LOWERBOUND=0 and
# gitleaks itself logs "0 commits scanned", which passes 0<0 honestly.
#
# MERGE COMMITS (HED-109; replaces HED-88's shape check, which
# false-red every legitimate conflict resolution — found by W on
# heddle#20): a merge's only NOVEL content is where its committed
# tree differs from the RECOMPUTED automerge of its parents
# (`git merge-tree --write-tree`, git ≥2.38 — alpine 3.22 image
# ships 2.4x). Parent-side hunks were scanned as ordinary commits
# (this range or their own PRs); the automerge adds nothing new; so
# the HUMAN DELTA (conflict resolutions and any hand edits — which
# `git log -p` scanning never sees) is extracted blob-by-blob and
# scanned DIRECTLY with `gitleaks dir` below. Red only on leaks or
# tool failure — never on merge shape. Octopus merges and paths the
# extractor can't safely handle (quoted/whitespace names) hard-red
# for hand review instead of silently skipping (fail-closed).
TOTAL_ALL=$(git rev-list --count "$BASE..$HEAD") \
  || { echo "::error::git rev-list failed for $BASE..$HEAD — NOT a clean pass"; exit 1; }
if [ -z "$TOTAL_ALL" ] || [ "$TOTAL_ALL" -lt 1 ]; then
  echo "::error::empty commit range $BASE..$HEAD — nothing to scan; NOT a clean pass"; exit 1
fi
NONMERGES=$(git rev-list --no-merges "$BASE..$HEAD") \
  || { echo "::error::git rev-list (--no-merges) failed — NOT a clean pass"; exit 1; }
LOWERBOUND=0
for c in $NONMERGES; do
  NAMES=$(git diff-tree -M --no-commit-id --name-only -r --diff-filter=AM "$c") \
    || { echo "::error::git diff-tree failed on $c — NOT a clean pass"; exit 1; }
  if [ -n "$NAMES" ]; then
    LOWERBOUND=$((LOWERBOUND+1))
  fi
done
MERGES=$(git rev-list --merges "$BASE..$HEAD") \
  || { echo "::error::git rev-list (--merges) failed — NOT a clean pass"; exit 1; }
# mktemp -d, NOT a fixed path: a reused ${RUNNER_TEMP:-/tmp} dir
# (self-hosted runner, or the /tmp fallback) would otherwise feed
# stale blobs from an earlier run into the scan (copilot/codacy/qodo).
DELTA_DIR=$(mktemp -d "${RUNNER_TEMP:-/tmp}/gitleaks-merge-delta.XXXXXX") \
  || { echo "::error::mktemp for the merge-delta scan dir failed — NOT a clean pass"; exit 1; }
DELTA_COUNT=0
# Globbing OFF for the rest of the step: `for p in $DELTA` would
# pathname-expand a delta path containing * ? [ ] and extract the
# WRONG file (or none), silently leaving merge content unscanned
# (copilot + qodo). Nothing below needs expansion.
set -f
for m in $MERGES; do
  # `rev-parse <m>^@` lists parents one per line — no `set --`
  # word-splitting (SC2086) and no clobbering of $@.
  PARENTS=$(git rev-parse "$m^@") \
    || { echo "::error::git rev-parse (parents) failed on $m — NOT a clean pass"; exit 1; }
  NPAR=$(printf '%s\n' "$PARENTS" | grep -c .)
  if [ "$NPAR" -ne 2 ]; then
    echo "::error::merge $m has $NPAR parents — the merge-delta guard supports 2-parent merges only; review by hand. NOT a clean pass."
    exit 1
  fi
  P1=$(printf '%s\n' "$PARENTS" | sed -n 1p)
  P2=$(printf '%s\n' "$PARENTS" | sed -n 2p)
  MT_RC=0
  # --allow-unrelated-histories: a legitimate 2-parent merge can
  # join unrelated histories (this repo pair has fork-merge shapes);
  # without it merge-tree exits 128 and the guard below would call a
  # supported merge a tool failure (codex).
  AUTO_OUT=$(git merge-tree --write-tree --allow-unrelated-histories "$P1" "$P2") || MT_RC=$?
  # rc 0 = clean automerge, 1 = conflicts (tree still written with
  # conflict markers), anything else = tool failure.
  if [ "$MT_RC" -gt 1 ]; then
    echo "::error::git merge-tree --write-tree failed (rc=$MT_RC) on merge $m — NOT a clean pass"; exit 1
  fi
  AUTO_TREE=$(printf '%s\n' "$AUTO_OUT" | head -n 1)
  DELTA_ONLY=$(git diff-tree -r --name-only "$AUTO_TREE" "$m^{tree}") \
    || { echo "::error::git diff-tree (automerge vs committed merge) failed on $m — NOT a clean pass"; exit 1; }
  # ...plus the combined diff: files whose merged content differs from
  # ALL parents. That is where the AUTOMERGE ITSELF can synthesize a
  # match neither parent contains — e.g. one parent adds a private
  # key's header, the other its body, and the stitched file matches a
  # multiline rule that no single commit diff ever showed (codex P1).
  # `gitleaks git` skips merges, so without this those bytes are
  # unscanned even when the merge was committed verbatim.
  CC_ALL=$(git diff-tree --cc --name-only -r "$m") \
    || { echo "::error::git diff-tree --cc failed on merge $m — NOT a clean pass"; exit 1; }
  CC=$(printf '%s\n' "$CC_ALL" | tail -n +2)
  DELTA=$(printf '%s\n%s\n' "$DELTA_ONLY" "$CC" | grep -v '^$' | sort -u)
  [ -z "$DELTA" ] && continue
  # Fail CLOSED on names the extractor below would mangle: git
  # quotes non-ASCII paths (leading `"`), and the for-loop splits
  # on whitespace — either would SKIP content instead of scanning it.
  # [[:blank:]] (space+tab) — NOT `[ \t]`: POSIX ERE has no \t escape;
  # BSD/busybox grep read it as a literal `t` (caught by fixture F1).
  # `..` component / absolute path: a crafted tree could otherwise
  # make the extractor write OUTSIDE $DELTA_DIR (copilot).
  if printf '%s\n' "$DELTA" | grep -qE '^"|[[:blank:]]|^/|(^|/)\.\.(/|$)'; then
    echo "::error::merge $m delta contains quoted/whitespace/absolute/traversing path names the extractor cannot safely handle — review by hand. NOT a clean pass."
    exit 1
  fi
  for p in $DELTA; do
    git cat-file -e "$m:$p" 2>/dev/null || continue  # deleted-vs-automerge: no blob to scan
    OUT="$DELTA_DIR/$m/$p"
    # gitleaks merges <source>/.gitleaksignore and reads
    # .gitleaks.toml from the scan dir (cmd/root.go) — a merge
    # resolution could smuggle suppressions in. Renamed so the
    # CONTENT is scanned but never honored as config. Two measured
    # constraints on the new name: (1) keep the DIRECTORY — flattening
    # with tr '/' '_' collided (a/b/.gitleaks.toml vs a_b/…), silently
    # overwriting one blob while DELTA_COUNT counted both (codex P1);
    # (2) the name must not contain "gitleaks" — gitleaks' DEFAULT
    # allowlist path-excludes anything matching `gitleaks.toml`, so
    # `pr-copy-.gitleaks.toml` was skipped entirely and a planted
    # secret went undetected (fixture F10). At most one of each file
    # exists per directory, so these fixed names stay collision-free.
    case "$p" in
      .gitleaksignore|*/.gitleaksignore)
        OUT="$DELTA_DIR/$m/$(dirname "$p")/merge-delta-ignorefile-copy.txt" ;;
      .gitleaks.toml|*/.gitleaks.toml)
        OUT="$DELTA_DIR/$m/$(dirname "$p")/merge-delta-configfile-copy.txt" ;;
    esac
    mkdir -p "$(dirname "$OUT")"
    git show "$m:$p" > "$OUT" \
      || { echo "::error::failed extracting $m:$p for the merge-delta scan — NOT a clean pass"; exit 1; }
    DELTA_COUNT=$((DELTA_COUNT+1))
  done
done
echo "commits in range: $TOTAL_ALL (scanned-volume lower bound: $LOWERBOUND; merge-delta blobs: $DELTA_COUNT)"
S="${RUNNER_TEMP:-/tmp}/gitleaks-base"; mkdir -p "$S/ignore"
if git cat-file -e "$BASE:.gitleaks.toml" 2>/dev/null; then
  git show "$BASE:.gitleaks.toml" > "$S/gitleaks.toml"
  echo "using .gitleaks.toml from the base branch"
else
  printf '[extend]\nuseDefault = true\n' > "$S/gitleaks.toml"
fi
if git cat-file -e "$BASE:.gitleaksignore" 2>/dev/null; then
  git show "$BASE:.gitleaksignore" > "$S/ignore/.gitleaksignore"
  echo "using .gitleaksignore from the base branch"
fi
# gitleaks ALSO merges <source>/.gitleaksignore unconditionally
# (cmd/root.go, v8.30.1) and would read <source>/.gitleaks.toml
# without --config — so the PR's working-tree copies are moved out
# of the way (the scan reads git HISTORY, not the working tree, so
# this changes nothing about what is scanned). (cubic P1, r3)
for f in .gitleaksignore .gitleaks.toml; do
  [ -e "$f" ] && mv -f -- "$f" "$S/pr-copy-$f"
done
# `|| rc=$?` — the runner's `sh -e` would otherwise abort on the
# exit-2 hit before the checks below run. gitleaks logs to stderr;
# captured to a file so the count/error checks can read it, then
# echoed so the run log still shows everything (values redacted).
# --no-color so the log lines are exactly `<time> <LEVEL> <msg>`
# (zerolog console format); the checks below anchor on that LEVEL
# token, so a finding whose PATH happens to contain "ERR" or
# "fatal:" cannot trip them (gitar, r6). A git failure inside
# gitleaks is logged at ERR level ("ERR [git] fatal: …") and STILL
# exits 0 with "0 commits scanned" — measured on v8.30.1.
rc=0
gitleaks git --log-opts="$BASE..$HEAD" --redact --no-banner --no-color \
  --config="$S/gitleaks.toml" --gitleaks-ignore-path="$S/ignore" \
  --ignore-gitleaks-allow \
  --exit-code 2 --report-format sarif --report-path gitleaks.sarif . \
  2>"$S/gitleaks.log" || rc=$?
cat "$S/gitleaks.log"
SCANNED=$(grep -E '^[^ ]+ INF [0-9]+ commits? scanned' "$S/gitleaks.log" | grep -oE '[0-9]+ commits? scanned' | grep -oE '^[0-9]+' | head -1)
if grep -qE '^[^ ]+ (ERR|FTL) ' "$S/gitleaks.log" || [ -z "${SCANNED:-}" ] || [ "$SCANNED" -lt "$LOWERBOUND" ]; then
  echo "::error::gitleaks did not cleanly scan the whole range (gitleaks exit $rc; scanned=${SCANNED:-none}, lower bound $LOWERBOUND, or an ERR/FTL line was logged) — NOT a clean pass"
  echo "gitleaks: ❌ **scan incomplete** (gitleaks exit $rc; scanned=${SCANNED:-none}, lowerbound=$LOWERBOUND, or an ERR/FTL line) — see the job log; NOT a clean pass" >> "$GITHUB_STEP_SUMMARY"
  exit 1
fi
# Three-dot: files changed BY THIS PR (merge-base..head), not base-vs-head.
if git diff --name-only "$BASE...$HEAD" -- .gitleaks.toml .gitleaksignore | grep -q .; then
  echo "⚠️ this PR modifies a gitleaks suppression file (.gitleaks.toml / .gitleaksignore). The scan above used the BASE branch's copy, so this verdict is unaffected — but review the suppression change itself by hand." >> "$GITHUB_STEP_SUMMARY"
  echo "::warning::this PR modifies a gitleaks suppression file — the scan used the base branch's copy; review the change by hand."
fi
# Merge-delta scan (HED-109): the blobs extracted above are the only
# content `gitleaks git` never sees (merge-only content — conflict
# resolutions and hand edits). Scanned directly, same base-branch
# config and ignore file, inline allows ignored. Run from INSIDE
# $DELTA_DIR scanning `.` so findings/fingerprints are relative
# (`<merge-sha>/<repo-path>:<rule>:<line>` — measured), i.e. stable
# across runs despite the mktemp prefix, so the reviewed-on-main
# suppression route works here too (codex P2: the earlier version
# omitted --gitleaks-ignore-path and could never be unblocked).
drc=0
if [ "$DELTA_COUNT" -gt 0 ]; then
  # SARIF too (amazon-q, codex P2): without its own report the
  # merge-only findings would block the PR but never reach code
  # scanning, exactly for this new path. Written to the workspace so
  # the upload step can find it. Its `uri`s are delta-tree paths
  # (`<merge-sha>/<repo-path>`), so GitHub shows these alerts without
  # inline annotation — the job log and summary stay authoritative.
  ( cd "$DELTA_DIR" && gitleaks dir . --redact --no-banner --no-color \
      --config="$S/gitleaks.toml" --gitleaks-ignore-path="$S/ignore" \
      --ignore-gitleaks-allow --exit-code 2 \
      --report-format sarif --report-path "$GITHUB_WORKSPACE/gitleaks-delta.sarif" \
  ) 2>"$S/gitleaks-dir.log" || drc=$?
  cat "$S/gitleaks-dir.log"
  if grep -qE '^[^ ]+ (ERR|FTL) ' "$S/gitleaks-dir.log"; then
    echo "::error::gitleaks dir (merge-delta scan) logged ERR/FTL — NOT a clean pass"
    echo "gitleaks: ❌ merge-delta scan errored — see the job log; NOT a clean pass" >> "$GITHUB_STEP_SUMMARY"
    exit 1
  fi
fi
# Both summaries are written BEFORE any exit (codacy): when the
# history scan AND the merge-delta scan both hit, the report has to
# show both, not just whichever exits first.
case "$rc" in
  0) echo "gitleaks: no secrets found in $BASE..$HEAD ($SCANNED non-merge commit(s) scanned; base-branch suppressions, inline allows ignored)" >> "$GITHUB_STEP_SUMMARY" ;;
  2) echo "gitleaks: 🔑 **possible secret(s) found** in this PR's commits ($SCANNED scanned) — see the job log (values redacted); rotate anything real." >> "$GITHUB_STEP_SUMMARY" ;;
  *) echo "gitleaks: tool error (exit $rc) — NOT a clean pass" >> "$GITHUB_STEP_SUMMARY" ;;
esac
if [ "$DELTA_COUNT" -gt 0 ]; then
  case "$drc" in
    0) echo "gitleaks: merge-delta clean — $DELTA_COUNT blob(s) of merge-only content (conflict resolutions + automerge-synthesized content) scanned directly (HED-109)" >> "$GITHUB_STEP_SUMMARY" ;;
    2) echo "::error::possible secret(s) in merge-only content — see the job log (values redacted)"
       echo "gitleaks: 🔑 **possible secret(s) in merge-only content** ($DELTA_COUNT blob(s) scanned) — see the job log (values redacted); rotate anything real." >> "$GITHUB_STEP_SUMMARY" ;;
    *) echo "::error::gitleaks dir (merge-delta scan) tool error (exit $drc) — NOT a clean pass"
       echo "gitleaks: merge-delta scan tool error (exit $drc) — NOT a clean pass" >> "$GITHUB_STEP_SUMMARY"
       exit 1 ;;
  esac
fi
# Secrets in EITHER scan → exit 2 (the job's leak verdict).
[ "$drc" -eq 2 ] && exit 2
exit "$rc"
