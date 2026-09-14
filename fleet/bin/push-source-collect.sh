#!/usr/bin/env python3
"""Collect fleet watcher alerts into the pocket-console pending-event spool."""
import argparse
import contextlib
import io
import json
import math
import os
import pathlib
import sqlite3
import sys
import tempfile
import time
from datetime import datetime, timezone
from urllib.parse import quote


ENVELOPE_KEYS = {"id", "category", "priority", "title", "body", "deepLink", "source", "ts", "state", "kind"}
SOURCE_KEYS = {"session", "agent", "account", "issue"}
ACTIONABLE_TIERS = {"WARN", "URGENT", "BILLING", "DARK"}
URGENT_TIERS = {"URGENT", "BILLING", "DARK"}
ATTENTION_CATEGORY = "attention"  # One-line policy seam if the feed category changes.
try:
    STALE_PRODUCER_SECS = float(os.environ.get("METER_STALE_PRODUCER_SECS", "1800"))
except (ValueError, TypeError):
    STALE_PRODUCER_SECS = 1800.0


def default_needs_maya_path():
    return pathlib.Path(os.path.expanduser(os.environ.get(
        "NEEDS_MAYA_QUEUE", "~/.claude/spinventory-fleet/needs-maya.json")))


def default_meter_paths():
    raw_paths = os.environ.get(
        "METER_SNAPSHOTS", os.pathsep.join(("~/.heddle/usage/meter-alerts.json",
                                             "~/.heddle/usage/cursor-meter-alerts.json",
                                             "~/.heddle/usage/headroom-alerts.json")))
    return [pathlib.Path(os.path.expanduser(value)) for value in raw_paths.split(os.pathsep) if value]


def default_attention_path():
    return pathlib.Path(os.path.expanduser(os.environ.get(
        "ATTENTION_SPOOL", "~/.heddle/attention/pending.json")))


def default_spool_path():
    return pathlib.Path(os.path.expanduser(os.environ.get("PUSH_SPOOL", "~/.heddle/push/pending.json")))


def read_list(path):
    """Read an array source, warning and returning None when it is unusable."""
    try:
        with pathlib.Path(path).open(encoding="utf-8") as source:
            rows = json.load(source)
        if not isinstance(rows, list):
            raise ValueError("expected JSON array")
        return rows
    except (OSError, ValueError, json.JSONDecodeError, TypeError):
        print(f"[collect-warn] {path} unreadable — skipping")
        return None


def classify_read(path):
    """Classify an array source so missing producers differ from failed reads."""
    try:
        with open(path, encoding="utf-8") as source:
            raw = source.read()
            mtime = os.fstat(source.fileno()).st_mtime
        rows = json.loads(raw)
        if not isinstance(rows, list):
            raise ValueError("expected JSON array")
        return "ok", [row for row in rows if isinstance(row, dict)], mtime
    except FileNotFoundError:
        return "missing", None, None
    except (OSError, ValueError, json.JSONDecodeError, TypeError):
        print(f"[collect-warn] {path} unreadable — skipping")
        return "unreadable", None, None


def read_prev_spool(path):
    """Read the prior spool defensively so transient source failures retain alerts."""
    try:
        with pathlib.Path(path).open(encoding="utf-8") as source:
            events = json.load(source)
        return events if isinstance(events, list) else []
    except (OSError, ValueError, json.JSONDecodeError, TypeError):
        return []


def string_or_none(value):
    return None if value is None else str(value)


def finite_number(value):
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def parse_timestamp(value, context):
    if not isinstance(value, str) or not value:
        print(f"[collect-warn] {context} timestamp unreadable — using 0.0")
        return 0.0
    try:
        normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
        parsed = datetime.fromisoformat(normalized)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        timestamp = parsed.timestamp()
        if not math.isfinite(timestamp):
            raise ValueError("non-finite timestamp")
        return timestamp
    except (TypeError, ValueError, OverflowError):
        print(f"[collect-warn] {context} timestamp unreadable — using 0.0")
        return 0.0


