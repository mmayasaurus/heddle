#!/usr/bin/env python3
"""heddle git guard: git-level rule enforcement that binds every agent provider.

Claude, Codex and Cursor seats all run git, so rules enforced in git hooks bind
all of them at once. The repository opts in by pointing core.hooksPath at a
hooks directory whose small wrappers call this engine with a JSON config
(HEDDLE_GIT_GUARD_CONFIG). Nothing project-specific lives in this file.

Checks (each can be switched off in the config's "checks" map):
  no_main_merge       pre-merge-commit / pre-commit (conflicted merge) / pre-push:
                      refuse a merge on a non-main branch that brings in commits
                      from main's first-parent line.
  no_protected_paths  pre-commit / pre-push: refuse additions or modifications
                      under the protected paths, except on the allowed branches.
                      Deletions are always allowed.
  no_push_to_main     pre-push: refuse pushing to the main branch names.
  no_force_push       pre-push: refuse non-fast-forward updates of branches/tags.
  no_remote_delete    pre-push: refuse deleting a remote branch or tag.
  worktree_cap        pre-commit / pre-push: count the folders in worktrees_dir;
                      over the cap, warn (mode "warn") or refuse (mode "block").
                      Creators listed in worktree_creators are never refused.
  worktree_alert      post-checkout: a new worktree made by anyone not listed in
                      worktree_creators is reported loudly and to the alert log.
Backstops that cannot block (git gives these hooks no veto):
  post-commit         alert if the new commit touches protected paths
                      (it was made with --no-verify).
  post-merge          alert if the merge brought main commits into a
                      non-main branch (made with --no-verify).

After its own checks the engine runs the repository's own hook of the same
name from <git-common-dir>/hooks (for example the Git LFS hooks), with the
same arguments and standard input, so installing core.hooksPath never stops
an existing hook from running. A refused pre-* hook stops before the chain;
post-* hooks always chain.

Failure policy: if the engine itself errors, it prints a loud warning, logs
it, and still runs the chained hook (fail open), so a bug here can never stop
Git LFS from uploading objects or strand a seat's work locally.

Self-test (changes nothing): heddle_git_guard.py --selftest
"""

import fnmatch
import json
import os
import subprocess
import sys
import time

NULL_SHA = "0" * 40
BANNER = "=" * 72


# ---------------------------------------------------------------------------
# small helpers
# ---------------------------------------------------------------------------

def git(*args, check=False, input_text=None):
    proc = subprocess.run(
        ["git"] + list(args),
        input=input_text,
        capture_output=True,
        text=True,
    )
    if check and proc.returncode != 0:
        raise RuntimeError("git %s failed: %s" % (" ".join(args), proc.stderr.strip()))
    return proc


def git_out(*args):
    proc = git(*args)
    if proc.returncode != 0:
        return ""
    return proc.stdout.strip()


def load_config():
    path = os.environ.get("HEDDLE_GIT_GUARD_CONFIG", "")
    if not path:
        raise RuntimeError("HEDDLE_GIT_GUARD_CONFIG is not set")
    with open(os.path.expanduser(path)) as fh:
        cfg = json.load(fh)
    cfg.setdefault("checks", {})
    return cfg


def check_on(cfg, name):
    return bool(cfg.get("checks", {}).get(name, True))


def actor():
    for var in ("HEDDLE_AGENT", "FLEET_AGENT"):
        val = os.environ.get(var, "").strip()
        if val:
            return val
    return "unknown"


def owner(cfg):
    """Who set the rules, as named in messages (config "rule_owner")."""
    return cfg.get("rule_owner") or "the repository owner"


def orchestrator(cfg):
    """Who handles worktrees, merges and deletions (config "orchestrator")."""
    if cfg.get("orchestrator"):
        return cfg["orchestrator"]
    creators = cfg.get("worktree_creators") or []
    return creators[0] if creators else "the orchestrator"


def protected_reason(cfg):
    return cfg.get("protected_paths_reason") or "Agent and harness files do not belong in this repository"


def alert(cfg, event, **fields):
    record = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "repo": cfg.get("repo_label", ""),
        "event": event,
        "actor": actor(),
        "cwd": os.getcwd(),
    }
    record.update(fields)
    path = os.path.expanduser(cfg.get("alert_log", "~/.heddle/fleet/alerts/git-guard.jsonl"))
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "a") as fh:
            fh.write(json.dumps(record) + "\n")
    except Exception as exc:  # the alert log must never break git
        sys.stderr.write("heddle-git-guard: could not write alert log: %s\n" % exc)


