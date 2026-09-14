#!/usr/bin/env python3
"""Durable attention queue CLI for the Spinventory fleet."""
import argparse
import contextlib
import io
import json
import os
import pathlib
import sys
import tempfile
import time
import uuid
from datetime import datetime, timezone


KINDS = ("needs-clear", "needs-blessing", "attention")


def spool_path():
    return pathlib.Path(os.path.expanduser(os.environ.get(
        "ATTENTION_SPOOL", "~/.heddle/attention/pending.json")))


def read_attention_queue(path):
    try:
        entries = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    return [entry for entry in entries if isinstance(entry, dict)] if isinstance(entries, list) else []


def write_attention_queue(path, entries):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent, text=True)
    temp_path = pathlib.Path(temp_name)
    try:
        with os.fdopen(fd, "w") as output:
            json.dump(entries, output, ensure_ascii=False, indent=2)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
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


def read_attention_queue_for_update(path):
    """Read a spool safely before a mutation, preserving unreadable data."""
    if not path.exists():
        return []
    try:
        entries = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SystemExit(f"attention.sh: refusing to overwrite unreadable spool {path}") from exc
    if not isinstance(entries, list):
        raise SystemExit(f"attention.sh: refusing to overwrite unreadable spool {path}")
    return [entry for entry in entries if isinstance(entry, dict)]


def locked_update(path, update):
    import fcntl

    path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = path.with_suffix(path.suffix + ".lock")
    with lock_path.open("a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            entries, result = update(read_attention_queue_for_update(path))
            write_attention_queue(path, entries)
            return result
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def one_line(text):
    return " ".join(text.split())


def add_entry(agent, kind, text, path=None):
    if kind not in KINDS:
        raise ValueError(f"invalid kind {kind!r}; expected one of: {', '.join(KINDS)}")
    path = path or spool_path()
    entry = {"id": f"{agent}-{int(time.time())}-{uuid.uuid4().hex[:8]}", "ts": utc_now(),
             "agent": agent, "kind": kind, "text": one_line(text), "acked_at": None,
             "acked_by": None}

    def append(entries):
        entries.append(entry)
        return entries, entry["id"]

    return locked_update(path, append)


def ack_entry(identifier, by=None, path=None):
    path = path or spool_path()
    acked_at = utc_now()

    def acknowledge(entries):
        for entry in entries:
            if entry.get("id") == identifier:
                entry["acked_at"] = acked_at
                if by is not None:
                    entry["acked_by"] = by
                return entries, True
        return entries, False

    return locked_update(path, acknowledge)


def timestamp(entry):
    try:
        value = datetime.fromisoformat(str(entry.get("ts", "")).replace("Z", "+00:00"))
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    except ValueError:
        return datetime.min.replace(tzinfo=timezone.utc)


def age(entry, now):
    seconds = max(0, int((now - timestamp(entry)).total_seconds()))
    days, seconds = divmod(seconds, 86400)
    hours, seconds = divmod(seconds, 3600)
    minutes = seconds // 60
    if days:
        return f"{days}d {hours}h"
    if hours:
        return f"{hours}h {minutes}m"
    return f"{minutes}m"


def show_entries(include_all, path=None):
    entries = read_attention_queue(path or spool_path())
    if not include_all:
        entries = [entry for entry in entries if entry.get("acked_at") is None]
    for entry in sorted(entries, key=timestamp):
        line = (f"{entry.get('id', '<missing>')} · {age(entry, datetime.now(timezone.utc))} · "
                f"{entry.get('agent', '<missing>')} · {entry.get('kind', '<missing>')} · "
                f"{entry.get('text', '')}")
        if include_all and entry.get("acked_at") is not None:
            line += f" · acked_at={entry.get('acked_at')}"
        print(line)


def build_parser():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    add = commands.add_parser("add")
    add.add_argument("--agent", required=True)
    add.add_argument("--kind", required=True, choices=KINDS)
    add.add_argument("--text", required=True)
    listing = commands.add_parser("list")
    listing.add_argument("--all", action="store_true", dest="include_all")
    ack = commands.add_parser("ack")
    ack.add_argument("id")
    ack.add_argument("--by")
    parser.add_argument("--selftest", action="store_true")
    return parser


def selftest():
    original_spool = os.environ.get("ATTENTION_SPOOL")

    def expect(condition, message):
        if not condition:
            raise AssertionError(message)

    try:
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "pending.json"
            os.environ["ATTENTION_SPOOL"] = str(path)
            first = add_entry("A", "needs-clear", "clear this")
            second = add_entry("A", "needs-blessing", "bless this")
            expect(first != second and first.startswith("A-") and second.startswith("A-"),
                   "same-agent entries did not receive distinct readable ids")
            entries = read_attention_queue(path)
            expect(len([entry for entry in entries if entry.get("acked_at") is None]) == 2,
                   "two unacked entries were not stored")
            expect(ack_entry(first, by="maya", path=path), "acknowledging the first entry failed")
            entries = read_attention_queue(path)
            expect(len([entry for entry in entries if entry.get("acked_at") is None]) == 1,
                   "ack did not leave exactly one unacked entry")
            expect(next(entry for entry in entries if entry["id"] == first)["acked_at"] is not None,
                   "ack did not record acked_at")
            expect(next(entry for entry in entries if entry["id"] == first)["acked_by"] == "maya",
                   "ack did not record acked_by")
            with contextlib.redirect_stdout(io.StringIO()) as output:
                show_entries(True, path)
            expect(len(output.getvalue().splitlines()) == 2, "list --all did not show both entries")
            path.write_text("{not valid json", encoding="utf-8")
            for operation in (
                lambda: add_entry("C", "attention", "must not overwrite", path),
                lambda: ack_entry(first, path=path),
            ):
                try:
                    operation()
                except SystemExit as exc:
                    expect("refusing to overwrite unreadable spool" in str(exc),
                           "corrupt spool did not fail clearly")
                else:
                    raise AssertionError("corrupt spool was accepted for update")
                expect(path.read_text(encoding="utf-8") == "{not valid json",
                       "corrupt spool was overwritten")
            with contextlib.redirect_stderr(io.StringIO()):
                try:
                    main(["add", "--agent", "C", "--kind", "invalid", "--text", "no"])
                except SystemExit as exc:
                    expect(exc.code == 2, "invalid kind did not exit 2")
                else:
                    raise AssertionError("invalid kind did not exit")
    except AssertionError as exc:
        print(f"SELFTEST FAIL: {exc}")
        return 1
    finally:
        if original_spool is None:
            os.environ.pop("ATTENTION_SPOOL", None)
        else:
            os.environ["ATTENTION_SPOOL"] = original_spool
    print("SELFTEST PASS")
    return 0


def main(argv=None):
    parser = build_parser()
    if (sys.argv[1:] if argv is None else argv) == ["--selftest"]:
        return selftest()
    args = parser.parse_args(argv)
    if args.selftest:
        return selftest()
    if args.command == "add":
        print(add_entry(args.agent, args.kind, args.text))
    elif args.command == "list":
        show_entries(args.include_all)
    elif args.command == "ack":
        if not ack_entry(args.id, by=args.by):
            print(f"attention.sh: id not found: {args.id}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
