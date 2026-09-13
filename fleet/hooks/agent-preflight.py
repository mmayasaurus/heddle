#!/usr/bin/env python3
"""Fail-open, local-only SessionStart self-test for fleet agent sessions."""
from __future__ import annotations

from dataclasses import dataclass
import errno
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import time
from typing import Callable, Mapping


@dataclass(frozen=True)
class ProbeResult:
    name: str
    status: str  # OK, FAIL, or SKIP (unknown is deliberately rendered as SKIP)
    detail: str = ""
    remediation: str = ""


def _skip(name: str, detail: str = "unknown") -> ProbeResult:
    return ProbeResult(name, "SKIP", detail)


def probe_brain(env: Mapping[str, str]) -> ProbeResult:
    """Check that the selected Claude config has a non-empty global brain."""
    try:
        ccd = env.get("CLAUDE_CONFIG_DIR")
        config_dir = os.path.expanduser(ccd) if ccd else os.path.expanduser("~/.claude")
        path = os.path.join(config_dir, "CLAUDE.md")
        if os.path.isfile(path) and os.path.getsize(path) > 0:
            return ProbeResult("brain", "OK")
        return ProbeResult(
            "brain", "FAIL", path,
            "global brain CLAUDE.md missing at " + path
            + " — this session has no global instructions; check CLAUDE_CONFIG_DIR / account provisioning.",
        )
    except Exception:
        return _skip("brain")


def probe_memtrace_reachable(port: int = 50051) -> ProbeResult:
    """Check only the local memcore listener; never contact a network service."""
    try:
        connection = socket.create_connection(("127.0.0.1", port), timeout=0.5)
        try:
            close = getattr(connection, "close", None)
            if close:
                close()
        except Exception:
            pass
        return ProbeResult("memtrace", "OK")
    except (ConnectionRefusedError, TimeoutError):
        return ProbeResult(
            "memtrace", "FAIL", "127.0.0.1:%s" % port,
            f"memtrace memcore-server not reachable on 127.0.0.1:{port}"
            " — code discovery will fall back to grep; restart the memtrace server.",
        )
    except OSError as exc:
        # Permission/sandbox errors do not prove the listener is absent.
        if exc.errno not in {errno.ECONNREFUSED, errno.ETIMEDOUT}:
            return _skip("memtrace")
        return ProbeResult(
            "memtrace", "FAIL", "127.0.0.1:%s" % port,
            f"memtrace memcore-server not reachable on 127.0.0.1:{port}"
            " — code discovery will fall back to grep; restart the memtrace server.",
        )
    except Exception:
        return _skip("memtrace")


def _git(canon: str, arguments: list[str]) -> str | None:
    """Run a bounded local git command; inability to run git is unknown."""
    try:
        completed = subprocess.run(
            ["git", "-C", canon, *arguments],
            capture_output=True,
            text=True,
            timeout=1,
        )
        if completed.returncode != 0:
            return None
        return completed.stdout.strip() or None
    except Exception:
        return None


def probe_memtrace_fresh(env: Mapping[str, str]) -> ProbeResult:
    """Compare the local origin/main ref with HED-233's indexed-commit marker."""
    try:
        canon = env.get("HEDDLE_CANON", "/Users/mayatobi/Developer/heddle")
        marker = env.get("HEDDLE_MEMTRACE_MARKER", os.path.join(canon, ".memtrace-heddle-indexed-commit"))
        origin = _git(canon, ["rev-parse", "origin/main"])
        if not origin:
            return _skip("fresh", "local origin/main unavailable")

        # HED-233: read first line only, hex-validate before interpolation, then
        # canonicalize so abbreviated markers compare with the full origin SHA.
        raw = ""
        try:
            with open(marker, "r", errors="replace") as handle:
                raw = handle.readline().strip()
        except Exception:
            raw = ""
        if not raw or not re.fullmatch(r"[0-9a-fA-F]{7,40}", raw):
            return ProbeResult(
                "fresh", "FAIL", "unknown last-indexed commit",
                # HED-234 protocol #2: self-actioning — any agent seeing this fixes it on sight.
                "heddle memtrace graph freshness UNKNOWN (no valid last-indexed marker, as of last fetch)"
                " — FIX-ON-SIGHT (any agent, do it now — idempotent, no ticket): fast-forward "
                "(git -C " + canon + " merge --ff-only origin/main), then MCP index_directory(path=" + canon
                + ", repo_id=heddle, incremental=true, branch=main), then write HEAD to the marker."
                " Full procedure: docs/MEMTRACE-FRESHNESS.md.",
            )
        indexed = _git(canon, ["rev-parse", "--verify", "--quiet", raw + "^{commit}"])
        # HED-233 marker semantics plus fail-open: a hex-valid marker which
        # cannot be verified may be blocked by a transient git/index failure.
        if not indexed:
            return _skip("fresh", "last-indexed marker could not be verified")
        if origin == indexed:
            return ProbeResult("fresh", "OK", "as of last fetch")

        behind = _git(canon, ["rev-list", "--count", indexed + "..origin/main"]) or "?"
        return ProbeResult(
            "fresh", "FAIL", f"{behind} commits behind origin/main",
            # HED-234 protocol #2: self-actioning — any agent seeing this fixes it on sight.
            "heddle memtrace graph STALE (" + str(behind)
            + " commits behind origin/main, as of last fetch) — FIX-ON-SIGHT (any agent, do it now"
            " — idempotent, no ticket): fast-forward (git -C " + canon
            + " merge --ff-only origin/main), then MCP index_directory(path="
            + canon + ", repo_id=heddle, incremental=true, branch=main), then write HEAD to the marker."
            " Full procedure: docs/MEMTRACE-FRESHNESS.md.",
        )
    except Exception:
        return _skip("fresh")


