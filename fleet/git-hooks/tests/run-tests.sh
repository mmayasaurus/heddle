#!/bin/bash
# Throwaway-repo tests for the heddle git guard. Touches nothing outside $T.
set -u
SRC="$(cd "$(dirname "$0")/.." && pwd)"
T="${1:?usage: run-tests.sh <empty-test-dir>}"
mkdir -p "$T"
cd "$T" || exit 2
ZERO=0000000000000000000000000000000000000000
pass=0; fail=0
ok()  { echo "PASS $1"; pass=$((pass+1)); }
bad() { echo "FAIL $1"; fail=$((fail+1)); }
expect_rc() { # name expected_rc actual_rc
  if [ "$3" -eq "$2" ]; then ok "$1"; else bad "$1 (rc=$3, wanted $2)"; fi
}
expect_nonzero() { if [ "$2" -ne 0 ]; then ok "$1"; else bad "$1 (rc=0, wanted non-zero)"; fi; }

# --- config for this test (same shape as production, local paths) ---
python3 - "$SRC/guard.example.json" "$T/guard.json" "$T" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1]))
t = sys.argv[3]
cfg["repo_label"] = "guard-test"
cfg["worktrees_dir"] = t + "/wt"
cfg["alert_log"] = t + "/alerts.jsonl"
json.dump(cfg, open(sys.argv[2], "w"), indent=1)
PY
mkdir -p "$T/wt"
sh "$SRC/make-git-guard-hooks.sh" "$T/hooks" "$SRC/heddle_git_guard.py" "$T/guard.json" >/dev/null

# --- repos: a bare remote and a work repo with fake LFS-style hooks to prove chaining ---
git init -q --bare remote.git
git init -q -b main work
cd work
git config user.name "Guard Test"; git config user.email "guard-test@example.invalid"
git remote add origin "$T/remote.git"
for h in pre-push post-checkout post-commit post-merge; do
  cat > ".git/hooks/$h" <<EOF
#!/bin/sh
echo "$h \$*" >> "$T/chain.log"
[ "$h" = pre-push ] && cat >> "$T/chain-stdin.log"
exit 0
EOF
  chmod +x ".git/hooks/$h"
done
mkdir -p .claude
echo base > a.txt; echo conf > .claude/settings.json; echo c0 > c.txt
git add -A && git commit -qm "base on main" && git push -q origin main
git config core.hooksPath "$T/hooks"
export HEDDLE_AGENT=WORKER FLEET_AGENT=WORKER

# S1 main merged into a feature branch
git switch -q -c feature
echo f1 > f.txt; git add f.txt; git commit -qm "feature work"
git switch -q main; echo m1 > m.txt; git add m.txt; git commit -qm "main moves"; git -c core.hooksPath=/nonexistent push -q origin main
git switch -q feature
git merge -q -m "merge main" main 2>"$T/s1.err"; rc=$?
expect_nonzero "S1 merging main into feature is refused" $rc
grep -q "no_main_merge" "$T/s1.err" && ok "S1 message names the rule" || bad "S1 message names the rule"
grep -q "rule set by the project owner" "$T/s1.err" && ok "S1 message names the configured owner" || bad "S1 message names the configured owner"
git merge --abort 2>/dev/null
[ "$(git rev-list --merges --count HEAD)" = "0" ] && ok "S1 no merge commit left" || bad "S1 no merge commit left"

# S1b pulling origin main into a feature branch is refused
git switch -q -c pulltest feature
git -c pull.rebase=false pull -q --no-edit origin main 2>"$T/s1b.err"; rc=$?
expect_nonzero "S1b git pull origin main into a feature branch is refused" $rc
git merge --abort 2>/dev/null
[ "$(git rev-list --merges --count HEAD)" = "0" ] && ok "S1b no merge commit left" || bad "S1b no merge commit left"
git switch -q feature

# S2 feature-to-feature merge without main content is allowed
git switch -q -c feature2 feature~0 2>/dev/null || git switch -q -c feature2
git switch -q -c feature3 "$(git merge-base feature main)"
echo x3 > x3.txt; git add x3.txt; git commit -qm "feature3 work"
git switch -q feature2
git merge -q -m "merge feature3" feature3 2>"$T/s2.err"; rc=$?
expect_rc "S2 feature-to-feature merge allowed" 0 $rc

# S3 merging origin/main is refused too
git fetch -q origin
git switch -q feature
git merge -q -m "merge origin main" origin/main 2>"$T/s3.err"; rc=$?
expect_nonzero "S3 merging origin/main is refused" $rc
git merge --abort 2>/dev/null

