#!/usr/bin/env python3
"""
SessionStart hook — inject this session's durable FLEET IDENTITY (Agent A..L)
at every session start, resume, /clear, and — critically — after every
compaction, so an instance never "forgets" who it is however long it runs.

Identity is RE-DERIVED FROM DISK every time, never from model memory: the
session's /rename label (a `custom-title` record in the transcript .jsonl —
the exact record resume-sessions-v2.sh already relies on) IS the fleet letter.
A session with no short label is not a fleet agent → inject nothing, silently.

Output contract (SessionStart, mirrors remind-owned-prs.py):
    {"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"..."}}
    or "{}" for nothing. ALWAYS exit 0 — identity is a reminder, never worth
    blocking a session start. No network on the hot path.

Side effect: writes ~/.claude/fleet-identity-cache/<session_id>.label so other
tooling (lin.sh, per-turn reminder hooks) can read the letter without
rescanning the transcript.
"""
import json
import os
import pathlib
import subprocess
import sys
import time

CACHE_DIR = pathlib.Path(os.path.expanduser("~/.claude/fleet-identity-cache"))
CACHE_TTL_SECS = 24 * 3600  # a /rename mid-session is rare; rescan at most daily
FLEET_DIR = pathlib.Path(os.path.expanduser("~/.claude/spinventory-fleet"))


def claimed_issues(label: str) -> list[str] | None:
    """Best-effort list of this agent's currently-claimed Linear issues.

    Hard 3s network budget and NO token minting here — a session start must
    never wait on OAuth. Returns None when the answer is unknown (no/stale
    token, network trouble); lin.sh re-mints on first real use."""
    try:
        cache = FLEET_DIR / f"token-{label}.json"
        if not cache.exists():
            return None
        tok = json.loads(cache.read_text())
        if (time.time() - cache.stat().st_mtime) > tok.get("expires_in", 0) - 3600:
            return None
        import urllib.request
        q = json.dumps({"query":
            '{ issues(filter:{ delegate:{ isMe:{ eq:true } }, '
            'state:{ type:{ in:["backlog","unstarted","started"] } } }, first:15) '
            '{ nodes { identifier state { name } } } }'}).encode()
        req = urllib.request.Request(
            "https://api.linear.app/graphql", data=q,
            headers={"Authorization": f"Bearer {tok['access_token']}",
                     "Content-Type": "application/json"})
        out = json.load(urllib.request.urlopen(req, timeout=3))
        return [f"{n['identifier']} ({n['state']['name']})"
                for n in out["data"]["issues"]["nodes"]]
    except Exception:
        return None


def emit(ctx: str | None = None) -> None:
    if ctx:
        print(json.dumps({
            "hookSpecificOutput": {
                "hookEventName": "SessionStart",
                "additionalContext": ctx,
            }
        }))
    else:
        print("{}")
    sys.exit(0)


def label_from_transcript(path: str) -> str | None:
    """Last custom-title record wins — same parse as resume-sessions-v2.sh.
    Substring prefilter keeps the scan cheap on multi-hundred-MB transcripts."""
    label = None
    try:
        with open(path, "r", errors="replace") as f:
            for line in f:
                if '"custom-title"' not in line:
                    continue
                try:
                    o = json.loads(line)
                except Exception:
                    continue
                if o.get("type") == "custom-title":
                    v = o.get("customTitle")
                    if isinstance(v, str):
                        label = v.strip()
    except OSError:
        return None
    if label and 1 <= len(label) <= 3:  # fleet tags are short (A..L); long titles aren't identities
        return label
    return None


