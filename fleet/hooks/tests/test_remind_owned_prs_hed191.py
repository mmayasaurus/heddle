#!/usr/bin/env python3
"""HED-191 regression guard for remind-owned-prs.py's background PR-list refresh.

The refresh once used subprocess.Popen(shell=True) with the worktree DIRECTORY NAME
interpolated into the shell string -> command injection / local RCE (runs on every
UserPromptSubmit). It was parameterized to an isolated argv `python -I -c` helper.

This guard fails if that hardening is ever reverted. It is intentionally dependency-free
and runnable standalone (`python3 test_remind_owned_prs_hed191.py`; exit 0 = pass) so it
works even before the Workspace repo wires .claude/hooks tests into CI (follow-up).

Two layers checked:
  1. STRUCTURAL — the source must not contain shell=True, must spawn the refresh as an
     isolated argv list ([sys.executable, "-I", "-c", ...]), and must not run that helper
     with cwd=toplevel (which would put the worktree root on sys.path[0] -> import RCE).
  2. BEHAVIOURAL — the same argv-helper shape, exercised with an injection payload in the
     cache path AND a planted subprocess.py, executes neither.
"""
import os
import re
import subprocess  # nosec B404 - stdlib; used only to RUN the hardened helper under test (argv, no shell)
import sys
import tempfile
from pathlib import Path

HOOK = Path(__file__).resolve().parent.parent / "remind-owned-prs.py"


def _structural(src: str) -> list[str]:
    # Strip line comments so the checks match CODE, not the hook's explanatory comments (which
    # mention cwd=CACHE_DIR / cwd=toplevel). Adequate here: the hook's string literals contain no '#'.
    code = re.sub(r"(?m)#.*$", "", src)
    errs = []
    if re.search(r"shell\s*=\s*True", code):
        errs.append("shell=True must never appear (command-injection vector)")
    if not re.search(r"Popen\(\s*\[\s*sys\.executable\s*,\s*['\"]-I['\"]\s*,\s*['\"]-c['\"]", code):
        errs.append("the refresh must spawn [sys.executable, '-I', '-c', ...] (isolated argv)")
    if re.search(r"cwd\s*=\s*toplevel\b", code):
        errs.append("the -c helper must not run with cwd=toplevel (sys.path[0] import RCE)")
    # Load-bearing on Python 3.4-3.10, where -I does NOT imply -P and `python -c` still puts cwd on
    # sys.path[0]: the refresh interpreter's cwd MUST be CACHE_DIR (only ever holds .txt/.stamp/.tmp),
    # never the worktree root. Require it explicitly so simply DROPPING the kwarg (Popen would then
    # inherit the hook's worktree cwd) is caught too, not only a literal cwd=toplevel.
    if not re.search(r"cwd\s*=\s*(?:str\(\s*)?CACHE_DIR", code):
        errs.append("the refresh Popen must set cwd=CACHE_DIR (never inherit the worktree cwd; -I alone is insufficient <3.11)")
    return errs


def _behavioural() -> list[str]:
    # NOTE: this exercises the argv/isolated PATTERN (proving injection + planted-import are inert);
    # it does NOT import or run the hook, so it cannot by itself catch a production regression. The
    # AUTHORITATIVE regression guard for the actual hook is _structural() above (no shell=True; the
    # refresh spawns [-I, -c] argv; cwd=CACHE_DIR; never cwd=toplevel). A full hook-execution test
    # needs a fake git repo + the hook's stdin contract and is deferred with CI-wiring.
    helper = (
        "import subprocess,sys,os\n"
        "own,tmp,cache,top=sys.argv[1],sys.argv[2],sys.argv[3],sys.argv[4]\n"
        "try:\n"
        "    with open(tmp,'wb') as f:\n"
        "        rc=subprocess.run([own,'mine'],stdout=f,stderr=subprocess.DEVNULL,cwd=top).returncode\n"
        "    if rc==0:\n"
        "        os.replace(tmp,cache)\n"
        "    else:\n"
        "        os.unlink(tmp)\n"
        "except Exception:\n"
        "    try:\n"
        "        os.unlink(tmp)\n"
        "    except OSError:\n"
        "        pass\n"
    )
    errs = []
    cache_d = tempfile.mkdtemp()
    top = tempfile.mkdtemp()
    own = os.path.join(cache_d, "pr-own.sh")
    with open(own, "w") as f:
        f.write('#!/bin/sh\necho "OWNED-LIST"\n')
    os.chmod(own, 0o700)  # nosec B103 (owner rwx only, throwaway temp fixture) # nosemgrep: python.lang.security.audit.insecure-file-permissions.insecure-file-permissions -- 0o700 is minimal for an EXECUTABLE fixture; semgrep's suggested 0o644 cannot execute
    # planted subprocess.py in the -c interpreter's cwd must NOT run (isolated mode)
    with open(os.path.join(cache_d, "subprocess.py"), "w") as f:
        f.write('open(%r,"w").write("x")\n' % os.path.join(cache_d, "IMPORT_RCE"))
    # normal refresh
    tmp1 = os.path.join(cache_d, "c.tmp")
    cache1 = os.path.join(cache_d, "cache.txt")
    subprocess.run([sys.executable, "-I", "-c", helper, own, tmp1, cache1, top], cwd=cache_d)  # nosec B603 (argv, no shell) # nosemgrep: python.lang.security.audit.dangerous-subprocess-use-audit.dangerous-subprocess-use-audit -- argv list, no shell, fixture-only inputs; runs the -I isolated helper to PROVE the fix
    if not os.path.exists(cache1) or open(cache1).read().strip() != "OWNED-LIST":
        errs.append("normal refresh did not populate the cache atomically")
    if os.path.exists(tmp1):
        errs.append("tmp file not cleaned after refresh")
    if os.path.exists(os.path.join(cache_d, "IMPORT_RCE")):
        errs.append("planted subprocess.py executed (isolation broken)")
    # dirname / cache-path injection: metacharacters in the cache path (which in production
    # DERIVES from the worktree DIRECTORY NAME) must be inert — no command may execute for any of
    # these classic shell payloads. Under argv (no shell) they are literal filename characters.
    for i, payload in enumerate(("x; touch %s ; y", "x && touch %s # ", "x`touch %s`y", "x$(touch %s)y", "x> %s y")):
        sentinel = os.path.join(cache_d, "INJECT_%d" % i)
        evil = os.path.join(cache_d, (payload % sentinel) + ".txt")
        subprocess.run([sys.executable, "-I", "-c", helper, own, os.path.join(cache_d, "c2_%d.tmp" % i), evil, top], cwd=cache_d)  # nosec B603 (argv, no shell) # nosemgrep: python.lang.security.audit.dangerous-subprocess-use-audit.dangerous-subprocess-use-audit -- feeds a metacharacter payload and asserts it did NOT execute
        if os.path.exists(sentinel):
            errs.append("cache-path metacharacters executed via payload %r (injection not closed)" % payload)
    return errs


def main() -> int:
    errs = _structural(HOOK.read_text()) + _behavioural()
    if errs:
        print("FAIL (HED-191 guard):")
        for e in errs:
            print("  -", e)
        return 1
    print("PASS: HED-191 shell-injection guard (no shell=True; isolated argv refresh; injection + import RCE closed)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
