#!/usr/bin/env python3
"""
PreToolUse hook (Edit|Write|MultiEdit) — heddle delegation reinforcement, at the moment
of hand-writing code. Maya-directed 2026-08-15: "make sure the most work can get done
with the least usage" — orchestrators (Fable) should spend on JUDGMENT and route LABOR to
cheaper workers via mcp__heddle__dispatch_worker.

Behavior — NEVER blocks (always allow):
  * Only fleet agents (session has a /rename letter) — silent otherwise.
  * Reads this agent's dispatch count in the last 2h from ~/.heddle/ledger.db (read-only).
  * If it is 0 AND the write targets a "labor-shaped" file (source/test/workflow/doc, not
    a scratch/plan/note), it emits a one-line reminder as additionalContext — throttled to
    once per 10 minutes per session (a stamp file), so it nudges without nagging every write.
  * Anything unexpected → allow silently. Zero network. Budget ~30ms.

Output: {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow",
         "additionalContext": "..."}}   (allow with a note)   or   "{}"
"""
import json
import os
import pathlib
import sqlite3
import sys
import time

CACHE = pathlib.Path(os.path.expanduser("~/.claude/fleet-identity-cache"))
THROTTLE_SECS = 600
LABOR_EXT = (".ts", ".tsx", ".js", ".mjs", ".cjs", ".rs", ".py", ".sh", ".yml", ".yaml",
             ".toml", ".json", ".css", ".md")
SKIP_HINTS = ("/scratchpad", "/.claude/", "MISSION", "PLAN", "NOTES", "/tmp/", "/private/tmp/")


def out(ctx: str | None = None) -> None:
    if ctx:
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PreToolUse", "permissionDecision": "allow",
            "additionalContext": ctx}}))
    else:
        print("{}")
    sys.exit(0)


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        out()
    sid = payload.get("session_id") or ""
    f = CACHE / f"{sid}.label"
    if not sid or not f.exists():
        out()
    label = f.read_text().strip()
    if not (1 <= len(label) <= 3):
        out()
    path = (payload.get("tool_input") or {}).get("file_path") or ""
    if not path.endswith(LABOR_EXT) or any(h in path for h in SKIP_HINTS):
        out()
    stamp = CACHE / f"{sid}.delegation-nudge"
    if stamp.exists() and (time.time() - stamp.stat().st_mtime) < THROTTLE_SECS:
        out()
    led = os.path.expanduser("~/.heddle/ledger.db")
    if not os.path.exists(led):
        out()
    try:
        con = sqlite3.connect(f"file:{led}?mode=ro", uri=True, timeout=0.2)
        try:
            n = con.execute(
                "SELECT COUNT(*) FROM dispatches WHERE orchestrator=? "
                "AND started_at >= datetime('now','-2 hours')", (label,)).fetchone()[0]
        finally:
            con.close()
    except Exception:
        out()
    if n > 0:
        out()
    stamp.touch()
    out(f"⟢ DELEGATION CHECK (Agent {label}): you're about to hand-write {os.path.basename(path)} "
        f"with 0 worker dispatches in the last 2h. If this is LABOR (scaffold/test/port/doc/mechanical), "
        f"write the spec and dispatch it via mcp__heddle__dispatch_worker instead (agent=\"{label}\", "
        f"cwd, mcp=[\"memtrace\"]); keep orchestrator turns for judgment. Proceed if this genuinely needs your judgment.")


if __name__ == "__main__":
    main()
