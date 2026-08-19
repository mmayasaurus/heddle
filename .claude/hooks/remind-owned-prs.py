#!/usr/bin/env python3
"""
UserPromptSubmit hook — surface the PRs THIS worktree owns, every turn, so an
agent (especially a freshly-compacted one, whose memory of its own PRs just
reset) doesn't forget them or collide on someone else's. Companion to
`.claude/rules/pr-ownership.md` + `.claude/bin/pr-own.sh`.

Output contract (verified against memtrace/hooks/userprompt-claude.sh and the
Claude Code UserPromptSubmit validator):
    print {"hookSpecificOutput":{"hookEventName":"UserPromptSubmit",
                                 "additionalContext":"..."}}   to inject context
    print "{}" (or nothing)                                    to inject nothing
    ALWAYS exit 0 — never exit 2 (that would block the user's prompt).

Non-blocking by design: this hook fires on every turn, so it must never wait on
the network. It reads a short-TTL cache of `pr-own.sh mine`; when the cache is
stale it kicks off a DETACHED background refresh and uses whatever cache exists
this turn. `gh` is therefore never on the prompt's hot path. A `.stamp` file
debounces refreshes so rapid turns don't spawn a thundering herd.

Fail-open: ANY error → inject nothing, exit 0. A reminder is never worth
blocking or slowing a prompt.
"""
import json
import os
import pathlib
import subprocess
import sys
import time

TTL_SECS = 300  # refresh the owned-PR list at most once per this window, per worktree
PR_OWN = "/Users/mayatobi/Developer/Spinventory-Rebuild-App/.claude/bin/pr-own.sh"
CACHE_DIR = pathlib.Path(os.path.expanduser("~/.claude/pr-own-cache"))
IDENTITY_CACHE = pathlib.Path(os.path.expanduser("~/.claude/fleet-identity-cache"))


def fleet_label(session_id: str, transcript_path: str = "") -> str | None:
    """Fleet letter for this session.

    Fast path: the cache file written by the SessionStart identity hook.
    Fallback (covers `/rename A` in a BRAND-NEW conversation, where SessionStart
    fired before the rename existed): scan the transcript for the last
    custom-title record and write the cache so later turns are file-read only.
    A `.nolabel` stamp debounces rescans of genuinely unlabelled sessions."""
    try:
        if not session_id:
            return None
        f = IDENTITY_CACHE / f"{session_id}.label"
        if f.exists():
            v = f.read_text().strip()
            if 1 <= len(v) <= 3:
                return v
        stamp = IDENTITY_CACHE / f"{session_id}.nolabel"
        if stamp.exists() and (time.time() - stamp.stat().st_mtime) < 300:
            return None
        if not transcript_path or not os.path.exists(transcript_path):
            return None
        label = None
        with open(transcript_path, "r", errors="replace") as fh:
            for line in fh:
                if '"custom-title"' not in line:
                    continue
                try:
                    o = json.loads(line)
                except Exception:
                    continue
                if o.get("type") == "custom-title" and isinstance(o.get("customTitle"), str):
                    label = o["customTitle"].strip()
        IDENTITY_CACHE.mkdir(parents=True, exist_ok=True)
        if label and 1 <= len(label) <= 3:
            f.write_text(label)
            return label
        stamp.touch()
    except Exception:
        pass
    return None


def emit(ctx: str | None = None) -> None:
    """Emit the UserPromptSubmit JSON (context or nothing) and exit 0."""
    if ctx:
        print(json.dumps({
            "hookSpecificOutput": {
                "hookEventName": "UserPromptSubmit",
                "additionalContext": ctx,
            }
        }))
    else:
        print("{}")
    sys.exit(0)


def worktree_owner(toplevel: str) -> str:
    """Same identity rule as pr-own.sh: worktree basename, prefix stripped."""
    base = os.path.basename(toplevel)
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


