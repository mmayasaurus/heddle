#!/usr/bin/env python3
"""git-bypass-guard: PreToolUse guard for shell commands, for Claude Code and Codex seats.

Reads the hook payload (JSON on stdin: tool_input.command and cwd) and refuses, with exit
code 2 and a reason on stderr, commands that would switch off the git-level guard
(heddle_git_guard.py) or break the fleet's git rules:

  * core.hooksPath overrides: `git -c core.hooksPath=...`, `git config ... core.hooksPath`,
    GIT_CONFIG_* environment overrides naming hooksPath    (would switch the guard off)
  * --no-verify on commit, merge, push, rebase, pull, cherry-pick, revert and am, and
    `git commit -n`                                        (would skip the guard)
  * git merge <main>, git pull <remote> <main>, and a plain `git pull` whose upstream is
    main, on any branch other than main                    (config "ban_main_merge")
  * git grep                                               (config "ban_git_grep")
  * git sparse-checkout                                    (config "ban_sparse_checkout")
  * git worktree add / move, git clone, gh repo clone     (only the orchestrator; scoped)

Configuration is a JSON file named by HEDDLE_BYPASS_GUARD_CONFIG, else
~/.heddle/fleet/hooks/git-bypass-guard.json. Every key is optional:

  {
    "orchestrator": "LEAD",              may create worktrees and clones in scoped repos
    "rule_owner": "the project owner",   named in messages
    "repos": [                           scope of the worktree/clone rule; absent = everywhere
      {"path": "/path/to/repo", "remotes": ["owner/name"]}
    ],
    "main_branch_names": ["main", "master"],
    "ban_main_merge": true,
    "ban_git_grep": true,
    "ban_sparse_checkout": true
  }

A worktree or clone command is in scope when its directory (the payload cwd, changed by a
preceding `cd` and by `git -C`) or any path argument lies inside a listed repo path, or an
argument names a listed remote. The acting seat comes from HEDDLE_AGENT / FLEET_AGENT.
Anything unparseable is allowed (fail open), as the git-level hooks still apply.
Standard library only; Python 3.9+.
"""

import json
import os
import re
import shlex
import subprocess
import sys

SEGMENT_SPLIT = re.compile(r"&&|\|\||[;|&\n]")
HOOK_SKIPPING = ("commit", "merge", "push", "rebase", "pull", "cherry-pick", "revert", "am")


def load_config():
    path = os.environ.get("HEDDLE_BYPASS_GUARD_CONFIG") or os.path.expanduser(
        "~/.heddle/fleet/hooks/git-bypass-guard.json")
    try:
        with open(os.path.expanduser(path)) as fh:
            cfg = json.load(fh)
        return cfg if isinstance(cfg, dict) else {}
    except (OSError, ValueError):
        return {}


def actor():
    for var in ("HEDDLE_AGENT", "FLEET_AGENT"):
        val = os.environ.get(var, "").strip()
        if val:
            return val
    return ""


def resolve(base, path):
    return os.path.normpath(os.path.join(base, os.path.expanduser(path)))


def git_line(cwd, *args):
    try:
        proc = subprocess.run(["git", "-C", cwd] + list(args), capture_output=True, text=True, timeout=5)
    except Exception:
        return ""
    return proc.stdout.strip() if proc.returncode == 0 else ""


