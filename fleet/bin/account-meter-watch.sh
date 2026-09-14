#!/usr/bin/env python3
"""One-pass desktop watcher for weekly and monthly account-meter exhaustion."""
import argparse
import contextlib
import io
import json
import math
import os
import pathlib
import subprocess
import sys
import tempfile
import time


STATE_DIR = pathlib.Path(os.path.expanduser(os.environ.get(
    "ACCOUNT_METER_STATE_DIR", "~/.claude/spinventory-fleet/account-meter-watch")))
ALERTED_SEEN = STATE_DIR / "alerted.seen"
SNAPSHOT_PATH = pathlib.Path(os.path.expanduser(os.environ.get(
    "ACCOUNT_METER_SNAPSHOT", "~/.heddle/usage/meter-alerts.json")))


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


def clear_seen(path, key, seen):
    """Atomically remove a recovered alert key from durable and in-memory state."""
    if key not in seen:
        return
    retained = [line for line in path.read_text(encoding="utf-8").splitlines() if line != key]
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent,
                                     prefix=f".{path.name}.", delete=False) as temp:
        if retained:
            temp.write("\n".join(retained) + "\n")
        temp.flush()
        os.fsync(temp.fileno())
        temp_path = pathlib.Path(temp.name)
    os.replace(temp_path, path)
    directory_fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
    seen.remove(key)


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
    # osascript is the reliable notifier on Maya's macOS; timeout-bounded so a hung notifier
    # cannot wedge the poll.
    try:
        _osascript_notify("Usage alert", message)
        return True
    except Exception as exc:
        print(f"[watch-error] notify {label}:{tier} {exc}")
        return False


def cycle_tier(used_percentage, warn_pct, urgent_pct):
    if not isinstance(used_percentage, (int, float)):
        return "OK"
    if used_percentage >= urgent_pct:
        return "URGENT"
    if used_percentage >= warn_pct:
        return "WARN"
    return "OK"


def resets_in_human(resets_at, now):
    if not isinstance(resets_at, (int, float)):
        return "unknown"
    seconds = max(0, int(resets_at - now))
    days, seconds = divmod(seconds, 86400)
    hours, seconds = divmod(seconds, 3600)
    minutes = seconds // 60
    if days:
        return f"{days}d {hours}h"
    return f"{hours}h {minutes}m"


def is_stale(unit, block, now):
    stale_after = block.get("staleAfterSecs", 900)
    if not isinstance(stale_after, (int, float)):
        stale_after = 900
    captured_at = unit.get("capturedAt", block.get("capturedAt"))
    age = int(now - captured_at) if isinstance(captured_at, (int, float)) else int(stale_after) + 1
    return bool(unit.get("stale")) or bool(block.get("stale")) or age > stale_after, age


def included_total(account):
    # Intentionally only Cursor's monthly included-total pool. Never inspect 5h or API windows.
    return next((item for item in (account.get("windows") or [])
                 if item.get("id") == "included-total"), None)


def openrouter_balance(unit):
    """Return a dollar balance from the known defensive scalar/dict spellings, or None."""
    def numeric_balance(value):
        if isinstance(value, bool):
            return None
        if isinstance(value, (int, float)):
            result = float(value)
        elif isinstance(value, str):
            try:
                result = float(value)
            except ValueError:
                return None
        else:
            return None
        return result if math.isfinite(result) else None

    for key in ("balance", "credits"):
        value = unit.get(key)
        result = numeric_balance(value)
        if result is not None:
            return result
        if isinstance(value, dict):
            for subkey in ("remaining", "amount", "usd", "balance"):
                candidate = value.get(subkey)
                result = numeric_balance(candidate)
                if result is not None:
                    return result
    return None


def write_snapshot(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent,
                                     prefix=f".{path.name}.", delete=False) as temp:
        json.dump(rows, temp, separators=(",", ":"), allow_nan=False)
        temp.write("\n")
        temp.flush()
        os.fsync(temp.fileno())
        temp_path = pathlib.Path(temp.name)
    os.replace(temp_path, path)
    directory_fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def meter_row(provider, account, meter, value, tier, resets_at, now, stale):
    return {"provider": provider, "account": account, "meter": meter,
            "usedPercentage" if meter != "balance" else "balance": value,
            "tier": tier, "resetsAt": resets_at,
            "resetsInHuman": None if meter == "balance" else resets_in_human(resets_at, now),
            "stale": stale}


def cycle_meter(provider, label, meter, value, resets_at, stale, rows, now, warn_pct, urgent_pct):
    tier = cycle_tier(value, warn_pct, urgent_pct)
    rows.append(meter_row(provider, label, meter, value, "STALE" if stale else tier,
                          resets_at, now, stale))
    return tier


