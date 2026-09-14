#!/usr/bin/env python3
"""One-pass desktop watcher for Claude five-hour headroom exhaustion."""
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


def default_state_dir():
    return pathlib.Path(os.path.expanduser(os.environ.get(
        "HEADROOM_STATE_DIR", "~/.claude/spinventory-fleet/headroom-watch")))


def default_snapshot_path():
    return pathlib.Path(os.path.expanduser(os.environ.get(
        "HEADROOM_SNAPSHOT", "~/.heddle/usage/headroom-alerts.json")))


def finite_number(value):
    if isinstance(value, bool):
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def settings():
    try:
        stale_secs = float(os.environ.get("HEADROOM_STALE_SECS", "900"))
        warn_pct = float(os.environ.get("HEADROOM_WARN_PCT", "80"))
        urgent_pct = float(os.environ.get("HEADROOM_URGENT_PCT", "92"))
        cooldown_secs = float(os.environ.get("HEADROOM_COOLDOWN_SECS", "1800"))
    except ValueError:
        raise ValueError("bad headroom threshold env") from None
    values = (stale_secs, warn_pct, urgent_pct, cooldown_secs)
    # Reject not just non-finite/negative but also out-of-range or inverted thresholds: an URGENT
    # below WARN would classify everything as URGENT, and a threshold above 100 silently disables
    # its tier. A misconfiguration must fail loudly, not skew alert severity.
    if (not all(math.isfinite(value) for value in values)
            or stale_secs < 0 or cooldown_secs < 0
            or not 0 <= warn_pct <= 100 or not 0 <= urgent_pct <= 100
            or warn_pct >= urgent_pct):
        raise ValueError("bad headroom threshold env "
                         "(need 0 <= WARN < URGENT <= 100, non-negative stale/cooldown)")
    return stale_secs, warn_pct, urgent_pct, cooldown_secs


def claude_block(data):
    """Select the Claude provider block. limits.json is a provider-tagged block list
    (claude/codex/gemini/...); the Claude block is NOT guaranteed to be first, and the other
    providers' accounts carry loggedIn=None / fiveHour=null, so a positional read would skip
    every Claude account when the order changes. Select by provider, never by index — matching
    account-meter-watch.sh and cursor-meter-watch.sh."""
    limits = data.get("limits")
    if not isinstance(limits, list) or not limits:
        raise ValueError("limits must be a non-empty list")
    block = next((b for b in limits
                  if isinstance(b, dict) and b.get("provider") == "claude"), None)
    if block is None:
        raise ValueError("no claude provider block in limits")
    return block


def tier_for(used_percentage, warn_pct, urgent_pct):
    if used_percentage >= urgent_pct:
        return "URGENT"
    if used_percentage >= warn_pct:
        return "WARN"
    return None


