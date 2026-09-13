#!/usr/bin/env python3
"""HED-443 regression guard: the per-turn Claude usage line's OVERAGE (real-money) safeguard.

The 2026-08-29 incident: accounts hit 100% and, because extra-usage was ENABLED, rolled silently
into per-token billing while the line still said "usage auto-managed; never slow down." `_active_claude_cap`
now flips at/over 100% on an account whose overage posture is ENABLED or UNKNOWN to a ⛔ REAL-MONEY
"MINIMIZE TURNS" line; only an operator-DECLARED overage-off account (accounts.json overageEnabled:false)
keeps the normal path (there 100% is a genuine hard stop, no billing).

Dependency-free + standalone (`python3 test_remind_owned_prs_hed443.py`; exit 0 = pass), same style as
test_remind_owned_prs_hed262.py. Cases lock the invariants that a plausible regression would otherwise
slip past (reset-ignore, unknown-branch must not append the coast doctrine, flat-`used`, 7d-only-at-cap).
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
    OMIT = object()
    # id -> (configDir, overageEnabled value written to the registry [OMIT = key absent])
    specs = {
        "billing":    (os.path.join(home, "cfg-billing"),  True),
        "unknown":    (os.path.join(home, "cfg-unknown"),  OMIT),   # no overageEnabled key -> unknown
        "hardstop":   (os.path.join(home, "cfg-hardstop"), False),
        "weekly":     (os.path.join(home, "cfg-weekly"),   True),
        "under":      (os.path.join(home, "cfg-under"),    True),
        "badposture": (os.path.join(home, "cfg-bad"),      "yes"),  # non-boolean -> treated as unknown
        "nearreset":  (os.path.join(home, "cfg-nearreset"), True),  # 5h=100 but reset <30m: RED must ignore
        "flatbill":   (os.path.join(home, "cfg-flatbill"), True),   # flat top-level `used` fallback
        "weeklyonly": (os.path.join(home, "cfg-weeklyonly"), True), # 7d at cap, NO 5h capture
        "weeklyoff":  (os.path.join(home, "cfg-weeklyoff"), False), # 7d at cap, NO 5h, overage OFF
    }
    for cfg, _ in specs.values():
        os.makedirs(cfg)
    reg = os.path.join(heddle, "accounts.json")
    claude = []
    for acct_id, (cfg, over) in specs.items():
        entry = {"id": acct_id, "configDir": cfg}
        if over is not OMIT:
            entry["overageEnabled"] = over
        claude.append(entry)
    with open(reg, "w") as f:
        json.dump({"claude": claude}, f)
    now = time.time()

    def cap(acct_id, five, seven=None, five_reset=None):
        rl = {"five_hour": {"used_percentage": five, "resets_at": five_reset}}
        if seven is not None:
            rl["seven_day"] = {"used_percentage": seven, "resets_at": now + 2 * 86400}
        raw(acct_id, {"rate_limits": rl})

    def raw(acct_id, obj):
        with open(os.path.join(usage, f"claude-{acct_id}.json"), "w") as f:
            json.dump(obj, f)

    cap("billing", 100)                             # 5h at cap, overage ON
    cap("unknown", 100)                             # 5h at cap, posture unknown
    cap("hardstop", 100, five_reset=now + 3600)     # 5h at cap, overage OFF, reset >30m
    cap("weekly", 10, seven=100)                    # 7d at cap, overage ON (5h below cap)
    cap("under", 97)                                # below the 100 red line, overage ON
    cap("badposture", 100)                          # 5h at cap, non-boolean posture -> unknown
    cap("nearreset", 100, five_reset=now + 600)     # 5h at cap, overage ON, reset in 10m
    raw("flatbill", {"used": 100})                  # flat top-level `used` fallback, overage ON
    raw("weeklyonly", {"rate_limits": {"seven_day": {"used_percentage": 100, "resets_at": now + 2 * 86400}}})
    raw("weeklyoff", {"rate_limits": {"seven_day": {"used_percentage": 100, "resets_at": now + 2 * 86400}}})

    def got(acct_id):
        os.environ["CLAUDE_CONFIG_DIR"] = specs[acct_id][0]
        return m._active_claude_cap(home)

    def want(acct_id, subs, absent=()):
        g = got(acct_id)
        for s in subs:
            if s not in g:
                errs.append(f"{acct_id}: expected {s!r} in {g!r}")
        for s in absent:
            if s in g:
                errs.append(f"{acct_id}: did NOT expect {s!r} in {g!r}")

    # The coast doctrine ("never slow down", "keep working", "TELL MAYA NOW", "auto-managed") must be
    # ABSENT on every billable at-cap account — a regression that appended the ⛔ instead of returning
    # it (leaving the old line in place) would be caught by these absents, not just by the ⛔ presence.
    COAST = ["never slow down", "keep working", "TELL MAYA NOW", "auto-managed"]

    # overage ENABLED at cap -> unmissable real-money stop-posture, none of the coast doctrine.
    want("billing", ["⛔ REAL MONEY: OVERAGE BILLING ACTIVE on billing (5h ≥100%)", "MINIMIZE TURNS"], absent=COAST)
    # overage UNKNOWN at cap -> conservative real-money treatment (never a silent coast).
    want("unknown", ["⛔ REAL MONEY?", "overage posture UNKNOWN", "MINIMIZE TURNS"], absent=COAST)
    # non-boolean posture is unknown, not "off".
    want("badposture", ["⛔ REAL MONEY?", "overage posture UNKNOWN"], absent=COAST)
    # 7d meter at cap triggers the same alert, named as 7d (5h below cap).
    want("weekly", ["⛔ REAL MONEY: OVERAGE BILLING ACTIVE on weekly (7d ≥100%)"], absent=COAST)
    # RED ignores reset timing — billing is happening NOW, unlike the ≥97 near-reset suppression.
    want("nearreset", ["⛔ REAL MONEY: OVERAGE BILLING ACTIVE on nearreset (5h ≥100%)"], absent=COAST)
    # flat top-level `used` at cap still reaches the RED check.
    want("flatbill", ["⛔ REAL MONEY: OVERAGE BILLING ACTIVE on flatbill (5h ≥100%)"], absent=COAST)
    # 7d at cap with NO 5h capture: still real money, not merely "unresolved" (ledger 856 finding 3).
    want("weeklyonly", ["5h unresolved", "7d 100% USED", "⛔ REAL MONEY: OVERAGE BILLING ACTIVE on weeklyonly (7d ≥100%)"], absent=COAST)
    # DECLARED overage-off at 100%: no money alarm — the normal ≥97 rotation path only.
    want("hardstop", ["TELL MAYA NOW"], absent=["⛔", "REAL MONEY"])
    # DECLARED overage-off, 7d at cap, no 5h: the plain unresolved marker, never ⛔.
    want("weeklyoff", ["unresolved (no usage"], absent=["⛔", "REAL MONEY"])
    # below 100 with overage ON: still the normal ≥97 warning, no red-money line.
    want("under", ["⚠️ 5h ≥97%: TELL MAYA NOW"], absent=["⛔", "REAL MONEY"])

    if errs:
        print("FAIL (HED-443 overage guard):")
        for e in errs:
            print("  -", e)
        return 1
    print("PASS: HED-443 per-turn overage safeguard (enabled/unknown/non-boolean/flat/near-reset/7d-only "
          "at cap -> ⛔ MINIMIZE TURNS; declared-off and sub-100 keep the normal path; coast doctrine absent)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