def watch(limits_path, state_dir=STATE_DIR, snapshot_path=SNAPSHOT_PATH):
    try:
        with pathlib.Path(limits_path).open() as source:
            data = json.load(source)
        blocks = data.get("limits")
        if not isinstance(blocks, list):
            raise ValueError("limits must be a list")
        state_dir.mkdir(parents=True, exist_ok=True)
    except Exception as exc:
        print(f"[watch-error] limits {limits_path} {exc}")
        return 1

    warned_path = state_dir / "alerted.seen"
    seen = seen_keys(warned_path)
    try:
        now = time.time()
        try:
            warn_pct = float(os.environ.get("WARN_PCT", "90"))
            urgent_pct = float(os.environ.get("URGENT_PCT", "97"))
            openrouter_warn = float(os.environ.get("OPENROUTER_WARN_USD", "5.0"))
        except ValueError:
            print("[watch-error] bad threshold env")
            return 1
        rows = []
        notify_failed = False

        def warn_once(key, message):
            if key not in seen:
                print(message)
                record_seen(warned_path, key)
                seen.add(key)

        def emit(provider, label, meter, tier, resets_at, message):
            nonlocal notify_failed
            key = f"{provider}:{label}:{meter}:{tier}:{resets_at}"
            if key not in seen:
                if notify(f"{provider}/{label}", tier, message):
                    record_seen(warned_path, key)
                    seen.add(key)
                    print(f"[watch-emit] provider={provider} account={label} meter={meter} tier={tier} key={key}")
                else:
                    notify_failed = True

        for block in blocks:
            if not isinstance(block, dict):
                raise ValueError("provider block must be an object")
            provider = block.get("provider")
            if provider not in ("claude", "codex", "gemini", "cursor", "openrouter"):
                continue

            if provider == "openrouter":
                units = block.get("accounts") if isinstance(block.get("accounts"), list) else [block]
                found_balance = False
                for unit in units:
                    if not isinstance(unit, dict):
                        continue
                    label = unit.get("label") or block.get("model") or "default"
                    stale, age = is_stale(unit, block, now)
                    balance = openrouter_balance(unit)
                    if balance is None and unit is not block:
                        balance = openrouter_balance(block)
                    if balance is None:
                        continue
                    found_balance = True
                    tier = "WARN" if balance < openrouter_warn else "OK"
                    rows.append(meter_row(provider, label, "balance", balance,
                                           "STALE" if stale else tier, None, now, stale))
                    if stale:
                        warn_once(f"stale:{provider}:{label}:{unit.get('capturedAt', block.get('capturedAt'))}",
                                  f"[watch-warn] {provider}/{label} stale (age {age}s) — skipping")
                    elif tier == "WARN":
                        key = f"openrouter:{label}:balance:WARN"
                        if key not in seen:
                            message = f"openrouter {label}: balance ${balance:.2f} low (WARN)"
                            if notify(f"openrouter/{label}", tier, message):
                                record_seen(warned_path, key)
                                seen.add(key)
                                print(f"[watch-emit] provider=openrouter account={label} meter=balance tier=WARN key={key}")
                            else:
                                notify_failed = True
                    else:
                        # Recovery re-arms a later low-balance alert.
                        clear_seen(warned_path, f"openrouter:{label}:balance:WARN", seen)
                if not found_balance:
                    warn_once("warn:openrouter:shape-unknown", "[watch-warn] openrouter shape unknown")
                continue

            if provider == "gemini":
                accounts = block.get("accounts")
                if accounts is None:
                    units = [block]
                elif isinstance(accounts, list):
                    units = accounts
                else:
                    print("[watch-error] gemini accounts malformed")
                    return 1
            else:
                accounts = block.get("accounts")
                if not isinstance(accounts, list):
                    print(f"[watch-warn] {provider} accounts missing or non-list — skipping provider")
                    continue
                units = accounts

            for unit in units:
                if not isinstance(unit, dict):
                    print(f"[watch-warn] {provider} skipping malformed unit")
                    continue
                label = ((unit.get("label") or block.get("model") or "default")
                         if provider == "gemini" else (unit.get("label") or "<unlabeled>"))
                stale, age = is_stale(unit, block, now)
                if provider in ("claude", "codex", "gemini"):
                    meter, meter_name = unit.get("sevenDay"), "7d weekly"
                else:
                    meter, meter_name = included_total(unit), "included-total monthly"
                if not isinstance(meter, dict):
                    continue
                value, resets_at = meter.get("usedPercentage"), meter.get("resetsAt")
                tier = cycle_meter(provider, label, meter_name, value, resets_at, stale, rows, now,
                                   warn_pct, urgent_pct)
                if stale:
                    warn_once(f"stale:{provider}:{label}:{unit.get('capturedAt', block.get('capturedAt'))}",
                              f"[watch-warn] {provider}/{label} stale (age {age}s) — skipping")
                elif tier != "OK":
                    # A null reset cannot re-arm dedup across cycles, but real exhaustion still alerts.
                    message = (f"{provider} {label}: {meter_name} at {value:g}% ({tier}) — "
                               f"resets in {resets_in_human(resets_at, now)}")
                    emit(provider, label, meter_name, tier, resets_at, message)
        write_snapshot(snapshot_path, rows)
    except Exception as exc:
        print(f"[watch-error] watch {exc}")
        return 1
    return 1 if notify_failed else 0