def refuse(cfg, hook, rule, lines):
    sys.stderr.write("\n%s\nBLOCKED by heddle git guard (%s, rule %s)\n" % (BANNER, hook, rule))
    for line in lines:
        sys.stderr.write("  %s\n" % line)
    sys.stderr.write("%s\n\n" % BANNER)
    alert(cfg, "refused", hook=hook, rule=rule, detail=lines[:6])


def warn(lines):
    sys.stderr.write("\n%s\nWARNING from heddle git guard\n" % BANNER)
    for line in lines:
        sys.stderr.write("  %s\n" % line)
    sys.stderr.write("%s\n\n" % BANNER)


def current_branch():
    return git_out("symbolic-ref", "--short", "-q", "HEAD")


def main_tips(cfg):
    tips = []
    for ref in cfg.get("main_refs", ["refs/heads/main", "refs/remotes/origin/main"]):
        sha = git_out("rev-parse", "-q", "--verify", ref + "^{commit}")
        if sha:
            tips.append(sha)
    return tips


def is_main_branch(cfg, branch):
    return branch in cfg.get("main_branch_names", ["main", "master"])


def branch_allowed_for_protected(cfg, branch):
    for pattern in cfg.get("protected_paths_allowed_branches", []):
        if branch and fnmatch.fnmatchcase(branch, pattern):
            return True
    return False


def rev_set(*args):
    out = git_out("rev-list", *args)
    return set(out.split()) if out else set()


def main_commits_brought_in(cfg, base, incoming):
    """Commits on main's first-parent line that `incoming` adds on top of `base`."""
    tips = main_tips(cfg)
    if not tips:
        return set()
    main_fp = rev_set("--first-parent", *(tips + ["^" + base]))
    if not main_fp:
        return set()
    brought = rev_set(incoming, "^" + base)
    return main_fp & brought


# ---------------------------------------------------------------------------
# protected paths
# ---------------------------------------------------------------------------

def is_protected(cfg, path):
    spec = cfg.get("protected_paths", {})
    if path in spec.get("exact", []):
        return True
    for prefix in spec.get("prefixes", []):
        if path.startswith(prefix):
            return True
    for pattern in spec.get("globs", []):
        if fnmatch.fnmatchcase(path, pattern):
            return True
    return False


def parse_name_status_z(raw):
    """Parse `--name-status --no-renames -z` output into (status, path) pairs."""
    parts = raw.split("\0")
    pairs = []
    i = 0
    while i + 1 < len(parts):
        status, path = parts[i], parts[i + 1]
        if not status:
            break
        pairs.append((status[0], path))
        i += 2
    return pairs


def protected_changes(cfg, pairs):
    return [(s, p) for (s, p) in pairs if s != "D" and is_protected(cfg, p)]


# ---------------------------------------------------------------------------
# worktree cap
# ---------------------------------------------------------------------------

def worktree_count(cfg):
    base = os.path.expanduser(cfg.get("worktrees_dir", ""))
    if not base or not os.path.isdir(base):
        return None
    return sum(1 for name in os.listdir(base) if os.path.isdir(os.path.join(base, name)))


def worktree_cap_check(cfg, hook):
    """Returns True if the operation may continue."""
    if not check_on(cfg, "worktree_cap"):
        return True
    count = worktree_count(cfg)
    cap = int(cfg.get("worktree_cap", 20))
    if count is None or count <= cap:
        return True
    mode = cfg.get("worktree_cap_mode", "warn")
    lines = [
        "%d folders in %s; the cap is %d (rule set by %s)." % (count, cfg.get("worktrees_dir"), cap, owner(cfg)),
        "Only %s creates or removes worktrees and clones. Do not add any." % orchestrator(cfg),
    ]
    if mode == "block" and actor() not in cfg.get("worktree_creators", []):
        lines.append("Commits and pushes are refused until the count is back under the cap.")
        refuse(cfg, hook, "worktree_cap", lines)
        return False
    warn(lines)
    return True