def resets_in_human(resets_at, now):
    numeric_resets_at = finite_number(resets_at)
    if numeric_resets_at is None:
        return "unknown"
    minutes = max(0, int((numeric_resets_at - now) // 60))
    hours, minutes = divmod(minutes, 60)
    return f"{hours}h" if hours else f"{minutes}m"


def read_last_notify(path):
    try:
        with path.open(encoding="utf-8") as source:
            raw = json.load(source)
    except FileNotFoundError:
        return {}
    except (OSError, ValueError, json.JSONDecodeError, TypeError):
        print(f"[watch-warn] state {path} unreadable — starting empty")
        return {}
    if not isinstance(raw, dict):
        print(f"[watch-warn] state {path} malformed — starting empty")
        return {}
    parsed = {}
    for account, entry in raw.items():
        if not isinstance(account, str) or not isinstance(entry, dict):
            continue
        last = finite_number(entry.get("last"))
        tier = entry.get("tier")
        if last is not None and tier in {"WARN", "URGENT"}:
            parsed[account] = {"last": last, "tier": tier}
    return parsed


def write_json_atomically(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent,
                                         prefix=f".{path.name}.", delete=False) as temp:
            temp_path = pathlib.Path(temp.name)
            json.dump(payload, temp, separators=(",", ":"), allow_nan=False)
            temp.write("\n")
            temp.flush()
            os.fsync(temp.fileno())
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
    except Exception:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)
        raise


def _osascript_notify(title, message):
    # osascript AppleScript double-quoted strings escape with \\ and \"; account labels + a fixed
    # template are the only inputs (never operator/user text), so this is the correct, injection-safe
    # form. (repr() would emit a PYTHON literal, whose escaping differs from AppleScript's.)
    msg = message.replace("\\", "\\\\").replace('"', '\\"')
    subj = title.replace("\\", "\\\\").replace('"', '\\"')
    subprocess.run(
        ["osascript", "-e", f'display notification "{msg}" with title "{subj}" sound name "Glass"'],
        check=True, timeout=10)


def notify(account, tier, message):
    try:
        _osascript_notify("5h headroom", message)
        return True
    except Exception as exc:
        print(f"[watch-error] notify {account}:{tier} {exc}")
        return False


def should_notify(previous, tier, now, cooldown_secs):
    if previous is None:
        return True
    if previous["tier"] == "WARN" and tier == "URGENT":
        return True
    return now - previous["last"] >= cooldown_secs


def watch(limits_path, state_dir=None, snapshot_path=None):
    state_dir = default_state_dir() if state_dir is None else pathlib.Path(state_dir)
    snapshot_path = default_snapshot_path() if snapshot_path is None else pathlib.Path(snapshot_path)
    try:
        with pathlib.Path(limits_path).open(encoding="utf-8") as source:
            data = json.load(source)
        block = claude_block(data)
        accounts = block.get("accounts")
    except Exception as exc:
        print(f"[watch-error] limits {limits_path} {exc}")
        return 1

    block_stale = block.get("stale") is True
    if not isinstance(accounts, list):
        print("[watch-warn] claude accounts missing/non-list — preserving prior snapshot")
        return 0

    try:
        stale_secs, warn_pct, urgent_pct, cooldown_secs = settings()
        state_dir.mkdir(parents=True, exist_ok=True)
        state_path = state_dir / "last-notify.json"
        last_notify = read_last_notify(state_path)
        real_now = time.time()
        actionable = {}
        rows = []
        seen_ids = set()
        fresh_ids = set()
        logged_in_count = 0
        for account in accounts:
            if not isinstance(account, dict):
                print("[watch-warn] skipping malformed account")
                continue
            # Identify by label like the sibling meter watchers (the mirror's canonical account key),
            # falling back to id. Consistent identity keeps the collector / pocket meter coherent
            # across producers and keys the cooldown state the same way every poll.
            account_id = account.get("label") or account.get("id")
            if not isinstance(account_id, str) or not account_id:
                print("[watch-warn] skipping account without label/id")
                continue
            if account.get("loggedIn") is not True:
                continue
            logged_in_count += 1
            seen_ids.add(account_id)
            captured_at = finite_number(account.get("capturedAt"))
            age = real_now - captured_at if captured_at is not None else stale_secs + 1
            # Skip on capturedAt age OR the mirror's explicit stale marker (account- or block-level).
            # The marker is authoritative post-HED-348; the age gate additionally covers a frozen-false
            # marker. Either way, stale data must never alarm.
            if age > stale_secs or account.get("stale") is True or block_stale:
                why = "flagged" if (account.get("stale") is True or block_stale) else f"{int(age)}s"
                print(f"[watch-warn] {account_id} stale ({why})")
                continue
            fresh_ids.add(account_id)
            five_hour = account.get("fiveHour")
            if not isinstance(five_hour, dict):
                continue
            used_percentage = finite_number(five_hour.get("usedPercentage"))
            if used_percentage is None:
                continue
            tier = tier_for(used_percentage, warn_pct, urgent_pct)
            if tier is None:
                continue
            resets_at = finite_number(five_hour.get("resetsAt"))
            actionable[account_id] = tier
            rows.append({"tier": tier, "provider": "claude", "account": account_id,
                         "meter": "fiveHour", "usedPercentage": used_percentage,
                         "resetsAt": resets_at,
                         "resetsInHuman": resets_in_human(resets_at, real_now)})

        # Frozen source: logged-in Claude accounts exist but NONE are fresh. Preserve the prior
        # snapshot + notify state instead of rewriting an empty snapshot — an empty rewrite refreshes
        # the snapshot mtime and makes the collector read it as a confirmed "no alerts", retracting
        # still-pending headroom events during a stale-data window. (A genuinely fresh poll with no
        # actionable account still writes [] below, the correct explicit clear.)
        if logged_in_count > 0 and not fresh_ids:
            print("[watch-warn] all logged-in claude accounts stale — preserving prior snapshot + state")
            return 0

        # Retain prior cooldown state for accounts still hot (actionable) or merely stale THIS poll
        # (seen this poll but not fresh) — a transient stale poll must not reset a cooldown and fire a
        # duplicate alert when the account returns hot. Prune it for accounts that freshly recovered
        # below threshold, and for accounts gone from the mirror entirely (so state cannot leak).
        next_state = {
            key: state for key, state in last_notify.items()
            if key in actionable or (key in seen_ids and key not in fresh_ids)
        }
        notify_failed = False
        for row in rows:
            account_id = row["account"]
            tier = row["tier"]
            previous = last_notify.get(account_id)
            if not should_notify(previous, tier, real_now, cooldown_secs):
                continue
            message = (f"⚠️ {account_id} 5h {row['usedPercentage']:.0f}% "
                       f"(resets {row['resetsInHuman']}) — rotate soon")
            if notify(account_id, tier, message):
                next_state[account_id] = {"tier": tier, "last": real_now}
                print(f"[watch-emit] account={account_id} tier={tier}")
            else:
                notify_failed = True

        write_json_atomically(state_path, next_state)
        write_json_atomically(snapshot_path, rows)
    except Exception as exc:
        print(f"[watch-error] watch {exc}")
        return 1
    return 1 if notify_failed else 0


def selftest():
    """Exercise provider selection, label identity, five-hour filtering, explicit-stale markers,
    cooldowns across stale polls, frozen-source preservation, and atomic outputs — without osascript."""
    global notify
    original_notify = notify
    environment_names = ("HEADROOM_STALE_SECS", "HEADROOM_WARN_PCT",
                         "HEADROOM_URGENT_PCT", "HEADROOM_COOLDOWN_SECS")
    original_environment = {name: os.environ.get(name) for name in environment_names}
    emitted = []

    def fake_notify(account, tier, message):
        emitted.append((account, tier, message))
        return True

    def expect(condition, message):
        if not condition:
            raise AssertionError(message)

    try:
        notify = fake_notify
        os.environ.update({"HEADROOM_STALE_SECS": "900", "HEADROOM_WARN_PCT": "80",
                           "HEADROOM_URGENT_PCT": "92", "HEADROOM_COOLDOWN_SECS": "1800"})
        # Inverted / out-of-range thresholds must be rejected loudly.
        for bad in ({"HEADROOM_WARN_PCT": "95", "HEADROOM_URGENT_PCT": "90"},
                    {"HEADROOM_URGENT_PCT": "150"}):
            os.environ.update({"HEADROOM_WARN_PCT": "80", "HEADROOM_URGENT_PCT": "92"})
            os.environ.update(bad)
            try:
                settings()
                expect(False, f"settings accepted a bad threshold config: {bad}")
            except ValueError:
                pass
        os.environ.update({"HEADROOM_WARN_PCT": "80", "HEADROOM_URGENT_PCT": "92"})

        now = time.time()
        # Real schema: provider-tagged block list, Claude NOT first, other providers loggedIn=None /
        # fiveHour=null. Claude accounts carry both id and label; identity must resolve to label.
        # "flagged" has a fresh capturedAt but stale:true — the explicit marker must skip it.
        def fresh_fixture():
            return {"limits": [
                {"provider": "codex", "accounts": [
                    {"id": "codex-id", "label": "codex-a", "loggedIn": None, "capturedAt": now,
                     "fiveHour": {"usedPercentage": None, "resetsAt": None}}]},
                {"provider": "claude", "stale": False, "accounts": [
                    {"id": "urgent-id", "label": "urgent", "loggedIn": True, "capturedAt": now,
                     "fiveHour": {"usedPercentage": 95.0, "resetsAt": now + 2580}},
                    {"id": "low-id", "label": "low", "loggedIn": True, "capturedAt": now,
                     "fiveHour": {"usedPercentage": 50.0, "resetsAt": now + 2580}},
                    {"id": "stale-id", "label": "stale", "loggedIn": True, "capturedAt": now - 901,
                     "fiveHour": {"usedPercentage": 99.0, "resetsAt": now + 2580}},
                    {"id": "flagged-id", "label": "flagged", "loggedIn": True, "capturedAt": now,
                     "stale": True, "fiveHour": {"usedPercentage": 99.0, "resetsAt": now + 2580}},
                    {"id": "out-id", "label": "logged-out", "loggedIn": False, "capturedAt": now,
                     "fiveHour": {"usedPercentage": 99.0, "resetsAt": now + 2580}},
                ]},
            ]}
        limits = fresh_fixture()
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            limits_path = root / "limits.json"
            state_dir = root / "state"
            snapshot_path = root / "headroom-alerts.json"

            def run_fixture(capture=False):
                limits_path.write_text(json.dumps(limits), encoding="utf-8")
                if not capture:
                    return watch(limits_path, state_dir, snapshot_path), ""
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    result = watch(limits_path, state_dir, snapshot_path)
                return result, output.getvalue()

            result, output = run_fixture(capture=True)
            expect(result == 0, "fresh urgent fixture poll failed")
            expect("[watch-warn] stale stale" in output, "age-stale account did not warn-skip")
            expect("[watch-warn] flagged stale (flagged)" in output,
                   "explicit stale:true (fresh capturedAt) account did not warn-skip")
            expect(len(emitted) == 1 and emitted[0][0:2] == ("urgent", "URGENT"),
                   "fresh 95% account (label identity, non-first claude block) did not notify urgently")
            expect("⚠️ urgent 5h 95% (resets 42m) — rotate soon" == emitted[0][2],
                   "urgent notification message differs from contract")
            rows = json.loads(snapshot_path.read_text(encoding="utf-8"))
            expect(rows == [{"tier": "URGENT", "provider": "claude", "account": "urgent",
                             "meter": "fiveHour", "usedPercentage": 95.0,
                             "resetsAt": now + 2580, "resetsInHuman": "42m"}],
                   "snapshot row missing label-keyed urgent account or its resetsInHuman")

            # Escalation + cooldown, single claude account.
            def set_claude(accounts):
                limits["limits"][1]["accounts"] = accounts
            set_claude([{"id": "rot-id", "label": "rotation", "loggedIn": True,
                         "capturedAt": time.time(),
                         "fiveHour": {"usedPercentage": 85.0, "resetsAt": time.time() + 3600}}])
            expect(run_fixture()[0] == 0 and emitted[-1][0:2] == ("rotation", "WARN"),
                   "initial WARN did not notify")
            limits["limits"][1]["accounts"][0]["fiveHour"]["usedPercentage"] = 95.0
            expect(run_fixture()[0] == 0 and emitted[-1][0:2] == ("rotation", "URGENT"),
                   "WARN to URGENT did not re-notify")
            count_after_escalation = len(emitted)
            expect(run_fixture()[0] == 0 and len(emitted) == count_after_escalation,
                   "same tier re-notified inside cooldown")

            # Cooldown survives a transient stale poll: rotation is URGENT (state held). Make it
            # briefly stale WHILE a second fresh account keeps the poll from being all-stale, then
            # return it hot inside the cooldown — it must NOT re-alert (state retained across stale).
            set_claude([
                {"id": "rot-id", "label": "rotation", "loggedIn": True,
                 "capturedAt": time.time() - 5000,
                 "fiveHour": {"usedPercentage": 95.0, "resetsAt": time.time() + 3600}},
                {"id": "keep-id", "label": "keepalive", "loggedIn": True, "capturedAt": time.time(),
                 "fiveHour": {"usedPercentage": 10.0, "resetsAt": time.time() + 3600}}])
            count_before_stale = len(emitted)
            expect(run_fixture()[0] == 0 and len(emitted) == count_before_stale,
                   "transient-stale poll unexpectedly notified")
            limits["limits"][1]["accounts"][0]["capturedAt"] = time.time()
            expect(run_fixture()[0] == 0 and len(emitted) == count_before_stale,
                   "cooldown state was lost across a stale poll -> duplicate alert on recovery")

            # Genuine recovery: rotation drops below threshold on a fresh poll -> state pruned, so a
            # later re-cross alerts again.
            set_claude([{"id": "rot-id", "label": "rotation", "loggedIn": True,
                         "capturedAt": time.time(),
                         "fiveHour": {"usedPercentage": 50.0, "resetsAt": time.time() + 3600}}])
            expect(run_fixture()[0] == 0, "recovery poll failed")
            expect(json.loads(snapshot_path.read_text(encoding="utf-8")) == [],
                   "snapshot did not clear after a fresh below-threshold poll")
            expect(json.loads((state_dir / "last-notify.json").read_text(encoding="utf-8")) == {},
                   "recovered account's cooldown state was not pruned")

            # Frozen source: seed an actionable snapshot, then make the only account stale -> the prior
            # snapshot + state must be preserved (not retracted to []).
            set_claude([{"id": "rot-id", "label": "rotation", "loggedIn": True,
                         "capturedAt": time.time(),
                         "fiveHour": {"usedPercentage": 95.0, "resetsAt": time.time() + 3600}}])
            expect(run_fixture()[0] == 0, "re-seed actionable snapshot failed")
            seeded_rows = json.loads(snapshot_path.read_text(encoding="utf-8"))
            expect(seeded_rows and seeded_rows[0]["account"] == "rotation", "seed snapshot not written")
            limits["limits"][1]["accounts"][0]["capturedAt"] = time.time() - 5000
            result, output = run_fixture(capture=True)
            expect(result == 0 and "preserving prior snapshot" in output,
                   "all-stale poll did not preserve + warn")
            expect(json.loads(snapshot_path.read_text(encoding="utf-8")) == seeded_rows,
                   "frozen-source poll retracted the prior snapshot to empty")

            # Atomic writer: same-directory temp replace, valid JSON, no leftover.
            replace_calls = []
            original_replace = os.replace

            def tracking_replace(source, destination):
                replace_calls.append((pathlib.Path(source), pathlib.Path(destination)))
                return original_replace(source, destination)

            try:
                os.replace = tracking_replace
                write_json_atomically(snapshot_path, [])
            finally:
                os.replace = original_replace
            expect(len(replace_calls) == 1 and replace_calls[0][1] == snapshot_path
                   and replace_calls[0][0].parent == snapshot_path.parent,
                   "snapshot writer did not atomically replace a same-directory temp file")
            expect(json.loads(snapshot_path.read_text(encoding="utf-8")) == [],
                   "atomic snapshot write was not valid JSON")
            expect(not list(root.glob(f".{snapshot_path.name}.*")),
                   "atomic snapshot writer left a temporary file")
    except AssertionError as exc:
        print(f"SELFTEST FAIL: {exc}")
        return 1
    finally:
        notify = original_notify
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
        "HEDDLE_LIMITS_PATH", "~/.heddle/usage/limits.json"), help="Path to Heddle limits.json")
    parser.add_argument("--selftest", action="store_true", help="Run isolated synthetic watcher checks")
    args = parser.parse_args()
    if args.selftest:
        return selftest()
    return watch(os.path.expanduser(args.limits))


if __name__ == "__main__":
    raise SystemExit(main())