def needs_maya_events(path, rows=None):
    if rows is None:
        rows = read_list(path)
        if rows is None:
            return []
    events = []
    for entry in rows:
        if not isinstance(entry, dict):
            print(f"[collect-warn] {path} malformed entry — skipping")
            continue
        issue = string_or_none(entry.get("issue"))
        if issue is None or not issue:
            print("[collect-warn] needs-maya entry missing issue — skipping")
            continue
        event_issue = issue
        preview = entry.get("ask_preview")
        body = preview.strip()[:140] if isinstance(preview, str) else ""
        events.append({
            "id": f"needs-maya:{event_issue}",
            "category": "needs-maya",
            "kind": None,
            "priority": "urgent",
            "title": f"needs-maya · {event_issue}",
            "body": body,
            "deepLink": f"/approvals/needs-maya/{event_issue}",
            "source": {"session": None, "agent": string_or_none(entry.get("agent")),
                       "account": None, "issue": issue},
            "ts": parse_timestamp(entry.get("ts"), f"needs-maya:{event_issue}"),
            "state": "pending",
        })
    return events


def meter_body(meter, value, tier, resets_in_human):
    number = finite_number(value)
    if number is None:
        body = f"{meter} — {tier}"
    elif meter == "balance":
        body = f"{meter} ${number:.2f} — {tier}"
    else:
        body = f"{meter} {number:g}% — {tier}"
    if resets_in_human is not None:
        body += f" (resets {resets_in_human})"
    return body


def meter_events(paths, now, prev_by_id=None, include_failures=False):
    # Producer mtimes are wall-clock write times, so compare them with one real clock reference,
    # rather than the injected event timestamp used to make event output deterministic.
    real_now = time.time()
    events = []
    any_meter_failed = False
    prev_by_id = {} if prev_by_id is None else prev_by_id
    for path in paths:
        status, rows, mtime = classify_read(path)
        if status == "missing":
            continue
        if status == "unreadable":
            any_meter_failed = True
            continue
        mtime_age = real_now - mtime
        if mtime_age > STALE_PRODUCER_SECS:
            print(f"[collect-warn] {path} stale producer (mtime age {mtime_age:.0f}s) — skipping")
            continue
        for row in rows:
            if not isinstance(row, dict):
                print(f"[collect-warn] {path} malformed entry — skipping")
                continue
            tier = row.get("tier")
            if tier not in ACTIONABLE_TIERS:
                continue
            provider = string_or_none(row.get("provider")) or "None"
            account = string_or_none(row.get("account"))
            account_label = account if account is not None else "None"
            meter = string_or_none(row.get("meter")) or "None"
            value = row.get("balance") if meter == "balance" else row.get("usedPercentage")
            resets_at = row.get("resetsAt")
            resets_label = "none" if resets_at is None else str(resets_at)
            event_id = f"meter:{provider}:{account_label}:{meter}:{tier}:{resets_label}"
            events.append({
                "id": event_id,
                "category": "meter",
                "kind": None,
                "priority": "urgent" if tier in URGENT_TIERS else "normal",
                "title": f"{provider} · {account_label}",
                "body": meter_body(meter, value, tier, row.get("resetsInHuman")),
                "deepLink": "/ops/meters",
                "source": {"session": None, "agent": None, "account": account, "issue": None},
                "ts": prev_by_id[event_id]["ts"] if event_id in prev_by_id else now,
                "state": "pending",
            })
    return (events, any_meter_failed) if include_failures else events


def attention_events(path, rows=None):
    if rows is None:
        rows = read_list(path)
        if rows is None:
            return []
    events = []
    for entry in rows:
        if not isinstance(entry, dict):
            print(f"[collect-warn] {path} malformed entry — skipping")
            continue
        if entry.get("acked_at") is not None:
            continue
        attention_id = string_or_none(entry.get("id"))
        if attention_id is None or not attention_id:
            print(f"[collect-warn] {path} attention entry missing id — skipping")
            continue
        kind = string_or_none(entry.get("kind")) or "attention"
        agent = string_or_none(entry.get("agent"))
        text = entry.get("text")
        events.append({
            "id": f"attention:{attention_id}",
            "category": ATTENTION_CATEGORY,
            "kind": kind,
            "priority": "urgent" if kind in ("needs-clear", "needs-blessing") else "normal",
            "title": f"{kind} · {agent or '?'}",
            "body": text.strip()[:140] if isinstance(text, str) else "",
            "deepLink": "/approvals",
            "source": {"session": None, "agent": agent, "account": None, "issue": None},
            "ts": parse_timestamp(entry.get("ts"), f"attention:{attention_id}"),
            "state": "pending",
        })
    return events