# Faithful port of heddle src/comms/channel-loaded-probe.ts.
def looks_like_claude(argv: str) -> bool:
    return bool(re.match(r"(?:\S*/)?claude(?:\.exe)?(?:\s|$)", argv.lstrip()))


def read_parent_argv(ppid: int) -> str | None:
    """Use /proc where available, then macOS's ps fallback (the live path)."""
    try:
        with open(f"/proc/{ppid}/cmdline", "r", errors="replace") as handle:
            return handle.read().replace("\0", " ")
    except Exception:
        try:
            completed = subprocess.run(
                ["/bin/ps", "-ww", "-o", "command=", "-p", str(ppid)],
                capture_output=True,
                text=True,
                timeout=1,
            )
            return completed.stdout if completed.returncode == 0 else None
        except Exception:
            return None


def channel_loaded_from_parent_argv(
    ppid: int | float,
    read_argv: Callable[[int], str | None] = read_parent_argv,
) -> bool | None:
    """Return TS-equivalent True / False / None for the channel-load CLI flag."""
    if isinstance(ppid, bool) or not isinstance(ppid, (int, float)) \
            or not float(ppid).is_integer() or ppid <= 0:
        return None
    ppid = int(ppid)
    try:
        argv = read_argv(ppid)
    except Exception:
        return None
    if not argv or not argv.strip() or not looks_like_claude(argv):
        return None
    flag = re.compile(
        r"(?:^|\s)--dangerously-load-development-channels(?:=(\S+)|\s+(\S+))?"
    )
    for match in flag.finditer(argv):
        value = match.group(1) or match.group(2)
        if not value or value.startswith("--"):
            continue
        # Matches V's TS probe exactly; comma-separated values are a v2 there.
        if re.search(r"(^|:)heddle-comms($|@)", value):
            return True
    return False


def _parent_pid(pid: int) -> int | None:
    try:
        completed = subprocess.run(
            ["/bin/ps", "-o", "ppid=", "-p", str(pid)],
            capture_output=True,
            text=True,
            timeout=1,
        )
        if completed.returncode != 0:
            return None
        value = completed.stdout.strip()
        return int(value) if value.isdigit() and int(value) > 0 else None
    except Exception:
        return None


def find_claude_parent(read_argv: Callable[[int], str | None] = read_parent_argv) -> int | None:
    """Bounded wrapper-aware walk from this hook to its Claude parent."""
    try:
        pid = os.getppid()
        for _ in range(4):
            try:
                argv = read_argv(pid)
            except Exception:
                argv = None
            if argv and looks_like_claude(argv):
                return pid
            parent = _parent_pid(pid)
            if not parent or parent == pid:
                return None
            pid = parent
    except Exception:
        return None
    return None


def _mcp_config_value(argv: str) -> str | None:
    """Extract just --mcp-config's value, excluding later -p/--print prompts."""
    try:
        match = re.search(
            r"(?:^|\s)--mcp-config(?:=|\s+)(.+?)(?=\s(?:--\S+|-p)(?:\s|$)|$)", argv
        )
        return match.group(1).strip() if match else None
    except Exception:
        return None