def delegation_nudge(label: str) -> str:
    """Per-turn heddle reinforcement (Maya 2026-08-15: 'most work with the least usage').

    Reads the heddle dispatch ledger for THIS agent's dispatches in the last 2h and the
    live shared Claude cap from the statusline tap, and returns a one-line, data-driven
    nudge. Zero dispatches → loud reminder; otherwise a compact scoreboard. Best-effort
    (≤~50ms, no network): any failure returns "" so it can never break a turn."""
    try:
        import sqlite3
        home = os.path.expanduser("~")
        n = None
        led = os.path.join(home, ".heddle", "ledger.db")
        mix = ""
        if os.path.exists(led):
            con = sqlite3.connect(f"file:{led}?mode=ro", uri=True, timeout=0.2)
            try:
                n = con.execute(
                    "SELECT COUNT(*) FROM dispatches WHERE orchestrator=? "
                    "AND started_at >= datetime('now','-2 hours')", (label,)).fetchone()[0]
                # Provider mix over 8h: monoculture is the anti-goal (Maya 2026-08-17: "the entire
                # point of this whole build" is spreading labor across Cursor/Gemini/Codex pools).
                rows = con.execute(
                    "SELECT provider, COUNT(*) FROM dispatches WHERE orchestrator=? "
                    "AND started_at >= datetime('now','-8 hours') GROUP BY provider", (label,)).fetchall()
                if rows:
                    by = {p: c for p, c in rows}
                    parts = [f"{p} {by[p]}" for p in sorted(by, key=by.get, reverse=True)]
                    mix = " · 8h mix: " + " / ".join(parts)
                    total8 = sum(by.values())
                    if by.get("codex", 0) == total8 and total8 >= 3:
                        mix += " — MONOCULTURE: route by task CLASS (scaffold→cursor, docs→gemini, review→grok), not direct:codex"
                    elif by.get("cursor", 0) == 0 and by.get("gemini", 0) == 0 and total8 >= 5:
                        mix += " — cursor+gemini idle: prefer class routing over direct provider picks"
            finally:
                con.close()
        cap = ""
        cf = os.path.join(home, ".heddle", "usage", "claude.json")
        if os.path.exists(cf):
            d = json.load(open(cf))
            fh = (d.get("rate_limits") or {}).get("five_hour") or {}
            if fh.get("used_percentage") is not None:
                cap = f" · shared Claude 5h cap {int(fh['used_percentage'])}%"
        if n is None:
            return ""
        if n == 0:
            return (f"⟢ ⚠️ DELEGATION: you have dispatched 0 workers in the last 2h{cap}. Orchestrator turns are for "
                    f"judgment; LABOR (scaffolds, tests, ports, docs, research, mechanical edits) goes to "
                    f"`mcp__heddle__dispatch_worker` (agent=\"{label}\"; `list_task_classes` for routes). "
                    f"Before hand-writing code, ask: could a worker do this from my spec? ")
        return f"⟢ delegation: {n} worker dispatch(es) last 2h{cap}{mix} — keep labor on workers, judgment on the orchestrator. "
    except Exception:
        return ""


def main() -> None:
    try:
        # stdin carries session_id (for the fleet-identity lookup); prompt text unused.
        try:
            payload = json.load(sys.stdin)
        except Exception:
            payload = {}
        label = fleet_label(payload.get("session_id") or "",
                            payload.get("transcript_path") or "")
        id_line = (
            f"⟢ You are Agent {label} (fleet identity — sign as '[Agent {label}]', "
            f"lin.sh --agent {label}). Use Memtrace FIRST for code discovery, impact, and "
            f"history — find_symbol / find_code before grep/glob/read (Commandment #2; "
            f"Serena's symbol tools are the approved complement). " if label else ""
        )
        if label:
            id_line += delegation_nudge(label)

        if not os.path.exists(PR_OWN):
            emit(id_line or None)

        top = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, timeout=3,
        )
        if top.returncode != 0 or not top.stdout.strip():
            emit(id_line or None)  # not in a git repo → identity only
        toplevel = top.stdout.strip()
        owner = worktree_owner(toplevel)

        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        cache = CACHE_DIR / f"{owner}.txt"
        stamp = CACHE_DIR / f"{owner}.stamp"

        fresh = stamp.exists() and (time.time() - stamp.stat().st_mtime) < TTL_SECS
        if not fresh:
            # Debounce first (reset the window BEFORE spawning) so concurrent turns
            # don't each spawn a refresh, then fire a detached, non-blocking refresh.
            stamp.touch()
            tmp = f"{cache}.{os.getpid()}.tmp"
            try:
                subprocess.Popen(
                    f'"{PR_OWN}" mine > "{tmp}" 2>/dev/null && mv "{tmp}" "{cache}" '
                    f'|| rm -f "{tmp}"',
                    shell=True, cwd=toplevel, start_new_session=True,
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                )
            except Exception:
                pass

        if not cache.exists():
            emit(id_line or None)  # first run — background refresh populates next turn

        owned = [ln.strip() for ln in cache.read_text().splitlines() if ln.strip().startswith("#")]
        if not owned:
            emit(id_line or None)  # no owned PRs — identity only

        listing = "; ".join(owned)
        ctx = (
            f"{id_line}"
            f"⟢ PR ownership (worktree '{owner}'): you currently own {len(owned)} open "
            f"PR(s) — {listing}. Drive each to green + merged, or release it "
            f"(.claude/bin/pr-own.sh release <n>) — don't strand it. While one is open, keep a "
            f"READ-ONLY Monitor armed for new reviews/threads + the `gate` result and address "
            f"findings as they land — don't go idle waiting to be poked (see the WATCH section of "
            f".claude/rules/pr-review-sweep.md). Before you push to, "
            f"comment on, resolve a thread on, or merge any PR you did NOT open this "
            f"session, run `.claude/bin/pr-own.sh check <n>` and stand down if it's "
            f"another instance's fresh claim. (see .claude/rules/pr-ownership.md)"
        )
        emit(ctx)
    except Exception:
        # Never block or slow a prompt over a reminder.
        try:
            print("{}")
        except Exception:
            pass
        sys.exit(0)


if __name__ == "__main__":
    main()