# S4 conflicted merge of main, resolved, then committed: pre-commit refuses
git switch -q main; echo main-side > c.txt; git commit -qam "main edits c"; git -c core.hooksPath=/nonexistent push -q origin main
git switch -q feature; echo feature-side > c.txt; git commit -qam "feature edits c"
git merge -m "merge main conflict" main >/dev/null 2>&1
echo resolved > c.txt; git add c.txt
git commit -qm "conclude conflicted merge" 2>"$T/s4.err"; rc=$?
expect_nonzero "S4 concluding a conflicted main merge is refused" $rc
git merge --abort 2>/dev/null

# S5 protected paths: refused on a feature branch, allowed on lead/repo-game-only-*
echo agents > CLAUDE.md; git add CLAUDE.md
git commit -qm "add CLAUDE.md" 2>"$T/s5.err"; rc=$?
expect_nonzero "S5 adding CLAUDE.md on a feature branch is refused" $rc
echo x > .claude/new.json; git add .claude/new.json
git commit -qm "add .claude file" 2>/dev/null; rc=$?
expect_nonzero "S5 adding under .claude/ is refused" $rc
git restore --staged CLAUDE.md .claude/new.json
git switch -q -c lead/repo-game-only-test
git add CLAUDE.md; git commit -qm "cleanup branch may carry it" 2>"$T/s5b.err"; rc=$?
expect_rc "S5 cleanup branch may commit protected paths" 0 $rc
git switch -q feature

# S6 deleting a protected file on a feature branch is allowed
git update-index --force-remove .claude/settings.json 2>/dev/null
if git diff --cached --name-status | grep -q '^D'; then
  git commit -qm "remove harness file" 2>"$T/s6.err"; rc=$?
  expect_rc "S6 deleting a protected path is allowed" 0 $rc
else
  echo "SKIP S6 (could not stage a removal in this session)"
fi

# S7 normal push is allowed and the repo's own pre-push receives the same stdin
: > "$T/chain-stdin.log"
git push -q origin feature 2>"$T/s7.err"; rc=$?
expect_rc "S7 normal feature push allowed" 0 $rc
grep -q "refs/heads/feature" "$T/chain-stdin.log" && ok "S7 chained pre-push got the ref line" || bad "S7 chained pre-push got the ref line"
grep -q "pre-push origin" "$T/chain.log" && ok "S7 chained pre-push got the args" || bad "S7 chained pre-push got the args"

# S8-S10 pushes refused by rule (synthetic stdin straight into the hook; nothing is pushed)
F=$(git rev-parse feature); M=$(git rev-parse main); OLD=$(git rev-parse feature~1)
printf 'refs/heads/feature %s refs/heads/main %s\n' "$F" "$M" | "$T/hooks/pre-push" origin "$T/remote.git" 2>"$T/s8.err"; rc=$?
expect_nonzero "S8 push to main refused" $rc
printf '(delete) %s refs/heads/feature %s\n' "$ZERO" "$F" | "$T/hooks/pre-push" origin "$T/remote.git" 2>"$T/s9.err"; rc=$?
expect_nonzero "S9 remote branch deletion refused" $rc
printf 'refs/heads/feature %s refs/heads/feature %s\n' "$OLD" "$F" | "$T/hooks/pre-push" origin "$T/remote.git" 2>"$T/s10.err"; rc=$?
expect_nonzero "S10 non-fast-forward (force) push refused" $rc
grep -q "no_force_push" "$T/s10.err" && ok "S10 message names the rule" || bad "S10 message names the rule"

# S11 a main merge made with hooks switched off: post-merge alerts, push refused
git switch -q -c sneaky feature
git -c core.hooksPath=/nonexistent merge -q -m "sneaky main merge" main >/dev/null 2>&1 || { echo resolved2 > c.txt; git add c.txt; git -c core.hooksPath=/nonexistent commit -qm "sneaky main merge"; }
[ "$(git rev-list --merges --count HEAD ^feature)" -ge 1 ] && ok "S11 setup made a main merge" || bad "S11 setup made a main merge"
"$T/hooks/post-merge" 0 2>"$T/s11a.err"
grep -q '"bypass-merge"' "$T/alerts.jsonl" && ok "S11 post-merge backstop alerted" || bad "S11 post-merge backstop alerted"
git push -q origin sneaky 2>"$T/s11.err"; rc=$?
expect_nonzero "S11 pushing a branch with a main merge is refused" $rc
git ls-remote --heads origin sneaky | grep -q sneaky && bad "S11 nothing reached the remote" || ok "S11 nothing reached the remote"

# S12 protected file committed with hooks off: post-commit backstop alerts, push refused
git switch -q -c sneaky2 feature
echo x > AGENTS.md; git add AGENTS.md; git -c core.hooksPath=/nonexistent commit -qm "sneaky agents file"
"$T/hooks/post-commit" 2>/dev/null
grep -q '"bypass-commit"' "$T/alerts.jsonl" && ok "S12 post-commit backstop alerted" || bad "S12 post-commit backstop alerted"
git push -q origin sneaky2 2>"$T/s12.err"; rc=$?
expect_nonzero "S12 pushing a protected-path commit is refused" $rc

