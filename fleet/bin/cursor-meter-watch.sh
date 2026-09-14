#!/usr/bin/env python3
"""One-pass desktop watcher for Cursor API-meter exhaustion."""
import argparse
import contextlib
import io
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import time


STALE_AFTER = int(os.environ.get("CURSOR_METER_STALE_SECS", "900"))
STATE_DIR = pathlib.Path(os.path.expanduser(os.environ.get(
    "CURSOR_METER_STATE_DIR", "~/.claude/spinventory-fleet/cursor-meter-watch")))
ALERTED_SEEN = STATE_DIR / "alerted.seen"
SNAPSHOT_PATH = pathlib.Path(os.path.expanduser(os.environ.get(
    "CURSOR_METER_SNAPSHOT", "~/.heddle/usage/cursor-meter-alerts.json")))


def seen_keys(path):
    try:
        return set(path.read_text().splitlines())
    except OSError:
        return set()


def record_seen(path, key):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as state:
        state.write(key + "\n")
        state.flush()
        os.fsync(state.fileno())


def resets_in_human(resets_at, now):
    if not isinstance(resets_at, (int, float)):
        return None
    seconds = max(0, int(resets_at - now))
    days, seconds = divmod(seconds, 86400)
    hours, seconds = divmod(seconds, 3600)
    minutes = seconds // 60
    if days:
        return f"{days}d {hours}h"
    return f"{hours}h {minutes}m"


def write_snapshot(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent,
                                     prefix=f".{path.name}.", delete=False) as temp:
        temp_path = pathlib.Path(temp.name)
        try:
            json.dump(rows, temp, separators=(",", ":"), allow_nan=False)
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


def _osascript_notify(title, message):
    # AppleScript strings: escape backslash first, then double-quote, so a value containing " or \
    # cannot break out of the literal. Reliable delivery on stock macOS, but respects Do Not
    # Disturb and is NOT clickable (osascript display-notification has no click action).
    msg = message.replace("\\", "\\\\").replace('"', '\\"')
    subj = title.replace("\\", "\\\\").replace('"', '\\"')
    subprocess.run(
        ["osascript", "-e", f'display notification "{msg}" with title "{subj}" sound name "Glass"'],
        check=True, timeout=10)


def notify(label, tier, message):
    """Fire one native macOS notification and report whether it completed cleanly."""
    # osascript is the only reliable notifier on Maya's macOS Tahoe (terminal-notifier is a no-op
    # there — see HED-305); timeout-bounded so a hung notifier can't wedge the poll.
    try:
        _osascript_notify("Cursor meter", message)
        return True
    except Exception as exc:
        print(f"[watch-error] notify {label}:{tier} {exc}")
        return False


def window(account, window_id):
    return next((item for item in (account.get("windows") or [])
                 if item.get("id") == window_id), {})


def tier_for(account):
    """Return the highest alert tier reached by one Cursor account."""
    note_codes = set(account.get("noteCodes") or [])
    included_api = window(account, "included-api")
    usage_based = window(account, "usage-based")
    on_demand = (account.get("detail") or {}).get("onDemand") or {}
    remaining = on_demand.get("remaining")

    if ((usage_based.get("usedPercentage") or 0) >= 98
            or "cursor.onDemandLimitReached" in note_codes
            or (on_demand.get("enabled") and remaining is not None and remaining <= 0)):
        return "DARK"
    if "cursor.includedApiExhausted" in note_codes:
        return "BILLING"
    if (included_api.get("usedPercentage") or 0) >= 85:
        return "WARN"
    return "OK"


def message_for(label, tier, account):
    included_pct = window(account, "included-api").get("usedPercentage") or 0
    remaining = ((account.get("detail") or {}).get("onDemand") or {}).get("remaining")
    remaining_usd = 0.0 if remaining is None else remaining / 100.0
    if tier == "WARN":
        return f"{label}: Bugbot API pool at {included_pct}% — switch the Bugbot account soon"
    if tier == "BILLING":
        return (f"{label}: Bugbot API pool EXHAUSTED — now billing on-demand "
                f"(${remaining_usd:.2f} left). Switch accounts.")
    if tier == "DARK":
        return f"{label}: Bugbot on-demand nearly gone — about to go dark. Switch accounts NOW."
    return f"{label}: Bugbot meter tier {tier}"