def default_comms_db_path():
    return pathlib.Path(os.path.expanduser(
        os.environ.get("HEDDLE_COMMS_DB", "~/.heddle/comms.db")))


def important_window_secs():
    """Rolling age bound for the ⭐ important-tag source (HED-328). The read-model is emit-once with
    no read-receipt — the Approvals surface owns read-state — so the collector must itself keep the
    ⭐ set bounded, carrying only recent unexpired flags and dropping the rest. Default 24h; override
    via IMPORTANT_TAG_WINDOW_SECS."""
    raw = os.environ.get("IMPORTANT_TAG_WINDOW_SECS", "86400")
    try:
        secs = float(raw)
    except (TypeError, ValueError):
        return 86400.0
    return secs if math.isfinite(secs) and secs > 0 else 86400.0


IMPORTANT_CATEGORY = "important-tag"  # ⭐ important-for-Maya; the Approvals feed owns read-state.


def _iso_utc(epoch):
    return datetime.fromtimestamp(epoch, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def important_tag_events(db_path, prev_events, now, window_secs):
    """Emit ⭐ important-for-Maya notifications (post_message meta.important=true), read-only over
    comms.db.

    HED-328 read-model (option a, agreed with W): the Approvals surface owns read-state, so this
    source carries only ⭐ inside a rolling window, dropping aged-out ones so pending.json cannot
    accumulate every ⭐ ever tagged. The in-window ⭐ are re-derived from comms.db each run by
    TIMESTAMP — deliberately NOT by an id high-water mark: a monotonic id cursor rebuilt from the
    expiring spool would, after a comms.db replacement / id-sequence reset, exceed every id in the
    fresh db and silently suppress new low-id ⭐ (codeant HED-328 review). A comms.db read failure is
    no-new-data: the prior in-window ⭐ are retained, never lost.
    """
    window_start = now - window_secs
    # Failure-path fallback only: on a read error the prior in-window ⭐ are retained (a transient
    # comms.db hiccup must not blank the feed). A successful read re-derives the set from the db.
    prior_in_window = [
        event for event in prev_events
        if isinstance(event, dict) and event.get("category") == IMPORTANT_CATEGORY
        and isinstance(event.get("ts"), (int, float)) and event["ts"] >= window_start
    ]

    try:
        uri = f"{pathlib.Path(db_path).resolve().as_uri()}?mode=ro"
        connection = sqlite3.connect(uri, uri=True, timeout=2.0)
    except (sqlite3.Error, OSError, ValueError) as exc:
        print(f"[collect-warn] comms.db {db_path} unopenable ({exc}) — carrying prior ⭐ only")
        return prior_in_window
    try:
        connection.row_factory = sqlite3.Row
        # The ts window is a bind parameter (no injection); it bounds the scan (AND short-circuits
        # before json_extract on out-of-window rows). The parsed-epoch check below is the
        # authoritative age bound — the ts-string compare is a scan optimization only.
        rows = connection.execute(
            "SELECT id, ts, sender, target, kind, body, issue FROM messages "
            "WHERE ts >= ? AND json_extract(meta, '$.important') = 1 ORDER BY id",
            (_iso_utc(window_start),)).fetchall()
    except sqlite3.Error as exc:
        print(f"[collect-warn] comms.db {db_path} unreadable ({exc}) — carrying prior ⭐ only")
        return prior_in_window
    finally:
        connection.close()

    events = []
    for row in rows:
        message_id = row["id"]
        ts = parse_timestamp(row["ts"], f"important-tag:{message_id}")
        if ts < window_start:  # authoritative age bound (parsed epoch, robust to ts-string edges)
            continue
        target = string_or_none(row["target"])
        sender = string_or_none(row["sender"])
        body = row["body"].strip()[:140] if isinstance(row["body"], str) else ""
        anchor = f"#msg-{message_id}"
        events.append({
            "id": f"important-tag:{message_id}",
            "category": IMPORTANT_CATEGORY,
            "kind": None,
            "priority": "normal",  # ⭐ is informational-but-flagged, not a blocking approval card.
            "title": f"⭐ {sender or '?'}",
            "body": body,
            "deepLink": (f"/chat/{quote(target, safe='')}{anchor}" if target
                         else f"/approvals{anchor}"),
            "source": {"session": target, "agent": sender, "account": None,
                       "issue": string_or_none(row["issue"])},
            "ts": ts,
            "state": "pending",
        })
    return events


def write_spool(path, events):
    """The sole durable output seam; atomically replace the pending-event snapshot."""
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent,
                                     prefix=f".{path.name}.", delete=False) as temp:
        temp_path = pathlib.Path(temp.name)
        try:
            json.dump(events, temp, separators=(",", ":"), allow_nan=False)
            temp.write("\n")
            temp.flush()
            os.fsync(temp.fileno())
        except Exception:
            temp_path.unlink(missing_ok=True)
            raise
    os.replace(temp_path, path)
    directory_fd = None
    try:
        directory_fd = os.open(path.parent, os.O_RDONLY)
        os.fsync(directory_fd)
    except OSError:
        pass
    finally:
        if directory_fd is not None:
            os.close(directory_fd)


