#!/bin/bash
# Scratch-only test for local-pr-check.sh (dry runs; posts nothing).
set -u
SRC="$(cd "$(dirname "$0")/.." && pwd)"
T="${1:?usage: test-local-check.sh <empty-dir> <pinned-hygiene.sh>}"
HYG="${2:?pinned hygiene script}"
mkdir -p "$T"; cd "$T" || exit 2
pass=0; fail=0
ok() { echo "PASS $1"; pass=$((pass+1)); }
bad() { echo "FAIL $1"; fail=$((fail+1)); }

git init -q -b main canon; cd canon
git config user.name t; git config user.email t@example.invalid
mkdir -p Game/Assets ContentSource/AssetManifests
echo png > Game/Assets/a.png; echo meta > Game/Assets/a.png.meta
echo '{}' > ContentSource/AssetManifests/x.json
git add -A; git commit -qm clean; clean=$(git rev-parse HEAD)
echo png2 > Game/Assets/b.png; git add -A; git commit -qm "missing meta"; nometa=$(git rev-parse HEAD)
mkdir -p keys; echo not-a-real-key > keys/secret.pem; git add -A; git commit -qm "forbidden file"; forbidden=$(git rev-parse HEAD)
cd "$T"

export HEDDLE_CHECK_CANON="$T/canon" HEDDLE_CHECK_ROOT="$T/checks" HEDDLE_CHECK_HYGIENE="$HYG" HEDDLE_CHECK_REPO="example/scratch"
export HEDDLE_CHECK_PATHS="Game/Assets ContentSource"
run() { bash "$SRC/local-pr-check.sh" --sha "$1" --source "$T/canon" --dry-run > "$T/out-$2.txt" 2>&1; echo $?; }

rc=$(run "$clean" clean)
grep -q "result:  success" "$T/out-clean.txt" && ok "clean head -> success" || { bad "clean head -> success"; cat "$T/out-clean.txt"; }
grep -q "dry run: would run: gh api -X POST repos/example/scratch/statuses/$clean -f state=success" "$T/out-clean.txt" && ok "dry run prints the status call" || bad "dry run prints the status call"

rc=$(run "$nometa" nometa)
grep -q "result:  failure" "$T/out-nometa.txt" && ok "missing .meta -> failure" || { bad "missing .meta -> failure"; tail -5 "$T/out-nometa.txt"; }

rc=$(run "$forbidden" forbidden)
grep -q "result:  failure" "$T/out-forbidden.txt" && ok "forbidden file -> failure" || { bad "forbidden file -> failure"; tail -5 "$T/out-forbidden.txt"; }

n=$(ls -d "$T/checks"/*/ 2>/dev/null | wc -l | tr -d ' ')
[ "$n" = "3" ] && ok "one new folder per run, none reused" || bad "one new folder per run (found $n)"
[ "$(git -C "$T/canon" status --porcelain | wc -l | tr -d ' ')" = "0" ] && ok "source repo untouched" || bad "source repo untouched"
lfs=$(git -C "$T/canon" rev-parse HEAD)
[ "$lfs" = "$forbidden" ] && ok "source HEAD unchanged" || bad "source HEAD unchanged"
echo "RESULT pass=$pass fail=$fail"