def watch(limits_path):
    try:
        with pathlib.Path(limits_path).open() as source:
            data = json.load(source)
        cursor = next((block for block in data.get("limits") or []
                       if block.get("provider") == "cursor"), None)
        STATE_DIR.mkdir(parents=True, exist_ok=True)
    except Exception as exc:
        print(f"[watch-error] limits {limits_path} {exc}")
        return 1
    if cursor is None:
        print(f"[watch-error] no cursor provider in {limits_path}")
        return 1
    accounts = cursor.get("accounts")
    if not isinstance(accounts, list):
        print("[watch-warn] cursor accounts missing/non-list — preserving prior snapshot")
        return 0

    seen = seen_keys(ALERTED_SEEN)
    now = time.time()
    notify_failed = False
    try:
        rows = []
        for account in accounts:
            label = account.get("label") or "<unlabeled>"
            captured_at = account.get("capturedAt")
            age = int(now - captured_at) if isinstance(captured_at, (int, float)) else STALE_AFTER + 1
            stale = bool(account.get("stale")) or age > STALE_AFTER
            account_tier = "STALE" if stale else tier_for(account)
            included_api = window(account, "included-api")
            resets_at = included_api.get("resetsAt")
            rows.append({"provider": "cursor", "account": label, "meter": "bugbot-api",
                         "usedPercentage": included_api.get("usedPercentage"),
                         "tier": account_tier,
                         "resetsAt": resets_at,
                         "resetsInHuman": resets_in_human(resets_at, now), "stale": stale})
            if stale:
                stale_key = f"stale:{label}:{captured_at}"
                if stale_key not in seen:
                    print(f"[watch-warn] account={label} stale (capturedAt age {age}s > {STALE_AFTER}s) — skipping")
                    record_seen(ALERTED_SEEN, stale_key)
                    seen.add(stale_key)
                continue

            if account_tier == "OK":
                continue
            key = f"{label}:{account_tier}:{resets_at}"
            if key in seen:
                continue
            if notify(label, account_tier, message_for(label, account_tier, account)):
                record_seen(ALERTED_SEEN, key)
                seen.add(key)
                print(f"[watch-emit] account={label} tier={account_tier} key={key}")
            else:
                notify_failed = True
        write_snapshot(SNAPSHOT_PATH, rows)
    except Exception as exc:
        print(f"[watch-error] watch {exc}")
        return 1
    # A notifier failure must be visible to a supervisor, not masked as a healthy poll.
    return 1 if notify_failed else 0