def push_intended(argv: str | None, env: Mapping[str, str]) -> bool:
    """Push-only discriminator from resume-sessions-v2.sh, never a broad argv scan."""
    try:
        if env.get("FLEET_COMMS") == "off" or not argv:
            return False
        value = _mcp_config_value(argv)
        if not value:
            return False
        if value.lstrip().startswith("{"):
            source = value
        else:
            # HED-241 F4: --mcp-config can point at a file. Bound the local
            # read; any unreadable/ambiguous value is simply not push intent.
            try:
                with open(value.strip("'\""), "r", errors="replace") as handle:
                    source = handle.read(65536)
            except Exception:
                return False
        return bool(re.search(r"(?<![A-Za-z0-9_])HEDDLE_COMMS_PUSH(?![A-Za-z0-9_])", source))
    except Exception:
        return False


def probe_comms(
    env: Mapping[str, str],
    *,
    comms_argv: str | None = None,
    read_argv: Callable[[int], str | None] = read_parent_argv,
) -> ProbeResult:
    try:
        if comms_argv is None:
            ppid = find_claude_parent(read_argv)
            if not ppid:
                return _skip("comms", "Claude parent unknown")
            try:
                comms_argv = read_argv(ppid)
            except Exception:
                comms_argv = None
            loaded = channel_loaded_from_parent_argv(ppid, read_argv)
        else:
            loaded = channel_loaded_from_parent_argv(1, lambda _pid: comms_argv)
        intended = push_intended(comms_argv, env)
        if loaded is True:
            return ProbeResult("comms", "OK")
        if loaded is False and intended:
            return ProbeResult(
                "comms", "FAIL", "push intended",
                "comms channel NOT loaded but push was intended — this session is DEAF to "
                "<channel> events; relaunch with `--dangerously-load-development-channels "
                "server:heddle-comms`.",
            )
        if loaded is False:
            return _skip("comms", "pull, off, or not configured")
        return _skip("comms", "channel state unknown")
    except Exception:
        return _skip("comms")


def probe_account(env: Mapping[str, str], home: str | None = None) -> ProbeResult:
    """Mirror remind-owned-prs.py._active_claude_cap account resolution."""
    try:
        home = home or os.path.expanduser("~")
        default_dir = os.path.realpath(os.path.join(home, ".claude"))
        ccd = env.get("CLAUDE_CONFIG_DIR")
        want = os.path.realpath(os.path.expanduser(ccd)) if ccd else default_dir
        registry = os.path.join(home, ".heddle", "accounts.json")
        if not os.path.exists(registry):
            return ProbeResult(
                "account", "FAIL", "registry missing",
                "no account registry (~/.heddle/accounts.json)",
            )
        with open(registry, "r") as handle:
            accounts = json.load(handle).get("claude") or []
        for account in accounts:
            config_dir = account.get("configDir")
            account_dir = default_dir if config_dir is None else os.path.realpath(os.path.expanduser(config_dir))
            if account_dir == want and account.get("id"):
                return ProbeResult("account", "OK", str(account["id"]))
        return ProbeResult(
            "account", "FAIL", os.path.basename(want),
            "CLAUDE_CONFIG_DIR (" + os.path.basename(want)
            + ") matches no registered account — usage line will read 'unresolved'; "
            + "fix accounts.json or the launch account.",
        )
    except Exception:
        return _skip("account")


def fleet_label(session_id: str, transcript_path: str = "", home: str | None = None) -> str | None:
    """Transcript first, then a ≤24h cache fallback: agent-identity.py's rule."""
    try:
        label = None
        if transcript_path and os.path.exists(transcript_path):
            with open(transcript_path, "r", errors="replace") as handle:
                for line in handle:
                    if '"custom-title"' not in line:
                        continue
                    try:
                        record = json.loads(line)
                    except (json.JSONDecodeError, TypeError, ValueError):
                        continue
                    if record.get("type") == "custom-title" and isinstance(record.get("customTitle"), str):
                        label = record["customTitle"].strip()
        if label and 1 <= len(label) <= 3:
            return label
        # F9: do not allow a hostile session id to traverse outside the cache.
        if not re.fullmatch(r"[A-Za-z0-9_-]+", session_id or ""):
            return None
        base = Path(home or os.path.expanduser("~")) / ".claude" / "fleet-identity-cache"
        cache = base / f"{session_id}.label"
        if cache.exists() and (time.time() - cache.stat().st_mtime) < 24 * 3600:
            value = cache.read_text().strip()
            if 1 <= len(value) <= 3:
                return value
        return None
    except Exception:
        return None