def worktree_owner(cwd: str) -> str | None:
    """Same identity rule as pr-own.sh whoami: worktree basename, prefix stripped."""
    try:
        top = subprocess.run(
            ["git", "-C", cwd, "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, timeout=3,
        )
        if top.returncode != 0 or not top.stdout.strip():
            return None
        base = os.path.basename(top.stdout.strip())
    except Exception:
        return None
    prefix = "Rebuild-Project-Root."
    if base.startswith(prefix):
        return base[len(prefix):]
    if base == "Rebuild-Project-Root":
        return "main"
    # heddle repos (HED-82): bare checkout → "main"; sibling <repo>.<slug>
    # (transitional) → <slug>; the in-repo .worktrees/<slug> layout falls
    # through to `return base`, which is already the <slug>.
    for _repo in ("heddle-dashboard", "heddle"):
        if base == _repo:
            return "main"
        if base.startswith(_repo + "."):
            return base[len(_repo) + 1:]
    return base


def main() -> None:
    try:
        try:
            payload = json.load(sys.stdin)
        except Exception:
            payload = {}

        session_id = payload.get("session_id") or ""
        transcript = payload.get("transcript_path") or ""
        cwd = payload.get("cwd") or os.getcwd()

        # Scan the transcript FIRST (fast — ~100ms even on huge files) so a
        # /rename always takes effect at the very next start/resume/compaction;
        # the cache is only a fallback for missing/unreadable transcripts.
        label = None
        cache = CACHE_DIR / f"{session_id}.label" if session_id else None
        if transcript and os.path.exists(transcript):
            label = label_from_transcript(transcript)
        if not label and cache and cache.exists() \
                and (time.time() - cache.stat().st_mtime) < CACHE_TTL_SECS:
            cached = cache.read_text().strip()
            if 1 <= len(cached) <= 3:
                label = cached
        if label and cache:
            CACHE_DIR.mkdir(parents=True, exist_ok=True)
            cache.write_text(label)  # refresh so per-turn readers see the current letter

        if not label:
            emit()  # not a fleet session — stay silent

        wt = worktree_owner(cwd)
        wt_line = (
            f"Your PR-ownership id is worktree-derived (pr-own.sh whoami), currently '{wt}'."
            if wt else
            "Your PR-ownership id is worktree-derived (pr-own.sh whoami from wherever you run it)."
        )
        issues = claimed_issues(label)
        if issues:
            iss_line = (f"Linear issues currently claimed by you: {', '.join(issues)} — "
                        f"drive each to done or release it (`.claude/bin/lin.sh`).")
        elif issues == []:
            iss_line = (f"You have no Linear issues claimed right now "
                        f"(`.claude/bin/lin.sh --agent {label} list` shows ready work).")
        else:
            iss_line = (f"Check your claimed Linear issues: "
                        f"`.claude/bin/lin.sh --agent {label} mine`.")
        ctx = (
            f"⟢ FLEET IDENTITY — You are **Agent {label}**. This is durable: it is re-derived "
            f"from your session's /rename label on disk at every session start, resume, and "
            f"compaction — if your memory of who you are ever conflicts with this line, this "
            f"line wins. Sign PR comments and coordination messages as '[Agent {label}]', and "
            f"act in Linear as yourself (lin.sh --agent {label}). "
            f"{wt_line} "
            f"{iss_line} "
            f"⟢ You are a **heddle orchestrator**: claim issues, decompose them, and DELEGATE "
            f"the coding/labor to best-fit models via the heddle MCP tools (`dispatch_worker`; "
            f"HARD DEFAULT, Maya 2026-08-15: your ORCHESTRATOR turns are for JUDGMENT — decomposition, acceptance "
            f"criteria, reviewing worker output, integration, policy/security semantics. LABOR — "
            f"scaffolds, test bodies, ports, codemods, docs, research, mechanical edits — goes to "
            f"workers; before hand-writing code ask 'could a worker do this from my spec?'. "
            f"Every dispatch is ledgered (agent=<your letter>) and per-turn hooks show your count. "
            f"`list_task_classes` for options) rather than doing it all yourself — do the high-level "
            f"spec + integration, and step in directly only where your own judgment is needed. "
            f"Full protocol: run `/orchestrate`. "
            f"Use Memtrace FIRST for code discovery, impact, and history — find_symbol / "
            f"find_code before grep/glob/read (Commandment #2; Serena's symbol tools are the "
            f"approved complement). "
            f"Protocols: .claude/rules/pr-ownership.md, .claude/rules/issue-tracking.md, MEMTRACE.md."
        )
        emit(ctx)
    except Exception:
        # Never block a session start over a reminder.
        try:
            print("{}")
        except Exception:
            pass
        sys.exit(0)


if __name__ == "__main__":
    main()