# ---------------------------------------------------------------------------
# hook handlers; each returns 0 to continue (then chain) or non-zero to refuse
# ---------------------------------------------------------------------------

def merge_heads():
    """What is being merged into HEAD right now.

    A conflicted merge leaves MERGE_HEAD for the later `git commit`. During the
    automatic path git runs pre-merge-commit BEFORE writing MERGE_HEAD, so fall
    back to GIT_REFLOG_ACTION ("merge <names>" / "pull <remote> <names>") and,
    for pulls, the FETCH_HEAD lines that are marked for merging.
    """
    path = git_out("rev-parse", "--git-path", "MERGE_HEAD")
    if path and os.path.exists(path):
        with open(path) as fh:
            heads = [line.strip() for line in fh if line.strip()]
        if heads:
            return heads
    heads = []
    action = os.environ.get("GIT_REFLOG_ACTION", "").split()
    if action and action[0] in ("merge", "pull"):
        for token in action[1:]:
            if token.startswith("-"):
                continue
            sha = git_out("rev-parse", "-q", "--verify", token + "^{commit}")
            if sha:
                heads.append(sha)
        if action[0] == "pull":
            fetch_head = git_out("rev-parse", "--git-path", "FETCH_HEAD")
            if fetch_head and os.path.exists(fetch_head):
                with open(fetch_head) as fh:
                    for line in fh:
                        fields = line.split("\t")
                        if len(fields) >= 2 and fields[1] != "not-for-merge" and fields[0].strip():
                            heads.append(fields[0].strip())
    return heads


def check_in_progress_merge(cfg, hook):
    if not check_on(cfg, "no_main_merge"):
        return 0
    branch = current_branch()
    if not branch or is_main_branch(cfg, branch):
        return 0
    head = git_out("rev-parse", "-q", "--verify", "HEAD")
    if not head:
        return 0
    for incoming in merge_heads():
        brought = main_commits_brought_in(cfg, head, incoming)
        if brought:
            refuse(cfg, hook, "no_main_merge", [
                "This merge brings %d commit(s) from main into '%s'." % (len(brought), branch),
                "Main is never merged into a feature branch (rule set by %s). Undo it with: git merge --abort" % owner(cfg),
                "If your branch needs main's changes, ask %s to replay it onto main." % orchestrator(cfg),
            ])
            return 1
    return 0


def h_pre_merge_commit(cfg, args, stdin_bytes):
    return check_in_progress_merge(cfg, "pre-merge-commit")


def h_pre_commit(cfg, args, stdin_bytes):
    rc = check_in_progress_merge(cfg, "pre-commit")
    if rc:
        return rc
    if check_on(cfg, "no_protected_paths"):
        branch = current_branch()
        if not branch_allowed_for_protected(cfg, branch):
            raw = git("diff", "--cached", "--name-status", "--no-renames", "-z").stdout
            bad = protected_changes(cfg, parse_name_status_z(raw))
            if bad:
                lines = ["%s (rule set by %s). Staged:" % (protected_reason(cfg), owner(cfg))]
                lines += ["%s %s" % pair for pair in bad[:15]]
                if len(bad) > 15:
                    lines.append("... and %d more" % (len(bad) - 15))
                lines.append("Unstage them with: git restore --staged <path>. Deleting them is allowed.")
                refuse(cfg, "pre-commit", "no_protected_paths", lines)
                return 1
    if not worktree_cap_check(cfg, "pre-commit"):
        return 1
    return 0


