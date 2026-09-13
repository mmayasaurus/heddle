#!/usr/bin/env python3
"""HED-262 regression guard for remind-owned-prs.py's per-turn Claude usage line.

The line once read ~/.heddle/usage/claude.json — the last-session-that-rendered fallback (a
DIFFERENT account) — so its number bounced across turns (2% / 28% / 84% on ONE session).
`_active_claude_cap` now resolves THIS process's account from $CLAUDE_CONFIG_DIR ->
accounts.json -> claude-<id>.json, NAMES the account, and fails LOUD rather than ever
reporting a different account's number.

Dependency-free + standalone (`python3 test_remind_owned_prs_hed262.py`; exit 0 = pass) so it
runs before the Workspace wires .claude/hooks tests into CI. `_active_claude_cap` takes `home`
as a param, so the fs is mocked with a fake HOME (no expanduser patching); $CLAUDE_CONFIG_DIR
is set per case.
"""
import importlib.util
import json
import os
import sys
import tempfile
import time
from pathlib import Path

HOOK = Path(__file__).resolve().parent.parent / "remind-owned-prs.py"


def _load_hook():
    spec = importlib.util.spec_from_file_location("remind_owned_prs", HOOK)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)  # main() is __main__-guarded -> import runs nothing
    return m


def main() -> int:
    m = _load_hook()
    errs = []
    home = tempfile.mkdtemp()
    heddle = os.path.join(home, ".heddle")
    usage = os.path.join(heddle, "usage")
    os.makedirs(usage)
    default_dir = os.path.join(home, ".claude")   # acct2 = the default (configDir null)
    cfgs = {n: os.path.join(home, f"cfg-{n}") for n in
            ("acct1", "acct3", "acct4", "acct5", "acct6")}
    for d in [default_dir] + list(cfgs.values()):
        os.makedirs(d)
    cfg1, cfg3 = cfgs["acct1"], cfgs["acct3"]
    reg = os.path.join(heddle, "accounts.json")
    with open(reg, "w") as f:
        json.dump({"claude": [
            {"id": n, "configDir": p} for n, p in cfgs.items()
        ] + [{"id": "acct2", "configDir": None}]}, f)   # null = the default ~/.claude
    now = time.time()
    # acct3: nested (tap) format, both meters + resets, calm
    with open(os.path.join(usage, "claude-acct3.json"), "w") as f:
        json.dump({"rate_limits": {
            "five_hour": {"used_percentage": 42, "resets_at": now + 125 * 60 + 30},
            "seven_day": {"used_percentage": 12, "resets_at": now + 3 * 86400},
        }}, f)
    # acct1: flat top-level `used` (keeper / flat capture) — exercises the codeant fallback
    with open(os.path.join(usage, "claude-acct1.json"), "w") as f:
        json.dump({"used": 7}, f)
    # acct2 (default): NO capture file -> "no capture yet"
    # acct4: 7d at 98 → always alerts
    with open(os.path.join(usage, "claude-acct4.json"), "w") as f:
        json.dump({"rate_limits": {
            "five_hour": {"used_percentage": 10, "resets_at": now + 3600},
            "seven_day": {"used_percentage": 98, "resets_at": now + 2 * 86400},
        }}, f)
    # acct5: 5h at 98 but reset in 20 min → alert SUPPRESSED (about to fix itself)
    with open(os.path.join(usage, "claude-acct5.json"), "w") as f:
        json.dump({"rate_limits": {
            "five_hour": {"used_percentage": 98, "resets_at": now + 20 * 60},
            "seven_day": {"used_percentage": 40, "resets_at": now + 2 * 86400},
        }}, f)
    # acct6: 5h at 98 with reset 45 min out → alerts
    with open(os.path.join(usage, "claude-acct6.json"), "w") as f:
        json.dump({"rate_limits": {
            "five_hour": {"used_percentage": 98, "resets_at": now + 45 * 60},
            "seven_day": {"used_percentage": 40, "resets_at": now + 2 * 86400},
        }}, f)

    def check(desc, ccd, want_sub):
        if ccd is None:
            os.environ.pop("CLAUDE_CONFIG_DIR", None)
        else:
            os.environ["CLAUDE_CONFIG_DIR"] = ccd
        got = m._active_claude_cap(home)
        if want_sub not in got:
            errs.append(f"{desc}: expected {want_sub!r} in {got!r}")

    # The core fix: the RUNNING account is resolved + named, from its own file.
    check("running account resolved + named (nested tap format)", cfg3, "acct3 5h 42% USED")
    # Dual meters + reset countdowns (Maya 2026-08-21: an agent misread a 5h
    # meter 23 min from reset as weekly and nearly stopped for the night).
    check("7d meter shown alongside 5h", cfg3, "7d 12% USED")
    check("reset countdown rendered", cfg3, "(↻2h05m)")
    check("calm case carries the standing doctrine", cfg3, "usage auto-managed (rotation); never slow down")
    # codeant: flat top-level `used` is honored the way the drawer reader does.
    check("flat top-level `used` fallback", cfg1, "acct1 5h 7% USED")
    check("flat capture still calm-doctrined", cfg1, "never slow down")
    # Default (unset $CLAUDE_CONFIG_DIR) resolves to the configDir-null account.
    check("default (unset) -> configDir-null account", None, "acct2 5h: no capture yet")
    # LOUD on an unregistered dir — never a silent fallback to another account's number.
    check("unregistered dir fails LOUD", os.path.join(home, "nope"), "unresolved account")
    # Escalation doctrine: ≥97% flags Maya — 7d always; 5h only when reset >30 min out.
    check("7d ≥97 alerts", cfgs["acct4"], "⚠️ 7d ≥97%: TELL MAYA NOW")
    check("5h ≥97 with reset 45m out alerts", cfgs["acct6"], "⚠️ 5h ≥97%: TELL MAYA NOW")
    got5 = None
    os.environ["CLAUDE_CONFIG_DIR"] = cfgs["acct5"]
    got5 = m._active_claude_cap(home)
    if "⚠️" in got5:
        errs.append(f"5h ≥97 resetting in 20m must be SUPPRESSED (about to fix itself): got {got5!r}")
    if "never slow down" not in got5:
        errs.append(f"suppressed near-reset case must still carry the calm doctrine: got {got5!r}")

    # Missing registry -> loud (not a crash, not a wrong number).
    os.rename(reg, reg + ".bak")
    os.environ["CLAUDE_CONFIG_DIR"] = cfg3
    got = m._active_claude_cap(home)
    if "unresolved (no account registry" not in got:
        errs.append(f"missing registry must fail loud: got {got!r}")
    os.rename(reg + ".bak", reg)

    if errs:
        print("FAIL (HED-262 guard):")
        for e in errs:
            print("  -", e)
        return 1
    print("PASS: HED-262 per-account usage line (resolves + names the running account; nested + "
          "flat fallback; loud on unresolved / missing registry)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