def collect(needs_path, meter_paths, spool_path, now=None, attention_path=None,
            comms_db_path=None, important_window=None):
    """Collect once, retain alerts through read failures, and write one pending-event snapshot."""
    captured_now = time.time() if now is None else now
    prev_events = read_prev_spool(spool_path)
    prev_by_id = {
        event["id"]: event for event in prev_events
        if isinstance(event, dict) and isinstance(event.get("id"), str)
    }

    rows = read_list(needs_path)
    needs_final = (
        [event for event in prev_events if isinstance(event, dict) and event.get("category") == "needs-maya"]
        if rows is None else needs_maya_events(needs_path, rows)
    )
    meter_fresh, any_meter_failed = meter_events(
        meter_paths, captured_now, prev_by_id, include_failures=True)
    fresh_ids = {event["id"] for event in meter_fresh}
    meter_final = meter_fresh
    if any_meter_failed:
        meter_final += [
            event for event in prev_events
            if isinstance(event, dict) and event.get("category") == "meter"
            and event.get("id") not in fresh_ids
        ]

    attention_final = []
    if attention_path is not None:
        status, attention_rows, _ = classify_read(attention_path)
        if status == "unreadable":
            attention_final = [
                event for event in prev_events
                if isinstance(event, dict) and event.get("category") == ATTENTION_CATEGORY
            ]
        elif status == "ok":
            attention_final = attention_events(attention_path, attention_rows)

    important_final = []
    if comms_db_path is not None:
        window = important_window if important_window is not None else important_window_secs()
        important_final = important_tag_events(comms_db_path, prev_events, captured_now, window)

    events = needs_final + meter_final + attention_final + important_final
    events.sort(key=lambda event: event["ts"], reverse=True)
    deduped = []
    seen = set()
    for event in events:
        if event["id"] not in seen:
            seen.add(event["id"])
            deduped.append(event)
    write_spool(spool_path, deduped)
    for event in deduped:
        print(f"[collect-emit] category={event['category']} id={event['id']}")
    return deduped