def h_pre_push(cfg, args, stdin_bytes):
    text = stdin_bytes.decode("utf-8", "replace")
    main_names = cfg.get("main_branch_names", ["main", "master"])
    for line in text.splitlines():
        fields = line.split()
        if len(fields) != 4:
            continue
        local_ref, local_sha, remote_ref, remote_sha = fields
        is_branch = remote_ref.startswith("refs/heads/")
        is_tag = remote_ref.startswith("refs/tags/")
        short = remote_ref.split("/", 2)[-1] if (is_branch or is_tag) else remote_ref

        if local_sha == NULL_SHA:
            if check_on(cfg, "no_remote_delete"):
                refuse(cfg, "pre-push", "no_remote_delete", [
                    "Deleting '%s' on the remote is a deletion." % remote_ref,
                    "Remote deletions are refused here; %s runs them only after %s confirms each one." % (orchestrator(cfg), owner(cfg)),
                ])
                return 1
            continue

        if is_branch and short in main_names and check_on(cfg, "no_push_to_main"):
            refuse(cfg, "pre-push", "no_push_to_main", [
                "Pushing to '%s' is refused. Main changes only through a reviewed PR merged by %s." % (short, orchestrator(cfg)),
            ])
            return 1

        if remote_sha != NULL_SHA and (is_branch or is_tag) and check_on(cfg, "no_force_push"):
            known = git("cat-file", "-e", remote_sha + "^{commit}").returncode == 0
            if not known or git("merge-base", "--is-ancestor", remote_sha, local_sha).returncode != 0:
                refuse(cfg, "pre-push", "no_force_push", [
                    "'%s' on the remote has commits this push would discard (non-fast-forward)." % short,
                    "Never force-push. Fetch, then add your commits on top, or ask %s." % orchestrator(cfg),
                ])
                return 1

        if not is_branch:
            continue

        if remote_sha != NULL_SHA and git("cat-file", "-e", remote_sha + "^{commit}").returncode == 0:
            range_args = [local_sha, "^" + remote_sha]
            diff_base = remote_sha
        else:
            range_args = [local_sha, "--not", "--remotes"]
            tips = main_tips(cfg)
            diff_base = git_out("merge-base", local_sha, tips[0]) if tips else ""

        if check_on(cfg, "no_main_merge") and short not in main_names:
            merges = git_out("rev-list", "--merges", *range_args).split()
            for merge in merges:
                parents = git_out("rev-list", "--parents", "-n", "1", merge).split()[1:]
                if len(parents) < 2:
                    continue
                first = parents[0]
                for other in parents[1:]:
                    brought = main_commits_brought_in(cfg, first, other)
                    if brought:
                        refuse(cfg, "pre-push", "no_main_merge", [
                            "Commit %s on '%s' merges main into the branch (%d main commit(s))." % (merge[:12], short, len(brought)),
                            "Main is never merged into a feature branch (rule set by %s). Nothing was pushed." % owner(cfg),
                            "Ask %s to rebuild the branch from main without that merge." % orchestrator(cfg),
                        ])
                        return 1

        if check_on(cfg, "no_protected_paths") and not branch_allowed_for_protected(cfg, short) and diff_base:
            raw = git("diff", "--name-status", "--no-renames", "-z", diff_base, local_sha).stdout
            bad = protected_changes(cfg, parse_name_status_z(raw))
            if bad:
                lines = ["'%s' adds or changes protected files. %s (rule set by %s):" % (short, protected_reason(cfg), owner(cfg))]
                lines += ["%s %s" % pair for pair in bad[:15]]
                if len(bad) > 15:
                    lines.append("... and %d more" % (len(bad) - 15))
                refuse(cfg, "pre-push", "no_protected_paths", lines)
                return 1

    if not worktree_cap_check(cfg, "pre-push"):
        return 1
    return 0


def h_post_checkout(cfg, args, stdin_bytes):
    if len(args) >= 3 and args[0] == NULL_SHA and args[2] == "1" and check_on(cfg, "worktree_alert"):
        top = git_out("rev-parse", "--show-toplevel")
        count = worktree_count(cfg)
        who = actor()
        if who in cfg.get("worktree_creators", []):
            alert(cfg, "worktree-created", path=top, count=count, authorized=True)
        else:
            alert(cfg, "worktree-created", path=top, count=count, authorized=False)
            warn([
                "UNAUTHORIZED WORKTREE: %s was created by '%s'." % (top, who),
                "Only %s creates worktrees (cap of %s set by %s; folders now: %s)." % (orchestrator(cfg), cfg.get("worktree_cap", 20), owner(cfg), count),
                "Stop and tell %s now. Do NOT delete it yourself; deletions need %s's confirmation." % (orchestrator(cfg), owner(cfg)),
            ])
    return 0


def h_post_commit(cfg, args, stdin_bytes):
    if not check_on(cfg, "no_protected_paths"):
        return 0
    branch = current_branch()
    if branch_allowed_for_protected(cfg, branch):
        return 0
    raw = git("diff-tree", "--root", "--no-commit-id", "--name-status", "--no-renames", "-r", "-z", "HEAD").stdout
    bad = protected_changes(cfg, parse_name_status_z(raw))
    if bad:
        alert(cfg, "bypass-commit", branch=branch, paths=[p for _, p in bad[:15]])
        warn([
            "This commit on '%s' touches protected files and skipped the guard (--no-verify)." % branch,
            "It is logged for %s in %s. The push will be refused." % (orchestrator(cfg), cfg.get("alert_log", "the alert log")),
        ])
    return 0