def selftest():
    """Exercise Cursor snapshot rows and alert deduplication without desktop notifications."""
    global ALERTED_SEEN, SNAPSHOT_PATH, STATE_DIR, notify, write_snapshot
    original_notify = notify
    original_write_snapshot = write_snapshot
    original_state_dir = STATE_DIR
    original_alerted_seen = ALERTED_SEEN
    original_snapshot_path = SNAPSHOT_PATH
    original_environment = {
        name: os.environ.get(name)
        for name in ("CURSOR_METER_SNAPSHOT", "CURSOR_METER_STATE_DIR", "HEDDLE_LIMITS_PATH")
    }
    emitted = []

    def fake_notify(label, tier, message):
        emitted.append((label, tier, message))
        return True

    def expect(condition, message):
        if not condition:
            raise AssertionError(message)

    try:
        notify = fake_notify
        now = time.time()
        resets_at = now + 7200
        limits = {"limits": [{"provider": "cursor", "accounts": [
            {"label": "warn", "capturedAt": now, "windows": [
                {"id": "included-api", "usedPercentage": 85, "resetsAt": resets_at}]},
            {"label": "billing", "capturedAt": now,
             "noteCodes": ["cursor.includedApiExhausted"], "windows": [
                 {"id": "included-api", "usedPercentage": 50, "resetsAt": resets_at}]},
            {"label": "dark", "capturedAt": now,
             "detail": {"onDemand": {"enabled": True, "remaining": 0}}, "windows": [
                 {"id": "included-api", "usedPercentage": 50, "resetsAt": resets_at}]},
            {"label": "ok", "capturedAt": now, "windows": [
                {"id": "included-api", "usedPercentage": 84, "resetsAt": resets_at}]},
            {"label": "stale", "capturedAt": now - STALE_AFTER - 1, "windows": [
                {"id": "included-api", "usedPercentage": 99, "resetsAt": resets_at}]},
        ]}]}
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            limits_path = root / "limits.json"
            snapshot_path = root / "cursor-meter-alerts.json"
            state_dir = root / "state"
            limits_path.write_text(json.dumps(limits), encoding="utf-8")
            os.environ.update({"CURSOR_METER_SNAPSHOT": str(snapshot_path),
                               "CURSOR_METER_STATE_DIR": str(state_dir),
                               "HEDDLE_LIMITS_PATH": str(limits_path)})
            STATE_DIR = state_dir
            ALERTED_SEEN = state_dir / "alerted.seen"
            SNAPSHOT_PATH = snapshot_path
            expect(watch(limits_path) == 0, "synthetic watcher poll failed")

            rows = json.loads(snapshot_path.read_text(encoding="utf-8"))
            expect(len(rows) == 5, "snapshot did not contain one row per account")
            expected_keys = {"provider", "account", "meter", "usedPercentage", "tier",
                             "resetsAt", "resetsInHuman", "stale"}
            rows_by_account = {row["account"]: row for row in rows}
            expect(set(rows_by_account) == {"warn", "billing", "dark", "ok", "stale"},
                   "snapshot accounts do not match fixture")
            for row in rows:
                expect(set(row) == expected_keys and row["meter"] == "bugbot-api",
                       "snapshot row shape is incorrect")
            expect(rows_by_account["stale"]["tier"] == "STALE" and rows_by_account["stale"]["stale"],
                   "stale account row is not marked STALE")
            for label in ("warn", "billing", "dark", "ok"):
                expect(rows_by_account[label]["tier"] == tier_for(
                    next(account for account in limits["limits"][0]["accounts"]
                         if account["label"] == label)), f"{label} tier mismatch")
            seen = seen_keys(state_dir / "alerted.seen")
            expect(all(any(key.startswith(f"{label}:") for key in seen)
                       for label in ("warn", "billing", "dark")), "actionable tiers did not emit")
            expect([label for label, _, _ in emitted] == ["warn", "billing", "dark"],
                   "OK or stale account emitted an alert")

            missing_accounts_path = root / "missing-accounts-limits.json"
            missing_accounts_path.write_text(json.dumps({
                "limits": [{"provider": "cursor"}],
            }), encoding="utf-8")
            snapshot_path.write_text('["preserve-this"]\n', encoding="utf-8")
            snapshot_before = snapshot_path.read_text(encoding="utf-8")
            snapshot_calls = []

            def tracking_write_snapshot(path, rows):
                snapshot_calls.append((path, rows))

            write_snapshot = tracking_write_snapshot
            captured = io.StringIO()
            with contextlib.redirect_stdout(captured):
                expect(watch(missing_accounts_path) == 0,
                       "missing accounts watcher poll failed")
            expect(snapshot_calls == [], "missing accounts wrote a snapshot")
            expect(snapshot_path.read_text(encoding="utf-8") == snapshot_before,
                   "missing accounts changed the prior snapshot")
            expect("[watch-warn] cursor accounts missing/non-list" in captured.getvalue(),
                   "missing accounts warning was not printed")
    except AssertionError as exc:
        print(f"SELFTEST FAIL: {exc}")
        return 1
    finally:
        notify = original_notify
        write_snapshot = original_write_snapshot
        STATE_DIR = original_state_dir
        ALERTED_SEEN = original_alerted_seen
        SNAPSHOT_PATH = original_snapshot_path
        for name, value in original_environment.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value
    print("SELFTEST PASS")
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limits", default=os.environ.get(
        "HEDDLE_LIMITS_PATH", "~/.heddle/usage/limits.json"),
                        help="Path to Heddle limits.json")
    parser.add_argument("--selftest", action="store_true", help="Run isolated synthetic watcher checks")
    args = parser.parse_args()
    if args.selftest:
        return selftest()
    return watch(os.path.expanduser(args.limits))


if __name__ == "__main__":
    sys.exit(main())