def selftest():
    with tempfile.TemporaryDirectory() as directory:
        root = pathlib.Path(directory)
        needs = root / "needs-maya.json"
        meter_one = root / "meter-one.json"
        meter_two = root / "meter-two.json"
        attention = root / "attention-pending.json"
        spool = root / "pending.json"
        needs.write_text(json.dumps([
            {"issue": "HED-331", "agent": "violet", "ts": "2026-08-22T20:57:53.923859Z",
             "ask_preview": "  Approve the pocket console contract.  "},
            {"issue": "HED-332", "agent": "indigo", "ts": "2026-08-22T21:00:00Z",
             "ask_preview": "Second approval"},
        ]), encoding="utf-8")
        meter_one.write_text(json.dumps([
            {"provider": "claude", "account": "primary", "meter": "weekly", "usedPercentage": 91,
             "tier": "WARN", "resetsInHuman": "2h"},
            {"provider": "codex", "account": "primary", "meter": "weekly", "usedPercentage": 98,
             "tier": "URGENT"},
            {"provider": "openrouter", "account": "primary", "meter": "balance", "balance": 1.5,
             "tier": "BILLING"},
            {"provider": "cursor", "account": "primary", "meter": "monthly", "usedPercentage": 99,
             "tier": "DARK"},
            {"provider": "skip", "account": "primary", "meter": "weekly", "usedPercentage": 1,
             "tier": "OK"},
            {"provider": "skip", "account": "primary", "meter": "weekly", "usedPercentage": 1,
             "tier": "STALE"},
        ]), encoding="utf-8")
        meter_two.write_text(json.dumps([
            {"provider": "gemini", "account": "secondary", "meter": "weekly", "usedPercentage": 92,
             "tier": "WARN"},
            {"provider": "claude", "account": "primary", "meter": "weekly", "usedPercentage": 91,
             "tier": "WARN"},
        ]), encoding="utf-8")
        attention.write_text(json.dumps([
            {"id": "clear-1", "kind": "needs-clear", "agent": "violet",
             "text": "  Please clear the host seam.  ",
             "ts": "2026-08-22T20:57:53.923859+00:00", "acked_at": None},
            {"id": "attention-1", "kind": "attention", "agent": "indigo",
             "text": "General fleet attention", "ts": "2026-08-22T21:00:00Z", "acked_at": None},
            {"id": "acked-1", "kind": "needs-blessing", "agent": "gold",
             "text": "This has been retracted", "ts": "2026-08-22T21:01:00Z",
             "acked_at": "2026-08-22T21:02:00Z"},
        ]), encoding="utf-8")

        events = collect(needs, [meter_one, meter_two], spool, now=1234.5, attention_path=attention)
        saved = json.loads(spool.read_text(encoding="utf-8"))
        assert events == saved
        assert len([event for event in saved if event["category"] == "needs-maya"]) == 2
        approval = next(event for event in saved if event["id"] == "needs-maya:HED-331")
        assert approval["title"] == "needs-maya · HED-331"
        assert approval["deepLink"] == "/approvals/needs-maya/HED-331"
        assert approval["source"]["issue"] == "HED-331" and approval["source"]["agent"] == "violet"
        assert approval["ts"] > 0 and approval["state"] == "pending" and approval["kind"] is None
        meters = [event for event in saved if event["category"] == "meter"]
        assert len(meters) == 5
        priorities = {event["id"].rsplit(":", 2)[1]: event["priority"] for event in meters}
        assert priorities == {"WARN": "normal", "URGENT": "urgent", "BILLING": "urgent", "DARK": "urgent"}
        balance = next(event for event in meters if ":balance:BILLING" in event["id"])
        assert "$1.50" in balance["body"] and "%" not in balance["body"]
        assert balance["kind"] is None
        assert any(event["source"]["account"] == "secondary" for event in meters)
        assert sum(event["id"] == "meter:claude:primary:weekly:WARN:none" for event in meters) == 1
        attention_events_emitted = [event for event in saved if event["category"] == ATTENTION_CATEGORY]
        assert len(attention_events_emitted) == 2
        clear_attention = next(event for event in attention_events_emitted if event["id"] == "attention:clear-1")
        assert (clear_attention["category"] == ATTENTION_CATEGORY
                and clear_attention["kind"] == "needs-clear"
                and clear_attention["priority"] == "urgent"
                and clear_attention["title"] == "needs-clear · violet"
                and clear_attention["deepLink"] == "/approvals")
        normal_attention = next(event for event in attention_events_emitted if event["id"] == "attention:attention-1")
        assert (normal_attention["kind"] == "attention"
                and normal_attention["priority"] == "normal"
                and normal_attention["title"] == "attention · indigo")
        assert "attention:acked-1" not in {event["id"] for event in saved}
        assert all(set(event) == ENVELOPE_KEYS and set(event["source"]) == SOURCE_KEYS for event in saved)

        # Meter snapshots expire by producer cadence, unlike decision/ack-based attention items.
        stale_meter = root / "stale-meter.json"
        stale_meter.write_text(json.dumps([
            {"provider": "stalled", "account": "primary", "meter": "weekly",
             "usedPercentage": 91, "tier": "WARN"},
        ]), encoding="utf-8")
        stale_at = time.time() - 7200
        os.utime(stale_meter, (stale_at, stale_at))
        captured = io.StringIO()
        with contextlib.redirect_stdout(captured):
            assert meter_events([stale_meter], now=1234.5) == []
        assert f"[collect-warn] {stale_meter} stale producer" in captured.getvalue()

        fresh_meter = root / "fresh-meter.json"
        fresh_meter.write_text(stale_meter.read_text(encoding="utf-8"), encoding="utf-8")
        fresh_events = meter_events([fresh_meter], now=1234.5)
        assert len(fresh_events) == 1 and fresh_events[0]["category"] == "meter"

        old_attention_at = time.time() - 7200
        os.utime(attention, (old_attention_at, old_attention_at))
        attention_only = collect(root / "attention-only-needs.json", [],
                                 root / "attention-only-pending.json", now=1234.5,
                                 attention_path=attention)
        assert {event["id"] for event in attention_only if event["category"] == ATTENTION_CATEGORY} == {
            "attention:clear-1", "attention:attention-1"}

        captured = io.StringIO()
        with contextlib.redirect_stdout(captured):
            attention_events(attention, [{"id": "bad-timestamp", "ts": "not-a-timestamp"}])
        assert "[collect-warn] attention:bad-timestamp timestamp unreadable — using 0.0" in captured.getvalue()

        missing_attention = root / "not-yet-created-attention.json"
        missing_attention_spool = root / "missing-attention-pending.json"
        prior_attention = clear_attention
        write_spool(missing_attention_spool, [prior_attention])
        missing_attention_events = collect(needs, [meter_one, meter_two], missing_attention_spool,
                                           now=1234.5, attention_path=missing_attention)
        assert not [event for event in missing_attention_events if event["category"] == ATTENTION_CATEGORY]

        malformed_attention = root / "malformed-attention.json"
        malformed_attention.write_text("{bad", encoding="utf-8")
        write_spool(missing_attention_spool, [prior_attention])
        captured = io.StringIO()
        with contextlib.redirect_stdout(captured):
            preserved_attention_events = collect(needs, [meter_one, meter_two], missing_attention_spool,
                                                 now=1234.5, attention_path=malformed_attention)
        assert prior_attention["id"] in {event["id"] for event in preserved_attention_events}
        assert "[collect-warn]" in captured.getvalue()

        # A not-yet-created producer is no data, while an existing corrupt one retains meter alerts.
        retraction_needs = root / "retraction-needs.json"
        retraction_needs.write_text("[]", encoding="utf-8")
        valid_empty_meter = root / "valid-empty-meter.json"
        valid_empty_meter.write_text("[]", encoding="utf-8")
        missing_meter = root / "not-yet-created-meter.json"
        retraction_spool = root / "retraction-pending.json"
        prior_meter = next(event for event in saved if event["category"] == "meter")
        write_spool(retraction_spool, [prior_meter])
        cleared_events = collect(retraction_needs, [valid_empty_meter, missing_meter],
                                 retraction_spool, now=1234.5)
        assert not [event for event in cleared_events if event["category"] == "meter"]

        malformed_meter = root / "malformed-meter.json"
        malformed_meter.write_text("{", encoding="utf-8")
        write_spool(retraction_spool, [prior_meter])
        captured = io.StringIO()
        with contextlib.redirect_stdout(captured):
            preserved_events = collect(retraction_needs, [valid_empty_meter, malformed_meter],
                                       retraction_spool, now=1234.5)
        assert prior_meter["id"] in {event["id"] for event in preserved_events}
        assert "[collect-warn]" in captured.getvalue()

        # Regression contracts for timestamp handling, deduplication, and source resilience.
        assert parse_timestamp("2026-08-22T21:00:00", "HED-naive") == parse_timestamp(
            "2026-08-22T21:00:00Z", "HED-naive")

        missing_issue = root / "missing-issue.json"
        missing_issue.write_text(json.dumps([{"issue": None, "ts": "2026-08-22T21:00:00Z"}]),
                                 encoding="utf-8")
        captured = io.StringIO()
        with contextlib.redirect_stdout(captured):
            assert needs_maya_events(missing_issue) == []
        assert "[collect-warn] needs-maya entry missing issue — skipping" in captured.getvalue()

        reset_meter = root / "reset-meter.json"
        reset_meter.write_text(json.dumps([
            {"provider": "codex", "account": "primary", "meter": "weekly", "tier": "WARN",
             "usedPercentage": 91, "resetsAt": "2026-08-23T00:00:00Z"},
            {"provider": "codex", "account": "primary", "meter": "weekly", "tier": "WARN",
             "usedPercentage": 91, "resetsAt": "2026-08-30T00:00:00Z"},
        ]), encoding="utf-8")
        reset_events = meter_events([reset_meter], now=100.0)
        assert len(reset_events) == 2 and len({event["id"] for event in reset_events}) == 2

        stable_needs = root / "stable-needs.json"
        stable_needs.write_text(json.dumps([
            {"issue": "HED-stable", "ts": "2026-08-22T19:00:00Z"},
        ]), encoding="utf-8")
        stable_spool = root / "stable-pending.json"
        first_run = collect(stable_needs, [reset_meter], stable_spool, now=100.0)
        first_meter_ts = {event["id"]: event["ts"] for event in first_run if event["category"] == "meter"}
        first_needs = [event for event in first_run if event["category"] == "needs-maya"]

        stable_needs.write_text('"notalist"', encoding="utf-8")
        captured = io.StringIO()
        with contextlib.redirect_stdout(captured):
            second_run = collect(stable_needs, [reset_meter], stable_spool, now=200.0)
        assert "[collect-warn]" in captured.getvalue()
        second_meter_ts = {event["id"]: event["ts"] for event in second_run if event["category"] == "meter"}
        assert second_meter_ts == first_meter_ts
        assert [event for event in second_run if event["category"] == "needs-maya"] == first_needs

        dedup_needs = root / "dedup-needs.json"
        dedup_needs.write_text(json.dumps([
            {"issue": "HED-dedup", "ts": "2026-08-22T20:00:00Z"},
            {"issue": "HED-dedup", "ts": "2026-08-22T21:00:00Z"},
        ]), encoding="utf-8")
        dedup_events = collect(dedup_needs, [], root / "dedup-pending.json", now=100.0)
        assert len(dedup_events) == 1 and dedup_events[0]["ts"] == parse_timestamp(
            "2026-08-22T21:00:00Z", "HED-dedup")

        needs.write_text('"notalist"', encoding="utf-8")
        captured = io.StringIO()
        with contextlib.redirect_stdout(captured):
            malformed_events = collect(needs, [meter_one], spool, now=1234.5)
        assert "[collect-warn]" in captured.getvalue()
        assert any(event["category"] == "needs-maya" for event in malformed_events)
        assert any(event["category"] == "meter" for event in malformed_events)

        # --- HED-328: ⭐ important-tag source (emit-once, age-bound, surface owns read-state) ---
        def as_iso(epoch):
            return datetime.fromtimestamp(epoch, tz=timezone.utc).strftime(
                "%Y-%m-%dT%H:%M:%S.000Z")
        comms_db = root / "comms.db"
        star_db = sqlite3.connect(str(comms_db))
        star_db.execute("CREATE TABLE messages (id INTEGER PRIMARY KEY, ts TEXT, sender TEXT, "
                        "target TEXT, kind TEXT, body TEXT, issue TEXT, meta TEXT)")
        base = 10_000.0  # epoch seconds; the window below is 3600s
        star_db.executemany(
            "INSERT INTO messages (id, ts, sender, target, kind, body, issue, meta) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [
                (1, as_iso(base - 100), "V", "#fleet", "chat", "  recent star  ", "HED-328",
                 json.dumps({"transport": "heddle-comms", "important": True})),
                (2, as_iso(base - 50), "W", "V", "chat", "plain message", None,
                 json.dumps({"transport": "heddle-comms"})),
                (3, as_iso(base - 9000), "T", "#fleet", "chat", "old star", None,
                 json.dumps({"important": True})),
            ])
        star_db.commit()
        star_db.close()

        stars = important_tag_events(comms_db, [], base, 3600.0)
        # Only the recent ⭐ (id 1) emits: plain msg (id 2) filtered by the predicate, aged-out ⭐
        # (id 3) dropped by the window.
        assert [event["id"] for event in stars] == ["important-tag:1"], stars
        recent = stars[0]
        assert recent["category"] == IMPORTANT_CATEGORY and recent["priority"] == "normal"
        assert recent["title"] == "⭐ V" and recent["body"] == "recent star"  # trimmed
        assert recent["deepLink"] == "/chat/%23fleet#msg-1"  # room "#" URL-encoded, msg-id anchor
        assert recent["source"] == {"session": "#fleet", "agent": "V", "account": None,
                                    "issue": "HED-328"}
        assert set(recent) == ENVELOPE_KEYS and set(recent["source"]) == SOURCE_KEYS
        assert recent["ts"] == base - 100  # parsed epoch round-trips

        # Re-query snapshot: the in-window ⭐ is re-derived from the db each run (the Approvals
        # surface dedups by id via read-state), so id 1 is found again while inside the window.
        again = important_tag_events(comms_db, stars, base + 10, 3600.0)
        assert [event["id"] for event in again] == ["important-tag:1"]

        # Age-bound: once id 1 leaves the window the ts query no longer returns it.
        assert important_tag_events(comms_db, stars, base + 4000, 3600.0) == []

        # DB-reset robustness (codeant HED-328): a stale high-id carry must NOT suppress a new low-id
        # ⭐ in a replaced db. With a ts-window query (no id high-water mark) the low-id ⭐ surfaces;
        # an id>cursor design seeded from prev (99999) would have lost it.
        stale_prev = [dict(stars[0], id="important-tag:99999", ts=base - 100)]
        reset = important_tag_events(comms_db, stale_prev, base, 3600.0)
        assert [event["id"] for event in reset] == ["important-tag:1"]

        # comms.db unopenable → carry the prior in-window ⭐ only, never crash.
        captured = io.StringIO()
        with contextlib.redirect_stdout(captured):
            resilient = important_tag_events(root / "absent.db", stars, base + 10, 3600.0)
        assert [event["id"] for event in resilient] == ["important-tag:1"]
        assert "[collect-warn]" in captured.getvalue()

        # End-to-end through collect(): the ⭐ lands in the written snapshot.
        star_needs = root / "star-needs.json"
        star_needs.write_text("[]", encoding="utf-8")
        star_meter = root / "star-meter.json"
        star_meter.write_text("[]", encoding="utf-8")
        star_spool = root / "star-spool.json"
        collected = collect(star_needs, [star_meter], star_spool, now=base,
                            comms_db_path=comms_db, important_window=3600.0)
        assert [event["id"] for event in collected] == ["important-tag:1"]
        assert json.loads(star_spool.read_text(encoding="utf-8"))[0]["id"] == "important-tag:1"

        empty_needs = root / "empty-needs.json"
        empty_meter = root / "empty-meter.json"
        empty_needs.write_text("[]", encoding="utf-8")
        empty_meter.write_text("[]", encoding="utf-8")
        assert collect(empty_needs, [empty_meter], spool, now=1234.5) == []
        assert json.loads(spool.read_text(encoding="utf-8")) == []
    print("SELFTEST PASS")
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--selftest", action="store_true", help="run isolated collector contract checks")
    parser.add_argument("--once", action="store_true",
                        help="required run mode: read sources, atomically regenerate pending.json, then exit")
    args = parser.parse_args()
    if args.selftest:
        try:
            return selftest()
        except Exception as exc:
            print(f"[collect-error] selftest {exc}")
            return 1
    elif args.once:
        try:
            collect(default_needs_maya_path(), default_meter_paths(), default_spool_path(),
                    attention_path=default_attention_path(),
                    comms_db_path=default_comms_db_path())
            return 0
        except Exception as exc:
            print(f"[collect-error] {exc}")
            return 1
    print("push-source-collect.sh: specify --once to regenerate pending.json (or --selftest)",
          file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