# S13 new worktree detection (simulated post-checkout with the null ref)
HEDDLE_AGENT=WORKER FLEET_AGENT=WORKER "$T/hooks/post-checkout" "$ZERO" "$F" 1 2>"$T/s13.err"
grep -q "UNAUTHORIZED WORKTREE" "$T/s13.err" && ok "S13 unauthorized worktree warned" || bad "S13 unauthorized worktree warned"
grep -q '"authorized": false' "$T/alerts.jsonl" && ok "S13 unauthorized worktree logged" || bad "S13 unauthorized worktree logged"
HEDDLE_AGENT=LEAD FLEET_AGENT=LEAD "$T/hooks/post-checkout" "$ZERO" "$F" 1 2>"$T/s13b.err"
grep -q "UNAUTHORIZED" "$T/s13b.err" && bad "S13 LEAD's worktree not warned" || ok "S13 LEAD's worktree not warned"

# S14 worktree cap: warn mode lets commits through, block mode refuses non-LEAD
git switch -q feature
for i in $(seq 1 21); do mkdir -p "$T/wt/w$i"; done
echo w > w.txt; git add w.txt; git commit -qm "commit over cap (warn)" 2>"$T/s14.err"; rc=$?
expect_rc "S14 warn mode allows the commit" 0 $rc
grep -q "21 folders" "$T/s14.err" && ok "S14 warn names the count" || bad "S14 warn names the count"
python3 - "$T/guard.json" <<'PY'
import json, sys
p = sys.argv[1]; c = json.load(open(p)); c["worktree_cap_mode"] = "block"; json.dump(c, open(p, "w"))
PY
echo w2 > w2.txt; git add w2.txt
git commit -qm "commit over cap (block)" 2>"$T/s14b.err"; rc=$?
expect_nonzero "S14 block mode refuses a non-LEAD commit" $rc
HEDDLE_AGENT=LEAD FLEET_AGENT=LEAD git commit -qm "LEAD over cap" 2>/dev/null; rc=$?
expect_rc "S14 block mode lets LEAD commit" 0 $rc
python3 - "$T/guard.json" <<'PY'
import json, sys
p = sys.argv[1]; c = json.load(open(p)); c["worktree_cap_mode"] = "warn"; json.dump(c, open(p, "w"))
PY

# S15 chaining of post hooks
grep -q "^post-commit" "$T/chain.log" && ok "S15 post-commit chained" || bad "S15 post-commit chained"
grep -q "^post-checkout" "$T/chain.log" && ok "S15 post-checkout chained" || bad "S15 post-checkout chained"
grep -q "^post-merge" "$T/chain.log" && ok "S15 post-merge chained" || bad "S15 post-merge chained"

# S16 engine failure fails open and still chains
: > "$T/chain.log"
echo z > z.txt; git add z.txt
HEDDLE_GIT_GUARD_ALERT_LOG="$T/guard-errors.jsonl" HEDDLE_GIT_GUARD_CONFIG=/nonexistent/guard.json /usr/bin/python3 "$SRC/heddle_git_guard.py" post-commit 2>"$T/s16.err"; rc=$?
expect_rc "S16 engine error fails open" 0 $rc
grep -q "internal error" "$T/s16.err" && ok "S16 engine error is loud" || bad "S16 engine error is loud"
grep -q '"guard-error"' "$T/guard-errors.jsonl" 2>/dev/null && ok "S16 engine error logged inside the test folder" || bad "S16 engine error logged inside the test folder"
grep -q "^post-commit" "$T/chain.log" && ok "S16 chain still ran" || bad "S16 chain still ran"
git commit -qm "z" 2>/dev/null

# S17 self-test changes nothing and resolves the chain
before=$(git status --porcelain | wc -l)
HEDDLE_GIT_GUARD_CONFIG="$T/guard.json" /usr/bin/python3 "$SRC/heddle_git_guard.py" --selftest > "$T/s17.out" 2>&1; rc=$?
after=$(git status --porcelain | wc -l)
expect_rc "S17 self-test exits 0" 0 $rc
[ "$before" = "$after" ] && ok "S17 self-test changed nothing" || bad "S17 self-test changed nothing"

# S18 timing of a guarded commit
echo t > t.txt; git add t.txt
start=$(python3 -c 'import time; print(time.time())')
git commit -qm "timing" 2>/dev/null
end=$(python3 -c 'import time; print(time.time())')
python3 -c "print('INFO S18 guarded commit took %.2fs' % ($end - $start))"

echo "RESULT pass=$pass fail=$fail"