def merges_main(cfg, sub, rest, cwd):
    """For `git merge ...` / `git pull ...` run in cwd: the branch main would be merged into, else ''."""
    names = cfg.get("main_branch_names") or ["main", "master"]
    opts = [w for w in rest if w.startswith("-")]
    args = [w for w in rest if not w.startswith("-")]
    if sub == "pull":
        if any(o in ("--rebase", "-r") or (o.startswith("--rebase=") and o != "--rebase=false") for o in opts):
            return ""
        if args:
            args = args[1:]  # the first argument is the remote
        else:
            upstream = git_line(cwd, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")
            args = [upstream] if upstream else []
    if not any(a == n or a.endswith("/" + n) for a in args for n in names):
        return ""
    branch = git_line(cwd, "symbolic-ref", "--short", "-q", "HEAD")
    return branch if branch and branch not in names else ""


def inside(path, root):
    for a, b in ((os.path.normpath(path), os.path.normpath(root)),
                 (os.path.realpath(path), os.path.realpath(root))):
        if a == b or a.startswith(b.rstrip(os.sep) + os.sep):
            return True
    return False


def in_scope(cfg, cwd, args):
    """Is a worktree/clone command with these arguments aimed at a scoped repository?"""
    repos = cfg.get("repos")
    if not repos:
        return True
    for repo in repos:
        root = os.path.expanduser(repo.get("path", ""))
        remotes = [r.lower() for r in repo.get("remotes", []) if r]
        if root and inside(cwd, root):
            return True
        for arg in args:
            if arg.startswith("-"):
                continue
            if root and inside(resolve(cwd, arg), root):
                return True
            low = arg.lower()
            if any(r in low for r in remotes):
                return True
    return False


def git_subcommand(words, cwd):
    """For ['git', '-C', 'x', '-c', 'k=v', 'commit', ...] return ('commit', rest, cwd after -C)."""
    i = 1
    while i < len(words):
        w = words[i]
        if w in ("-C", "-c", "--git-dir", "--work-tree", "--namespace"):
            if w == "-C" and i + 1 < len(words):
                cwd = resolve(cwd, words[i + 1])
            i += 2
            continue
        if w.startswith("-"):
            i += 1
            continue
        return w, words[i + 1:], cwd
    return "", [], cwd


def check_segment(cfg, seg, cwd):
    """Return (reason or None, cwd after this segment)."""
    seg = seg.strip()
    if not seg:
        return None, cwd
    owner = cfg.get("rule_owner") or "the repository owner"
    orchestrator = cfg.get("orchestrator") or "the orchestrator"
    if re.search(r"core\.hookspath", seg, re.IGNORECASE):
        return "Changing or overriding core.hooksPath switches off the git guard. Refused.", cwd
    try:
        words = shlex.split(seg)
    except ValueError:
        words = seg.split()
    # skip leading env assignments and wrappers
    while words and (re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", words[0]) or words[0] in ("env", "command", "time", "nice", "sudo")):
        words = words[1:]
    if not words:
        return None, cwd
    prog = os.path.basename(words[0])
    if prog in ("cd", "pushd"):
        target = words[1] if len(words) > 1 else "~"
        if target != "-":
            cwd = resolve(cwd, target)
        return None, cwd
    is_orch = bool(cfg.get("orchestrator")) and actor() == cfg.get("orchestrator")
    creation = "Only %s creates %s here (rule set by %s). Ask %s."
    if prog == "gh" and len(words) >= 3 and words[1] == "repo" and words[2] == "clone":
        if not is_orch and in_scope(cfg, cwd, words[3:]):
            return creation % (orchestrator, "clones", owner, orchestrator), cwd
        return None, cwd
    if prog != "git":
        return None, cwd
    sub, rest, git_cwd = git_subcommand(words, cwd)
    if sub == "grep" and cfg.get("ban_git_grep", True):
        return "git grep is refused by this machine's guard (ban_git_grep). Search files with rg instead.", cwd
    if sub == "sparse-checkout" and cfg.get("ban_sparse_checkout", True):
        return "git sparse-checkout is refused: it deletes ignored-only folders outside the cone.", cwd
    if sub in ("merge", "pull") and cfg.get("ban_main_merge", True):
        branch = merges_main(cfg, sub, rest, git_cwd)
        if branch:
            return ("Merging main into '%s' is refused (rule set by %s). Ask %s to replay the branch "
                    "onto main instead." % (branch, owner, orchestrator)), cwd
    if sub == "clone" and not is_orch and in_scope(cfg, git_cwd, rest):
        return creation % (orchestrator, "clones", owner, orchestrator), cwd
    if sub == "worktree" and rest and rest[0] in ("add", "move") and not is_orch and in_scope(cfg, git_cwd, rest[1:]):
        return creation % (orchestrator, "or moves worktrees", owner, orchestrator), cwd
    if sub in HOOK_SKIPPING:
        if "--no-verify" in rest:
            return "Skipping git hooks is refused; the hooks enforce the rules set by %s." % owner, cwd
        if sub == "commit":
            for w in rest:
                if w == "--":
                    break
                if re.match(r"^-[a-zA-Z]*n[a-zA-Z]*$", w) and not w.startswith("--"):
                    return "`git commit -n` skips git hooks (it is --no-verify). Refused.", cwd
    return None, cwd


def evaluate(cfg, command, cwd):
    for seg in SEGMENT_SPLIT.split(command):
        reason, cwd = check_segment(cfg, seg, cwd)
        if reason:
            return reason
    # nested shells: bash -c "..." / sh -c '...'
    for m in re.finditer(r"\b(?:ba|z)?sh\s+-l?c\s+(\"[^\"]*\"|'[^']*')", command):
        reason = evaluate(cfg, m.group(1)[1:-1], cwd)
        if reason:
            return reason
    return None


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0
    if not isinstance(payload, dict):
        return 0
    tool_input = payload.get("tool_input") or {}
    command = tool_input.get("command") if isinstance(tool_input, dict) else None
    if isinstance(command, list):
        parts = [str(part) for part in command]
        if len(parts) >= 3 and os.path.basename(parts[0]) in ("bash", "sh", "zsh") and parts[1] in ("-c", "-lc", "-ic"):
            command = parts[2]
        else:
            command = shlex.join(parts)
    if not isinstance(command, str) or not command.strip():
        return 0
    cwd = payload.get("cwd") if isinstance(payload.get("cwd"), str) and payload.get("cwd") else os.getcwd()
    reason = evaluate(load_config(), command, cwd)
    if reason:
        sys.stderr.write("BLOCKED BY HEDDLE GIT-BYPASS GUARD: %s\n" % reason)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
