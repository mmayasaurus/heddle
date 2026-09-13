#!/usr/bin/env python3
"""Behavioral guard for the per-turn KEEP MOVING + SCOPE lines in remind-owned-prs.py and the
SessionStart SCOPE block in agent-identity.py (Maya, 2026-08-22 / 2026-08-23).

Asserts the OBSERVABLE injection (pre-PR review ledger 405, finding 3; on-PR round of PR #38):
every check runs the hook's real main() against stubbed stdin and reads additionalContext back.
A source grep for the literals would stay green if the append moved outside `if label:` or onto
the owned-PR path only, or if a failure fallback mis-scoped a Spinventory session; this runs the
code. Standalone: `python3 test_remind_owned_prs_keepmoving.py`; exit 0 = pass.
"""
import importlib.util
import io
import json
import os
import sys
import tempfile
import types
from pathlib import Path

HOOKS = Path(__file__).resolve().parent.parent
REMIND = HOOKS / "remind-owned-prs.py"
IDENT = HOOKS / "agent-identity.py"
SCOPE_PREFIX = "⟢ SCOPE — the HEDDLE FLEET"
SCOPE_PHRASES = ("NEVER ANYTHING SPINVENTORY APP", "NOT NOW OR EVER", "Rebuild-Project-Root",
                 "DISCARDED", "Spinventory-Port", "NO exception")
REMIND_PAYLOAD = {"session_id": "s", "transcript_path": "/nonexistent", "prompt": "x"}


