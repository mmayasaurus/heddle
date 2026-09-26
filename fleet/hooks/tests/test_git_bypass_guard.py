#!/usr/bin/env python3
"""Fixture tests for git-bypass-guard.py. The guard runs as a subprocess, like a hook host.

Usage: test_git_bypass_guard.py [empty-dir]   (throwaway repositories are made there; a new
temporary folder is used when no folder is given; nothing is deleted)
"""
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
GUARD = os.environ.get("GIT_BYPASS_GUARD") or os.path.join(HERE, "..", "git-bypass-guard.py")


def sh(*args, cwd=None):
    subprocess.run(list(args), cwd=cwd, check=True, capture_output=True, text=True)


def make_repos(root):
    game = os.path.join(root, "game")
    other = os.path.join(root, "other")
    remote = os.path.join(root, "remote.git")
    os.makedirs(other)
    sh("git", "init", "-q", "-b", "main", game)
    sh("git", "-C", game, "config", "user.name", "t")
    sh("git", "-C", game, "config", "user.email", "t@example.invalid")
    with open(os.path.join(game, "a.txt"), "w") as fh:
        fh.write("a\n")
    sh("git", "-C", game, "add", "a.txt")
    sh("git", "-C", game, "commit", "-qm", "base")
    sh("git", "init", "-q", "--bare", remote)
    sh("git", "-C", game, "remote", "add", "origin", remote)
    sh("git", "-C", game, "push", "-q", "origin", "main")
    sh("git", "-C", game, "fetch", "-q", "origin")
    sh("git", "-C", game, "branch", "worker/feat")
    sh("git", "-C", game, "branch", "--track", "worker/track", "origin/main")
    return game, other


def run(cfg_path, command, agent, cwd, as_list=False):
    env = dict(os.environ, HEDDLE_AGENT=agent, FLEET_AGENT=agent, HEDDLE_BYPASS_GUARD_CONFIG=cfg_path)
    payload = {"tool_name": "Bash", "cwd": cwd,
               "tool_input": {"command": ["bash", "-lc", command] if as_list else command}}
    proc = subprocess.run([sys.executable, GUARD], input=json.dumps(payload), capture_output=True, text=True, env=env)
    return proc.returncode, proc.stderr.strip()


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix="git-bypass-guard-test-")
    os.makedirs(root, exist_ok=True)
    game, other = make_repos(root)
    cfg_path = os.path.join(root, "guard.json")
    with open(cfg_path, "w") as fh:
        json.dump({"orchestrator": "LEAD", "rule_owner": "the project owner",
                   "repos": [{"path": game, "remotes": ["example/game"]}]}, fh)
    unscoped = os.path.join(root, "unscoped.json")
    with open(unscoped, "w") as fh:
        json.dump({"orchestrator": "LEAD"}, fh)

    cases = [
        # (command, agent, cwd, head-branch-of-game, expect_block)
        ("git worktree add ../x -b worker/foo", "WORKER", game, None, True),
        ("git -C %s worktree add /tmp/w main" % game, "WORKER", other, None, True),
        ("cd %s && git worktree add ../z" % game, "WORKER", other, None, True),
        ("git worktree add ../x -b lead/foo origin/main", "LEAD", game, None, False),
        ("git worktree add ../q", "WORKER", other, None, False),
        ("git worktree list", "WORKER", game, None, False),
        ("git clone https://github.com/example/game.git", "WORKER", other, None, True),
        ("gh repo clone example/game", "WORKER", other, None, True),
        ("git clone %s %s/copy" % (game, other), "WORKER", other, None, True),
        ("git clone https://github.com/x/y.git", "WORKER", other, None, False),
        ("git clone https://github.com/x/y.git", "LEAD", game, None, False),
        ("git grep -n foo", "WORKER", other, None, True),
        ("git -C repo grep foo HEAD", "LEAD", other, None, True),
        ("git sparse-checkout set Game", "WORKER", other, None, True),
        ("git -c core.hooksPath=/dev/null commit -m x", "WORKER", other, None, True),
        ("git config core.hooksPath /tmp/none", "WORKER", other, None, True),
        ("GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/x git push", "WORKER", other, None, True),
        ("git commit -n -m wip", "WORKER", other, None, True),
        ("git commit -anm wip", "WORKER", other, None, True),
        ("git commit -am 'no n here'", "WORKER", other, None, False),
        ("git commit -m 'uses -n in message' -- file", "WORKER", other, None, False),
        ("git push --no-verify origin worker/x", "WORKER", other, None, True),
        ("git status && git grep foo", "WORKER", other, None, True),
        ("bash -c 'git grep foo'", "WORKER", other, None, True),
        ("git push origin worker/x", "WORKER", other, None, False),
        ("git log --oneline -5", "WORKER", other, None, False),
        ("rg --files", "WORKER", other, None, False),
        ("echo 'git grep is banned'", "WORKER", other, None, False),
        ("git merge origin/main", "WORKER", game, "worker/feat", True),
        ("git merge --no-edit main", "WORKER", game, "worker/feat", True),
        ("git pull origin main", "WORKER", game, "worker/feat", True),
        ("git -C %s pull origin main" % game, "WORKER", other, "worker/feat", True),
        ("git pull", "WORKER", game, "worker/track", True),
        ("git pull --rebase origin main", "WORKER", game, "worker/feat", False),
        ("git merge worker/other", "WORKER", game, "worker/feat", False),
        ("git pull origin main", "WORKER", game, "main", False),
        ("git merge origin/main", "LEAD", game, "worker/feat", True),
    ]
    passed = failed = 0
    for command, agent, cwd, head, expect in cases:
        if head:
            sh("git", "-C", game, "symbolic-ref", "HEAD", "refs/heads/" + head)
        rc, err = run(cfg_path, command, agent, cwd)
        blocked = rc == 2
        where = "game" if cwd == game else "other"
        if blocked == expect:
            passed += 1
            print("PASS %-5s %-6s %-5s %s" % ("block" if expect else "allow", agent, where, command))
        else:
            failed += 1
            print("FAIL wanted %-5s got rc=%d %-6s %-5s %s :: %s" % ("block" if expect else "allow", rc, agent, where, command, err))
    sh("git", "-C", game, "symbolic-ref", "HEAD", "refs/heads/main")

    def check(name, ok):
        nonlocal passed, failed
        if ok:
            passed += 1
            print("PASS " + name)
        else:
            failed += 1
            print("FAIL " + name)

    rc, _ = run(cfg_path, "git grep foo", "WORKER", other, as_list=True)
    check("list-form command is parsed", rc == 2)
    rc, _ = run(unscoped, "git worktree add /tmp/q", "WORKER", other)
    check("no repos listed: the worktree rule applies everywhere", rc == 2)
    rc, err = run(cfg_path, "git worktree add ../x", "WORKER", game)
    check("messages name the configured orchestrator and owner", "LEAD" in err and "the project owner" in err)
    proc = subprocess.run([sys.executable, GUARD], input="not json", capture_output=True, text=True)
    check("malformed payload fails open", proc.returncode == 0)
    print("RESULT pass=%d fail=%d (fixtures in %s)" % (passed, failed, root))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
