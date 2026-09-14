#!/usr/bin/env python3
"""One-pass desktop watcher for durable fleet attention items."""
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


STATE_DIR = pathlib.Path(os.path.expanduser(os.environ.get(
    "ATTENTION_WATCH_STATE_DIR", "~/.claude/spinventory-fleet/attention-watch")))


def spool_path():
    return pathlib.Path(os.path.expanduser(os.environ.get(
        "ATTENTION_SPOOL", "~/.heddle/attention/pending.json")))


def read_last_notify(path):
    try:
        values = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(values, dict):
        return {}
    return {identifier: notified_at for identifier, notified_at in values.items()
            if isinstance(identifier, str) and isinstance(notified_at, (int, float))}


def write_last_notify(path, values):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent, text=True)
    temp_path = pathlib.Path(temp_name)
    try:
        with os.fdopen(fd, "w") as state:
            json.dump(values, state, ensure_ascii=False, indent=2)
            state.write("\n")
            state.flush()
            os.fsync(state.fileno())
        os.replace(temp_path, path)
        try:
            directory_fd = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        except OSError:
            pass
    finally:
        if temp_path.exists():
            temp_path.unlink()


def read_attention_queue(path):
    try:
        entries = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        if path.exists():
            print(f"[watch-warn] spool unreadable: {path}")
            return None
        return []
    if not isinstance(entries, list):
        print(f"[watch-warn] spool unreadable: {path}")
        return None
    return [entry for entry in entries if isinstance(entry, dict)]


def _osascript_notify(title, message):
    # AppleScript strings: escape backslash first, then double-quote, so a value containing " or \
    # cannot break out of the literal. Reliable delivery on stock macOS, but respects Do Not
    # Disturb and is NOT clickable (osascript display-notification has no click action).
    msg = message.replace("\\", "\\\\").replace('"', '\\"')
    subj = title.replace("\\", "\\\\").replace('"', '\\"')
    subprocess.run(
        ["osascript", "-e", f'display notification "{msg}" with title "{subj}" sound name "Glass"'],
        check=True, timeout=10)


def notify(entry):
    identifier = entry.get("id", "<missing>")
    try:
        _osascript_notify(f"Attention · {entry.get('agent', '<missing>')}",
                          f"{entry.get('kind', '<missing>')}: {entry.get('text', '')}")
        return True
    except Exception as exc:
        print(f"[watch-error] notify {identifier} {exc}")
        return False


def watch(spool=None, state_dir=None, now=None):
    entries = read_attention_queue(spool or spool_path())
    if entries is None:
        return 0
    state_dir = pathlib.Path(state_dir or STATE_DIR)
    last_notify_path = state_dir / "last-notify.json"
    last_notify = read_last_notify(last_notify_path)
    clock = time.time() if now is None else now
    unacked_ids = {entry["id"] for entry in entries if entry.get("acked_at") is None
                   and isinstance(entry.get("id"), str) and entry["id"]}
    last_notify = {identifier: notified_at for identifier, notified_at in last_notify.items()
                   if identifier in unacked_ids}
    notify_failed = False
    for entry in entries:
        if entry.get("acked_at") is not None:
            continue
        identifier = entry.get("id")
        if not isinstance(identifier, str) or not identifier:
            continue
        previous_notify = last_notify.get(identifier)
        if previous_notify is not None and clock - previous_notify < 1800:
            continue
        if notify(entry):
            last_notify[identifier] = clock
            print(f"[watch-emit] id={identifier} kind={entry.get('kind', '<missing>')}")
        else:
            notify_failed = True
    write_last_notify(last_notify_path, last_notify)
    return 1 if notify_failed else 0


def selftest():
    global _osascript_notify
    original_notify = _osascript_notify
    emitted = []

    def fake_notify(title, message):
        emitted.append((title, message))

    def expect(condition, message):
        if not condition:
            raise AssertionError(message)

    try:
        _osascript_notify = fake_notify
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            spool = root / "pending.json"
            state_dir = root / "state"
            spool.write_text(json.dumps([
                {"id": "A-1", "ts": "2026-01-01T00:00:00+00:00", "agent": "A",
                 "kind": "attention", "text": "unacked", "acked_at": None},
                {"id": "B-1", "ts": "2026-01-01T00:00:00+00:00", "agent": "B",
                 "kind": "needs-clear", "text": "acked", "acked_at": "2026-01-01T00:01:00+00:00"},
            ]), encoding="utf-8")
            now = 1_800_000
            expect(watch(spool, state_dir, now) == 0, "initial poll failed")
            expect(len(emitted) == 1 and emitted[0][1] == "attention: unacked",
                   "unacked item did not emit exactly once")
            expect(watch(spool, state_dir, now) == 0 and len(emitted) == 1,
                   "same bucket re-emitted")
            expect(watch(spool, state_dir, now + 1800) == 0 and len(emitted) == 2,
                   "30-minute re-notify did not emit")
            last_notify_path = state_dir / "last-notify.json"
            last_notify = json.loads(last_notify_path.read_text(encoding="utf-8"))
            expect(set(last_notify) == {"A-1"}, "state map was not pruned to the unacked id")
            spool.write_text(json.dumps([
                {"id": "A-1", "ts": "2026-01-01T00:00:00+00:00", "agent": "A",
                 "kind": "attention", "text": "unacked", "acked_at": "2026-01-01T00:02:00+00:00"},
                {"id": "B-1", "ts": "2026-01-01T00:00:00+00:00", "agent": "B",
                 "kind": "needs-clear", "text": "acked", "acked_at": "2026-01-01T00:01:00+00:00"},
            ]), encoding="utf-8")
            expect(watch(spool, state_dir, now + 3600) == 0 and len(emitted) == 2,
                   "acked item emitted")
            expect(json.loads(last_notify_path.read_text(encoding="utf-8")) == {},
                   "acked item was not pruned from state")
            spool.write_text("{not valid json", encoding="utf-8")
            with contextlib.redirect_stdout(io.StringIO()) as output:
                expect(watch(spool, state_dir, now + 5400) == 0,
                       "unreadable spool did not return cleanly")
            expect("[watch-warn] spool unreadable" in output.getvalue() and len(emitted) == 2,
                   "unreadable spool did not warn without emitting")
    except AssertionError as exc:
        print(f"SELFTEST FAIL: {exc}")
        return 1
    finally:
        _osascript_notify = original_notify
    print("SELFTEST PASS")
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--selftest", action="store_true", help="Run isolated watcher checks")
    args = parser.parse_args(argv)
    return selftest() if args.selftest else watch()


if __name__ == "__main__":
    sys.exit(main())