def _load(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot build an import spec for {path}")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def _fail_soft_subprocess(**overrides):
    """subprocess stand-in: every call fails fast (returncode 1), nothing is ever spawned."""
    base = dict(
        run=lambda *a, **k: types.SimpleNamespace(returncode=1, stdout="", stderr=""),
        Popen=lambda *a, **k: None,
        TimeoutExpired=Exception,
        CalledProcessError=Exception,
    )
    base.update(overrides)
    return types.SimpleNamespace(**base)


def _run_main(m, payload):
    """Run m.main() with `payload` on stdin; return the additionalContext it emitted ('' if none)."""
    stdin, stdout = sys.stdin, sys.stdout
    sys.stdin = io.StringIO(json.dumps(payload))
    sys.stdout = io.StringIO()
    try:
        try:
            m.main()
        except SystemExit:
            pass
        out = sys.stdout.getvalue().strip()
    finally:
        sys.stdin, sys.stdout = stdin, stdout
    if not out:
        return ""
    try:
        return json.loads(out).get("hookSpecificOutput", {}).get("additionalContext", "") or ""
    except ValueError:
        return out


def _boom(*a, **k):
    raise RuntimeError("forced failure inside main()")


def _remind(label, cache_dir=None, **patches):
    """remind-owned-prs main() with the identity forced to `label`, isolated from git/Popen.

    IDENTITY_CACHE and COMMS_DB are always redirected (HED-387: a labeled turn writes the
    pid-bridge file and may read the comms db — tests must never touch the real ones)."""
    m = _load(REMIND, "remind_owned_prs_km")
    m._claude_ancestor_pid = lambda: 4242
    m.fleet_label = lambda *a, **k: label
    # Absent PR_OWN path WITHOUT creating anything (prior review: mkdtemp leaked a dir per run).
    m.PR_OWN = os.path.join(tempfile.gettempdir(), "km-test-absent", "absent-pr-own")
    m.subprocess = _fail_soft_subprocess()
    m.COMMS_DB = os.path.join(tempfile.gettempdir(), "km-test-absent", "no-comms.db")
    for k, v in patches.items():
        setattr(m, k, v)
    if cache_dir is not None:
        m.IDENTITY_CACHE = Path(cache_dir)
        return _run_main(m, REMIND_PAYLOAD)
    with tempfile.TemporaryDirectory(prefix="km-idcache-") as tmp:
        m.IDENTITY_CACHE = Path(tmp)
        return _run_main(m, REMIND_PAYLOAD)


def check_keep_moving(errs):
    ctx = _remind("A")
    if "KEEP MOVING" not in ctx:
        errs.append(f"labeled session: KEEP MOVING missing from additionalContext: {ctx[:200]!r}")
    for must in ("never hedge", "Finish→next", "wrap/pause/hold", "needs-maya",
                 "untriaged PR slate first", "Context-drift", "MECHANICAL",
                 "MONITORS DEFAULT", "BACKUP"):
        if must not in ctx:
            errs.append(f"labeled session: load-bearing phrase missing: {must!r}")
    if "LIN_TEAM=HED" in ctx:
        errs.append("Spinventory-fleet label A was pointed at the HED board")
    ctx_none = _remind(None)
    for leak in ("KEEP MOVING", "MONITORS DEFAULT"):
        if leak in ctx_none:
            errs.append(f"unlabeled session: {leak} leaked to a non-fleet session")
    return ctx, ctx_none


def check_scope_per_turn(errs, ctx_a, ctx_none):
    # SCOPE (Maya, firsthand 2026-08-23): FIRST for heddle-fleet and unlabeled sessions; ABSENT for A–Q.
    ctx_r = _remind("R")
    for who, c in (("heddle-fleet R", ctx_r), ("unlabeled", ctx_none)):
        if not c.startswith(SCOPE_PREFIX):
            errs.append(f"{who} session: SCOPE line is not first: {c[:90]!r}")
        for must in SCOPE_PHRASES:
            if must not in c:
                errs.append(f"{who} session: scope phrase missing: {must!r}")
    if SCOPE_PREFIX in ctx_a:
        errs.append("Spinventory-fleet label A received the heddle SCOPE line")
    # The heddle fleet's Finish→next names the HED board (lin.sh defaults to SPI), on-PR round #38.
    if "LIN_TEAM=HED lin.sh list" not in ctx_r:
        errs.append(f"heddle-fleet R: KEEP MOVING does not point at the HED board: {ctx_r[-300:]!r}")


def check_scope_owned_pr_path(errs):
    # SCOPE must survive the owned-PR path (PR_OWN present, refresh failing) and stay first.
    m = _load(REMIND, "remind_owned_prs_km_owned")
    with tempfile.TemporaryDirectory(prefix="km-owned-") as tmp:
        toplevel = os.path.join(tmp, "Spinventory-Rebuild-App.kmtest")
        pr_own = Path(tmp) / "pr-own.sh"
        pr_own.write_text("#!/bin/sh\nexit 1\n")
        m.fleet_label = lambda *a, **k: "R"
        m.PR_OWN = str(pr_own)
        m.subprocess = _fail_soft_subprocess(run=lambda cmd, *a, **k: types.SimpleNamespace(
            returncode=0 if "rev-parse" in cmd else 1,
            stdout=(toplevel + "\n") if "rev-parse" in cmd else "", stderr=""))
        m.CACHE_DIR = Path(tmp) / "cache"
        m.CACHE_DIR.mkdir()
        m.IDENTITY_CACHE = Path(tmp) / "idcache"
        m.COMMS_DB = os.path.join(tmp, "no-comms.db")
        owner = m.worktree_owner(toplevel)
        (m.CACHE_DIR / f"{owner}.txt").write_text("#4242 km-test owned PR\n")
        (m.CACHE_DIR / f"{owner}.stamp").touch()
        ctx = _run_main(m, REMIND_PAYLOAD)
    if not ctx.startswith(SCOPE_PREFIX):
        errs.append(f"owned-PR path: SCOPE line not first: {ctx[:90]!r}")
    if "#4242" not in ctx:
        errs.append(f"owned-PR path was not actually exercised (no owned-PR text): {ctx[-160:]!r}")


def check_scope_failure_paths(errs):
    # A failure BEFORE the identity is known → SCOPE (fail-safe). A failure AFTER a Spinventory
    # label resolved → NOTHING (never a heddle-only directive to the Spinventory fleet, PR #38
    # round). A failure after a heddle label resolved → SCOPE.
    m = _load(REMIND, "remind_owned_prs_km_fail")
    m.fleet_label = _boom
    ctx = _run_main(m, {})
    if not ctx.startswith(SCOPE_PREFIX):
        errs.append(f"failure path (unknown label): SCOPE line dropped: {ctx[:90]!r}")
    ctx_a = _remind("A", delegation_nudge=_boom)
    if SCOPE_PREFIX in ctx_a or "HEDDLE" in ctx_a:
        errs.append(f"failure path after label A resolved: heddle SCOPE leaked: {ctx_a[:120]!r}")
    ctx_r = _remind("R", delegation_nudge=_boom)
    if not ctx_r.startswith(SCOPE_PREFIX):
        errs.append(f"failure path after label R resolved: SCOPE line dropped: {ctx_r[:90]!r}")


def _ident(label, **patches):
    """agent-identity main() with label_from_transcript forced to `label` on a REAL temp transcript.

    The hook consults the transcript only when the path EXISTS — the earlier test passed
    `/nonexistent`, so the labeled branch was never exercised (on-PR round of #38, bugbot/codex).
    """
    m = _load(IDENT, "agent_identity_km")
    m.COMMS_DB = os.path.join(tempfile.gettempdir(), "km-test-absent", "no-comms.db")
    m.label_from_transcript = lambda *a, **k: label
    m.claimed_issues = lambda *a, **k: []
    m.worktree_owner = lambda *a, **k: "main"
    m.subprocess = _fail_soft_subprocess()
    for k, v in patches.items():
        setattr(m, k, v)
    with tempfile.TemporaryDirectory(prefix="km-ident-") as tmp:
        m.CACHE_DIR = Path(tmp) / "cache"
        transcript = Path(tmp) / "transcript.jsonl"
        transcript.write_text("")
        return _run_main(m, {"session_id": "s", "transcript_path": str(transcript), "cwd": tmp})


def check_session_start(errs):
    ctx_r = _ident("R")
    if not ctx_r.startswith(SCOPE_PREFIX):
        errs.append(f"session-start (labeled R): SCOPE block not first: {ctx_r[:90]!r}")
    if "You are **Agent R**" not in ctx_r:
        errs.append(f"session-start (labeled R): labeled branch NOT exercised: {ctx_r[:200]!r}")
    if "LIN_TEAM=HED .claude/bin/lin.sh --agent R list" not in ctx_r:
        errs.append(f"session-start (labeled R): idle-work pointer is not the HED board: {ctx_r[-300:]!r}")
    ctx_none = _ident(None)
    if not ctx_none.startswith(SCOPE_PREFIX):
        errs.append(f"session-start (unlabeled): SCOPE block not first: {ctx_none[:90]!r}")
    if "FLEET IDENTITY" in ctx_none:
        errs.append("session-start (unlabeled): identity line emitted without a label")
    ctx_a = _ident("A")
    if SCOPE_PREFIX in ctx_a:
        errs.append("session-start (labeled A): Spinventory-fleet session received the heddle SCOPE block")
    if "You are **Agent A**" not in ctx_a:
        errs.append(f"session-start (labeled A): identity line wrong: {ctx_a[:160]!r}")
    if "LIN_TEAM=HED" in ctx_a:
        errs.append("session-start (labeled A): Spinventory session pointed at the HED board")
    # Failure after the label resolved: heddle label → SCOPE survives; Spinventory label → nothing.
    ctx_rf = _ident("R", worktree_owner=_boom)
    if not ctx_rf.startswith(SCOPE_PREFIX):
        errs.append(f"session-start failure (R): SCOPE block dropped: {ctx_rf[:90]!r}")
    ctx_af = _ident("A", worktree_owner=_boom)
    if SCOPE_PREFIX in ctx_af:
        errs.append(f"session-start failure (A): heddle SCOPE leaked to a Spinventory session: {ctx_af[:120]!r}")


def check_pid_bridge_and_nudge(errs):
    # HED-387: a labeled turn writes the pid-bridge file the comms server lazy-binds from.
    with tempfile.TemporaryDirectory(prefix="km-bridge-") as tmp:
        ctx = _remind("R", cache_dir=tmp)
        bridge = Path(tmp) / "pid-4242.label"
        if not bridge.exists() or bridge.read_text() != "R":
            errs.append(f"pid bridge not written on a labeled turn: {list(Path(tmp).iterdir())!r}")
        if "📬 COMMS" in ctx:
            errs.append("comms nudge appeared with no comms db")
    with tempfile.TemporaryDirectory(prefix="km-bridge-") as tmp:
        _ = _remind(None, cache_dir=tmp)
        if any(p.name.startswith("pid-") for p in Path(tmp).iterdir()):
            errs.append("pid bridge written for an UNLABELED session")
    m0 = _load(IDENT, "agent_identity_km_nolabel")
    m0.COMMS_DB = os.path.join(tempfile.gettempdir(), "km-test-absent", "no-comms.db")
    m0.label_from_transcript = lambda *a, **k: None
    m0.claimed_issues = lambda *a, **k: []
    m0.worktree_owner = lambda *a, **k: "main"
    m0.subprocess = _fail_soft_subprocess()
    with tempfile.TemporaryDirectory(prefix="km-ident-nolabel-") as tmp:
        m0.CACHE_DIR = Path(tmp) / "cache"
        tr = Path(tmp) / "t.jsonl"; tr.write_text("")
        _run_main(m0, {"session_id": "s", "transcript_path": str(tr), "cwd": tmp})
        if m0.CACHE_DIR.exists() and any(p.name.startswith("pid-") for p in m0.CACHE_DIR.iterdir()):
            errs.append("session-start hook wrote a pid bridge for an UNLABELED session")
    # SessionStart seeds the comms mark at the db tip for a labeled session (pre-first-prompt mail).
    import sqlite3
    with tempfile.TemporaryDirectory(prefix="km-ident-seed-") as tmp:
        db = os.path.join(tmp, "comms.db")
        c = sqlite3.connect(db); c.executescript(
            "CREATE TABLE messages (id INTEGER PRIMARY KEY, ts TEXT, sender TEXT, target TEXT, body TEXT);"
            "INSERT INTO messages (id, ts, sender, target, body) VALUES (12, 't', 'S', 'R', 'x');"); c.commit(); c.close()
        ms = _load(IDENT, "agent_identity_km_seed")
        ms._claude_ancestor_pid = lambda: 4242
        ms.label_from_transcript = lambda *a, **k: "R"
        ms.claimed_issues = lambda *a, **k: []
        ms.worktree_owner = lambda *a, **k: "main"
        ms.subprocess = _fail_soft_subprocess()
        ms.COMMS_DB = db
        ms.CACHE_DIR = Path(tmp) / "cache"
        tr = Path(tmp) / "t.jsonl"; tr.write_text("")
        _run_main(ms, {"session_id": "s", "transcript_path": str(tr), "cwd": tmp})
        seeded = ms.CACHE_DIR / "comms-hwm-R"
        if not seeded.exists() or seeded.read_text() != "12":
            errs.append(f"session-start did not seed the comms mark at the tip: {seeded.exists() and seeded.read_text()!r}")
    # A rename within the .nolabel debounce window is picked up when the transcript is newer.
    with tempfile.TemporaryDirectory(prefix="km-nolabel-") as tmp:
        mr = _load(REMIND, "remind_owned_prs_km_nolabel")
        mr.IDENTITY_CACHE = Path(tmp)
        stamp = Path(tmp) / "sess1.nolabel"; stamp.touch()
        past = __import__("time").time() - 60
        os.utime(stamp, (past, past))
        tr = Path(tmp) / "transcript.jsonl"
        tr.write_text('{"type": "custom-title", "customTitle": "R"}\n')
        got = mr.fleet_label("sess1", str(tr))
        if got != "R":
            errs.append(f"rename inside the nolabel debounce was not picked up: {got!r}")
        mr2 = _load(REMIND, "remind_owned_prs_km_nolabel2")
        mr2.IDENTITY_CACHE = Path(tmp) / "second"
        (mr2.IDENTITY_CACHE).mkdir()
        st2 = mr2.IDENTITY_CACHE / "sess2.nolabel"; st2.touch()
        tr2 = mr2.IDENTITY_CACHE / "t2.jsonl"; tr2.write_text("")
        old_time = __import__("time").time() - 60
        os.utime(tr2, (old_time, old_time))
        if mr2.fleet_label("sess2", str(tr2)) is not None:
            errs.append("stamp with an OLDER transcript no longer debounces")
    # SessionStart hook writes the bridge too.
    m = _load(IDENT, "agent_identity_km_bridge")
    m.COMMS_DB = os.path.join(tempfile.gettempdir(), "km-test-absent", "no-comms.db")
    m._claude_ancestor_pid = lambda: 4242
    m.label_from_transcript = lambda *a, **k: "R"
    m.claimed_issues = lambda *a, **k: []
    m.worktree_owner = lambda *a, **k: "main"
    m.subprocess = _fail_soft_subprocess()
    with tempfile.TemporaryDirectory(prefix="km-ident-bridge-") as tmp:
        m.CACHE_DIR = Path(tmp) / "cache"
        transcript = Path(tmp) / "t.jsonl"; transcript.write_text("")
        _run_main(m, {"session_id": "s", "transcript_path": str(transcript), "cwd": tmp})
        bridge = m.CACHE_DIR / "pid-4242.label"
        if not bridge.exists() or bridge.read_text() != "R":
            errs.append("session-start hook did not write the pid bridge")
        if (m.CACHE_DIR / "comms-hwm-R").exists():
            errs.append("session-start seeded a comms mark with no comms db present")
    # Nudge: fires on an undelivered direct message, then DRAINS via the high-water mark.
    import sqlite3
    with tempfile.TemporaryDirectory(prefix="km-nudge-") as tmp:
        db = os.path.join(tmp, "comms.db")
        con = sqlite3.connect(db)
        con.executescript(
            "CREATE TABLE messages (id INTEGER PRIMARY KEY, ts TEXT, sender TEXT, target TEXT, body TEXT);"
            "CREATE TABLE deliveries (id INTEGER PRIMARY KEY, message_id INTEGER, sender TEXT, target TEXT,"
            " outcome TEXT, code TEXT, transport TEXT);"
            "INSERT INTO messages (id, ts, sender, target, body) VALUES"
            " (7, '2026-08-27T00:00:00Z', 'S', 'R', 'undelivered direct'),"
            " (8, '2026-08-27T00:00:01Z', 'S', 'R', 'this one was pushed'),"
            " (9, '2026-08-27T00:00:02Z', 'R', 'R', 'self note — never counts');"
            "INSERT INTO deliveries (message_id, sender, target, outcome, code, transport) VALUES"
            " (8, 'S', 'R', 'sent', 'channel-written', 'channel');")
        con.commit(); con.close()
        cache = os.path.join(tmp, "idcache")
        hwm = Path(cache) / "comms-hwm-R"
        ctx0 = _remind("R", cache_dir=cache, COMMS_DB=db)
        if "📬 COMMS" in ctx0 or hwm.read_text() != "9":
            errs.append(f"first turn must SEED silently at the tip (mark 9): {ctx0[:120]!r} {hwm.read_text()!r}")
        def add_msg(mid, target, sender="S"):
            import sqlite3 as _s
            c = _s.connect(db); c.execute(
                "INSERT INTO messages (id, ts, sender, target, body) VALUES (?, '2026-08-27T01:00:00Z', ?, ?, 'x')",
                (mid, sender, target)); c.commit(); c.close()
        add_msg(20, "R")
        ctx1 = _remind("R", cache_dir=cache, COMMS_DB=db)
        if "📬 COMMS: 1 message(s)" not in ctx1:
            errs.append(f"nudge missing for the new undelivered direct message: {ctx1[:200]!r}")
        if hwm.read_text() != "20":
            errs.append(f"mark must advance to 20 after the nudge was SHOWN: {hwm.read_text()!r}")
        add_msg(21, "@all")
        ctx2 = _remind("R", cache_dir=cache, COMMS_DB=db)
        if "📬 COMMS" in ctx2:
            errs.append("drained turn must be silent (broadcasts are excluded, mark advanced)")
        # HWM must NOT advance when the nudge never reaches the emitted context (failure fallback).
        add_msg(22, "R")
        def _to(*a, **k):
            raise RuntimeError("forced failure after the nudge staged")
        ctx3 = _remind("R", cache_dir=cache, COMMS_DB=db, delegation_nudge=_to)
        if "📬 COMMS" in ctx3:
            errs.append("failure fallback unexpectedly carried the nudge")
        if hwm.read_text() != "21":
            # 21, not 20: the silent ctx2 turn legitimately advanced the mark to the tip (the @all
            # row) under the round-2 rescan-bound fix; the staged 22 must NOT have committed.
            errs.append(f"mark advanced on a turn whose nudge was never emitted: {hwm.read_text()!r}")
        ctx4 = _remind("R", cache_dir=cache, COMMS_DB=db)
        if "📬 COMMS: 1 message(s)" not in ctx4 or hwm.read_text() != "22":
            errs.append(f"swallowed nudge must resurface next turn and then advance: {ctx4[:160]!r} {hwm.read_text()!r}")
        # A failed PRINT must not advance the mark either (round-2 high: commit only after emission).
        add_msg(23, "R")
        m5 = _load(REMIND, "remind_owned_prs_km_printfail")
        m5.fleet_label = lambda *a, **k: "R"
        m5.PR_OWN = os.path.join(tempfile.gettempdir(), "km-test-absent", "absent-pr-own")
        m5.subprocess = _fail_soft_subprocess()
        m5.IDENTITY_CACHE = Path(cache)
        m5.COMMS_DB = db
        def _bad_print(*a, **k):
            raise OSError("stdout gone")
        m5.print = _bad_print
        stdin, stdout = sys.stdin, sys.stdout
        sys.stdin = io.StringIO(json.dumps(REMIND_PAYLOAD)); sys.stdout = io.StringIO()
        try:
            try:
                m5.main()
            except SystemExit:
                pass
        finally:
            sys.stdin, sys.stdout = stdin, stdout
        if hwm.read_text() != "22":
            errs.append(f"mark advanced although the print failed: {hwm.read_text()!r}")
        ctx5 = _remind("R", cache_dir=cache, COMMS_DB=db)
        if "📬 COMMS: 1 message(s)" not in ctx5 or hwm.read_text() != "23":
            errs.append(f"print-failure nudge must resurface and then advance: {ctx5[:160]!r} {hwm.read_text()!r}")
        # Silent turns advance the mark to the tip (delivered/self rows no longer rescanned forever).
        add_msg(30, "Q"); add_msg(31, "R", sender="R")
        ctx6 = _remind("R", cache_dir=cache, COMMS_DB=db)
        if "📬 COMMS" in ctx6 or hwm.read_text() != "31":
            errs.append(f"silent turn must advance the mark to the tip: {ctx6[:120]!r} {hwm.read_text()!r}")
        # Corrupt mark re-seeds at the tip and recovers.
        hwm.write_text("garbage")
        ctx7 = _remind("R", cache_dir=cache, COMMS_DB=db)
        if "📬 COMMS" in ctx7 or hwm.read_text() != "31":
            errs.append(f"corrupt mark must re-seed silently at the tip: {ctx7[:120]!r} {hwm.read_text()!r}")
        add_msg(40, "R")
        ctx8 = _remind("R", cache_dir=cache, COMMS_DB=db)
        if "📬 COMMS: 1 message(s)" not in ctx8 or hwm.read_text() != "40":
            errs.append(f"post-reseed new mail must nudge again: {ctx8[:160]!r} {hwm.read_text()!r}")
        # DB replaced with a LOWER id sequence → silent re-seed at the new tip, then new mail nudges.
        db2 = os.path.join(tmp, "comms2.db")
        c2 = sqlite3.connect(db2); c2.executescript(
            "CREATE TABLE messages (id INTEGER PRIMARY KEY, ts TEXT, sender TEXT, target TEXT, body TEXT);"
            "CREATE TABLE deliveries (id INTEGER PRIMARY KEY, message_id INTEGER, sender TEXT, target TEXT,"
            " outcome TEXT, code TEXT, transport TEXT);"
            "INSERT INTO messages (id, ts, sender, target, body) VALUES (5, 't', 'S', 'Q', 'other');"); c2.commit(); c2.close()
        ctx9 = _remind("R", cache_dir=cache, COMMS_DB=db2)
        if "📬 COMMS" in ctx9 or hwm.read_text() != "5":
            errs.append(f"db reset must silently re-seed at the new tip: {ctx9[:120]!r} {hwm.read_text()!r}")
        c2 = sqlite3.connect(db2); c2.execute(
            "INSERT INTO messages (id, ts, sender, target, body) VALUES (6, 't', 'S', 'R', 'post-reset')"); c2.commit(); c2.close()
        ctx10 = _remind("R", cache_dir=cache, COMMS_DB=db2)
        if "📬 COMMS: 1 message(s)" not in ctx10 or hwm.read_text() != "6":
            errs.append(f"post-reset mail must nudge: {ctx10[:160]!r} {hwm.read_text()!r}")
        # A stdout whose FLUSH fails must not advance the mark (print alone buffers).
        c2 = sqlite3.connect(db2); c2.execute(
            "INSERT INTO messages (id, ts, sender, target, body) VALUES (7, 't', 'S', 'R', 'flush-fail')"); c2.commit(); c2.close()
        m6 = _load(REMIND, "remind_owned_prs_km_flushfail")
        m6._claude_ancestor_pid = lambda: 4242
        m6.fleet_label = lambda *a, **k: "R"
        m6.PR_OWN = os.path.join(tempfile.gettempdir(), "km-test-absent", "absent-pr-own")
        m6.subprocess = _fail_soft_subprocess()
        m6.IDENTITY_CACHE = Path(cache)
        m6.COMMS_DB = db2
        class _FlushBoom(io.StringIO):
            def flush(self):
                raise OSError("broken pipe at flush")
        stdin, stdout = sys.stdin, sys.stdout
        sys.stdin = io.StringIO(json.dumps(REMIND_PAYLOAD)); sys.stdout = _FlushBoom()
        try:
            try:
                m6.main()
            except SystemExit:
                pass
        finally:
            sys.stdin, sys.stdout = stdin, stdout
        if hwm.read_text() != "6":
            errs.append(f"mark advanced although the flush failed: {hwm.read_text()!r}")
        ctx11 = _remind("R", cache_dir=cache, COMMS_DB=db2)
        if "📬 COMMS: 1 message(s)" not in ctx11 or hwm.read_text() != "7":
            errs.append(f"flush-failure nudge must resurface: {ctx11[:160]!r} {hwm.read_text()!r}")


def main() -> int:
    errs = []
    ctx_a, ctx_none = check_keep_moving(errs)
    check_scope_per_turn(errs, ctx_a, ctx_none)
    check_scope_owned_pr_path(errs)
    check_scope_failure_paths(errs)
    check_session_start(errs)
    check_pid_bridge_and_nudge(errs)
    for e in errs:
        print("FAIL:", e)
    print("PASS" if not errs else f"{len(errs)} failure(s)")
    return 1 if errs else 0


if __name__ == "__main__":
    sys.exit(main())