def h_post_merge(cfg, args, stdin_bytes):
    if not check_on(cfg, "no_main_merge"):
        return 0
    branch = current_branch()
    if not branch or is_main_branch(cfg, branch):
        return 0
    parents = git_out("rev-list", "--parents", "-n", "1", "HEAD").split()[1:]
    if len(parents) < 2:
        return 0
    for other in parents[1:]:
        brought = main_commits_brought_in(cfg, parents[0], other)
        if brought:
            alert(cfg, "bypass-merge", branch=branch, commit=git_out("rev-parse", "HEAD"))
            warn([
                "Main was merged into '%s' (locally with the guard skipped, or on GitHub by 'Update branch')." % branch,
                "It is logged for %s in %s. The push will be refused." % (orchestrator(cfg), cfg.get("alert_log", "the alert log")),
            ])
            break
    return 0


HANDLERS = {
    "pre-merge-commit": h_pre_merge_commit,
    "pre-commit": h_pre_commit,
    "pre-push": h_pre_push,
    "post-checkout": h_post_checkout,
    "post-commit": h_post_commit,
    "post-merge": h_post_merge,
}


# ---------------------------------------------------------------------------
# chaining and entry point
# ---------------------------------------------------------------------------

def chained_hook(hook):
    common = git_out("rev-parse", "--git-common-dir")
    if not common:
        return None
    path = os.path.join(common, "hooks", hook)
    wrapper_dir = os.environ.get("HEDDLE_GIT_GUARD_WRAPPER_DIR", "")
    if os.path.isfile(path) and os.access(path, os.X_OK):
        if wrapper_dir and os.path.realpath(os.path.dirname(path)) == os.path.realpath(wrapper_dir):
            return None  # core.hooksPath points at .git/hooks itself: never call ourselves
        return path
    return None


def run_chain(hook, args, stdin_bytes):
    path = chained_hook(hook)
    if not path:
        return 0
    proc = subprocess.run([path] + list(args), input=stdin_bytes)
    return proc.returncode


def selftest():
    cfg = load_config()
    print("heddle git guard self-test (changes nothing)")
    print("  config:", os.environ.get("HEDDLE_GIT_GUARD_CONFIG"))
    print("  repo label:", cfg.get("repo_label"))
    print("  checks:", json.dumps(cfg.get("checks", {})))
    print("  main tips:", main_tips(cfg))
    print("  worktrees: %s of cap %s (mode %s)" % (worktree_count(cfg), cfg.get("worktree_cap"), cfg.get("worktree_cap_mode")))
    for hook in sorted(HANDLERS):
        print("  chain %-16s -> %s" % (hook, chained_hook(hook) or "(none)"))
    return 0


def main(argv):
    if len(argv) >= 2 and argv[1] == "--selftest":
        return selftest()
    if len(argv) < 2:
        sys.stderr.write("usage: heddle_git_guard.py <hook-name> [args...]\n")
        return 0
    hook, args = argv[1], argv[2:]
    stdin_bytes = sys.stdin.buffer.read() if hook == "pre-push" else b""
    rc = 0
    try:
        cfg = load_config()
        handler = HANDLERS.get(hook)
        if handler:
            rc = handler(cfg, args, stdin_bytes)
    except Exception as exc:  # fail open, loudly
        sys.stderr.write("\nheddle-git-guard: internal error in %s (%s); continuing without the guard.\n" % (hook, exc))
        try:
            alert({"alert_log": os.environ.get("HEDDLE_GIT_GUARD_ALERT_LOG", "~/.heddle/fleet/alerts/git-guard.jsonl")},
                  "guard-error", hook=hook, error=str(exc))
        except Exception:
            pass
        rc = 0
    if rc and hook.startswith("pre"):
        return rc
    chain_rc = run_chain(hook, args, stdin_bytes)
    return rc or chain_rc


if __name__ == "__main__":
    sys.exit(main(sys.argv))