def selftest():
    """Exercise provider filtering, deduplication, and snapshot safety without real state."""
    global notify
    original_notify = notify
    threshold_names = ("WARN_PCT", "URGENT_PCT", "OPENROUTER_WARN_USD")
    original_thresholds = {name: os.environ.get(name) for name in threshold_names}
    emitted = []

    def fake_notify(label, tier, message):
        emitted.append((label, tier, message))
        return True

    def expect(condition, message):
        if not condition:
            raise AssertionError(message)

    try:
        notify = fake_notify
        os.environ.update({"WARN_PCT": "90", "URGENT_PCT": "97", "OPENROUTER_WARN_USD": "5"})
        now = time.time()
        reset_one = now + 3600
        reset_two = now + 7200
        limits = {"limits": [
            {"provider": "claude", "accounts": [
                "malformed",
                {"label": "claude-seven-day", "capturedAt": now,
                 "sevenDay": {"usedPercentage": 91, "resetsAt": reset_one},
                 "fiveHour": {"usedPercentage": 99, "resetsAt": reset_one},
                 "windows": [{"id": "extra-5h", "usedPercentage": 99, "resetsAt": reset_one}]},
                {"label": "claude-stale", "capturedAt": now - 1000,
                 "sevenDay": {"usedPercentage": 99, "resetsAt": reset_one}},
            ]},
            {"provider": "cursor", "accounts": [
                {"label": "cursor-api-only", "capturedAt": now, "windows": [
                    {"id": "included-api", "usedPercentage": 99, "resetsAt": reset_one},
                    {"id": "usage-based", "usedPercentage": 99, "resetsAt": reset_one},
                ]},
                {"label": "cursor-monthly", "capturedAt": now, "windows": [
                    {"id": "included-total", "usedPercentage": 99, "resetsAt": reset_one},
                    {"id": "included-api", "usedPercentage": 99, "resetsAt": reset_one},
                    {"id": "usage-based", "usedPercentage": 99, "resetsAt": reset_one},
                ]},
            ]},
            {"provider": "gemini", "model": "gemini-block", "accounts": None,
             "capturedAt": now, "sevenDay": {"usedPercentage": 92, "resetsAt": reset_one}},
            {"provider": "gemini", "model": "gemini-fallback", "accounts": [
                {"label": "gemini-account", "capturedAt": now,
                 "sevenDay": {"usedPercentage": 99, "resetsAt": reset_one}},
            ]},
            {"provider": "openrouter", "model": "openrouter-stale", "capturedAt": now - 1000,
             "balance": "4.50"},
        ]}

        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            limits_path = root / "limits.json"
            state_dir = root / "state"
            snapshot_path = root / "meter-alerts.json"

            def run_fixture():
                limits_path.write_text(json.dumps(limits), encoding="utf-8")
                return watch(limits_path, state_dir, snapshot_path)

            expect(run_fixture() == 0, "initial fixture poll failed")
            first_emits = list(emitted)
            expect(("claude/claude-seven-day", "WARN") in [(label, tier) for label, tier, _ in emitted],
                   "claude 91% did not emit WARN")
            expect(("gemini/gemini-block", "WARN") in [(label, tier) for label, tier, _ in emitted],
                   "gemini block-level 92% did not emit WARN")
            expect(("gemini/gemini-account", "URGENT") in [(label, tier) for label, tier, _ in emitted],
                   "gemini accounts-list 99% did not emit URGENT")
            expect(("cursor/cursor-monthly", "URGENT") in [(label, tier) for label, tier, _ in emitted],
                   "cursor included-total 99% did not emit")
            expect(not any(label == "cursor/cursor-api-only" for label, _, _ in emitted),
                   "Cursor API-only windows emitted")

            rows = json.loads(snapshot_path.read_text(encoding="utf-8"))
            allowed_meters = {"7d weekly", "included-total monthly", "balance"}
            expect(snapshot_path.is_file() and all(row["meter"] in allowed_meters for row in rows),
                   "snapshot contains a non-weekly/non-included-total/non-balance meter")
            expect(any(row["account"] == "claude-stale" and row["tier"] == "STALE" and row["stale"]
                       for row in rows), "stale cycle row is not tier STALE")
            expect(any(row["provider"] == "openrouter" and row["tier"] == "STALE"
                       and row["balance"] == 4.5 for row in rows),
                   "stale OpenRouter balance row is not tier STALE")

            claude = limits["limits"][0]["accounts"][1]
            claude["sevenDay"]["usedPercentage"] = 98
            expect(run_fixture() == 0, "Claude urgent fixture poll failed")
            expect(("claude/claude-seven-day", "URGENT") in [(label, tier) for label, tier, _ in emitted],
                   "claude 98% did not emit URGENT")
            after_urgent = len(emitted)
            expect(run_fixture() == 0 and len(emitted) == after_urgent,
                   "same tier and reset re-emitted")
            claude["sevenDay"]["resetsAt"] = reset_two
            expect(run_fixture() == 0 and len(emitted) == after_urgent + 1,
                   "new reset did not re-arm alert")
            expect(len(first_emits) == 4, "unexpected initial emits from 5h or API windows")

            openrouter_limits = {"limits": [{
                "provider": "openrouter", "capturedAt": now,
                "accounts": [{"label": "re-arm", "capturedAt": now, "balance": "4.00"}],
            }]}

            def run_openrouter_fixture():
                limits_path.write_text(json.dumps(openrouter_limits), encoding="utf-8")
                return watch(limits_path, state_dir, snapshot_path)

            openrouter_emits = lambda: [event for event in emitted if event[0] == "openrouter/re-arm"]
            expect(run_openrouter_fixture() == 0 and len(openrouter_emits()) == 1,
                   "OpenRouter numeric string balance did not emit WARN")
            expect(openrouter_emits()[0][2] == "openrouter re-arm: balance $4.00 low (WARN)",
                   "OpenRouter WARN omitted its account label")
            openrouter_limits["limits"][0]["accounts"][0]["balance"] = 10
            expect(run_openrouter_fixture() == 0, "OpenRouter recovery fixture poll failed")
            openrouter_key = "openrouter:re-arm:balance:WARN"
            expect(openrouter_key not in seen_keys(state_dir / "alerted.seen"),
                   "OpenRouter recovery did not clear WARN key")
            openrouter_limits["limits"][0]["accounts"][0]["balance"] = 3
            expect(run_openrouter_fixture() == 0 and len(openrouter_emits()) == 2,
                   "OpenRouter later balance drop did not re-emit WARN")

            non_list_limits = {"limits": [{"provider": "claude", "accounts": "bad"}]}
            limits_path.write_text(json.dumps(non_list_limits), encoding="utf-8")
            non_list_emits = len(emitted)
            with io.StringIO() as output, contextlib.redirect_stdout(output):
                non_list_exit = watch(limits_path, root / "non-list-state", root / "non-list-snapshot.json")
                non_list_output = output.getvalue()
            expect(non_list_exit == 0, "non-list accounts fixture poll failed")
            expect("[watch-warn] claude accounts missing or non-list" in non_list_output,
                   "non-list accounts did not print provider warning")
            expect(len(emitted) == non_list_emits, "non-list accounts emitted an alert")
            non_list_rows = json.loads((root / "non-list-snapshot.json").read_text(encoding="utf-8"))
            expect(not non_list_rows, "non-list accounts provider contributed snapshot rows")

        expect(openrouter_balance({"balance": True}) is None, "boolean OpenRouter balance accepted")
        expect(openrouter_balance({"balance": "4.50"}) == 4.5, "string OpenRouter balance rejected")
        expect(openrouter_balance({"balance": float("nan")}) is None, "non-finite balance accepted")
    except AssertionError as exc:
        print(f"SELFTEST FAIL: {exc}")
        return 1
    finally:
        notify = original_notify
        for name, value in original_thresholds.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value
    print("SELFTEST PASS")
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limits", default=os.environ.get(
        "HEDDLE_LIMITS_PATH", "~/.heddle/usage/limits.json"), help="Path to Heddle limits.json")
    parser.add_argument("--selftest", action="store_true", help="Run isolated synthetic watcher checks")
    args = parser.parse_args()
    if args.selftest:
        return selftest()
    return watch(os.path.expanduser(args.limits))


if __name__ == "__main__":
    sys.exit(main())