def probe_identity(env: Mapping[str, str], payload: Mapping[str, object], home: str | None = None) -> ProbeResult:
    try:
        label = fleet_label(
            str(payload.get("session_id") or ""),
            str(payload.get("transcript_path") or ""),
            home,
        )
        if not label:
            return _skip("identity", "no fleet label")
        env_agent = env.get("HEDDLE_AGENT") or env.get("FLEET_AGENT")
        if not env_agent or env_agent == label:
            return ProbeResult("identity", "OK", label)
        return ProbeResult(
            "identity", "FAIL", label,
            "HEDDLE_AGENT=" + env_agent + " disagrees with session label " + label
            + " — this session may act as the wrong agent; reconcile the launch.",
        )
    except Exception:
        return _skip("identity")


def probe_heddle_packs(env: Mapping[str, str]) -> ProbeResult:
    try:
        raw = env.get("HEDDLE_PACKS")
        paths = [segment.strip() for segment in (raw or "").split(os.pathsep) if segment.strip()]
        if not paths:
            return _skip("packs", "unset")
        # skillpacks.ts defines HEDDLE_PACKS as an os.pathsep search path.
        missing = [os.path.expanduser(path) for path in paths if not os.path.isdir(os.path.expanduser(path))]
        if not missing:
            return ProbeResult("packs", "OK")
        return ProbeResult(
            "packs", "FAIL", ", ".join(missing),
            "HEDDLE_PACKS segment(s) do not resolve to directories: " + ", ".join(missing),
        )
    except Exception:
        return _skip("packs")


def _safe_probe(name: str, callback: Callable[[], ProbeResult]) -> ProbeResult:
    """Second structural guard: a future probe cannot turn into a false failure."""
    try:
        result = callback()
        return result if isinstance(result, ProbeResult) else _skip(name)
    except Exception:
        return _skip(name)


def collect_results(
    payload: Mapping[str, object],
    *,
    env: Mapping[str, str] | None = None,
    home: str | None = None,
    comms_argv: str | None = None,
    probes: Mapping[str, Callable[[], ProbeResult]] | None = None,
) -> list[ProbeResult]:
    """Run independent probes; every exception degrades only its own result."""
    env = dict(os.environ if env is None else env)
    default_probes: dict[str, Callable[[], ProbeResult]] = {
        "brain": lambda: probe_brain(env),
        "memtrace": probe_memtrace_reachable,
        "fresh": lambda: probe_memtrace_fresh(env),
        "comms": lambda: probe_comms(env, comms_argv=comms_argv),
        "account": lambda: probe_account(env, home),
        "identity": lambda: probe_identity(env, payload, home),
        "packs": lambda: probe_heddle_packs(env),
    }
    if probes:
        default_probes.update(probes)
    started = time.monotonic()
    results = []
    for name, callback in default_probes.items():
        if time.monotonic() - started > 3.0:
            results.append(_skip(name, "preflight budget exceeded"))
        else:
            results.append(_safe_probe(name, callback))
    return results


def render_banner(results: list[ProbeResult]) -> str:
    failures = [result for result in results if result.status == "FAIL"]
    compact = []
    for result in results:
        if result.status == "OK":
            if result.name in {"account", "identity"} and result.detail:
                compact.append(f"{result.name}:{result.detail}✓")
            elif result.name == "fresh":
                compact.append("fresh✓(as of last fetch)")
            else:
                compact.append(result.name + "✓")
        elif result.status == "SKIP":
            compact.append(result.name + ":—")
    tail = " ".join(compact)
    if not failures:
        return "⟢ PREFLIGHT OK — " + tail
    bullets = "\n".join("- " + result.remediation for result in failures)
    return f"⟢ PREFLIGHT ⚠️ {len(failures)} ISSUE(S):\n{bullets}\n{tail}"


def emit(context: str | None = None) -> None:
    if context:
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "SessionStart", "additionalContext": context,
        }}))
    else:
        print("{}")
    sys.exit(0)


def main() -> None:
    try:
        payload = json.loads(sys.stdin.read(65536))
        if not isinstance(payload, dict):
            raise ValueError("SessionStart payload is not an object")
        emit(render_banner(collect_results(payload)))
    except SystemExit as exc:
        if exc.code == 0:
            raise
        try:
            print("{}")
        except BaseException:
            pass
        sys.exit(0)
    except BaseException:
        # A preflight must never block a session start or emit a fake problem.
        try:
            print("{}")
        except BaseException:
            pass
        sys.exit(0)


if __name__ == "__main__":
    main()
