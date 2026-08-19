#!/usr/bin/env python3
"""
Spinventory project hook: require Memtrace before source discovery.

Modes:
  record         PostToolUse: remember that this session consulted Memtrace
  enforce-query  PreToolUse: block source discovery until Memtrace was used
  stop           Stop: fallback guard if a session tried source discovery without Memtrace
"""
import json
import os
import re
import shlex
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path.home() / ".claude" / "lib"))
from hook_utils import (
    read_hook_input,
    allow_pretool,
    deny_pretool,
    block_stop,
    allow_stop,
    is_stop_loop_guard_active,
    get_session_id,
    load_state,
    save_state,
)

STATE_NAME = "memtrace_first"

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
APP_MONOREPO = PROJECT_ROOT / "Spinventory-Rebuild-Official" / "Rebuild-Project-Root"
SPINVENTORY_OFFICIAL_ROOT = PROJECT_ROOT / "Spinventory-Rebuild-Official"
CANONICAL_REPO_ID = "Rebuild-Project-Root"
# HED-82: the heddle repos are memtrace-indexed too (repo_ids `heddle` /
# `heddle-dashboard`). Worktrees live nested at <repo>/.worktrees/<slug>
# (covered by being under the root) or, transitionally, as ~/Developer
# siblings named <repo>.<slug>. This hook is loaded by BOTH the Spinventory
# workspace settings and the heddle repos' settings — path logic must hold
# from every cwd.
HEDDLE_REPOS: list[tuple[Path, str]] = [
    (Path.home() / "Developer" / "heddle-dashboard", "heddle-dashboard"),
    (Path.home() / "Developer" / "heddle", "heddle"),
]
KNOWN_REPO_IDS = {CANONICAL_REPO_ID} | {rid for _, rid in HEDDLE_REPOS}

# ---------------------------------------------------------------------------
# Enforcement switch — Memtrace is OPT-IN, not a mandatory gate.
# (Maya-approved 2026-07-07, implemented by Agent D.)
#
# The hard gate was costing the fleet more than it returned: the shared index
# ran badly stale, most parallel worktrees were unwatched, the repo_id was
# split across two ids, and cross-repo signals (cochange / impact) came back
# stale or empty. Agents were being blocked from rg / grep / Read and pushed
# toward a memory layer that frequently had nothing useful — pure added latency
# on every search. Until Memtrace health is restored fleet-wide, the three
# enforcement modes below allow-through unconditionally.
#
# NOTE: `record` mode still runs, so Memtrace usage is still tracked in session
# state — only the BLOCKING is disabled. Every regex/helper below is left intact
# so nothing is lost and re-enabling is a one-line flip.
#
# TO RE-ENABLE THE GATE: set ENFORCEMENT_ENABLED = True. Nothing else changes.
# ---------------------------------------------------------------------------
ENFORCEMENT_ENABLED = False
# HED-82: enforcement is PER-ROOT expressible. Keys = resolved indexed-repo
# roots (str); value True = hard gate for cwds under that root. Anything
# absent falls back to ENFORCEMENT_ENABLED. All False today: R recommends
# hard-gate ON for the heddle roots (fresh watches, canonical repo_ids), but
# that flip is MAYA'S CALL — flip a value to True only on her explicit word.
ENFORCEMENT_ROOTS: dict[str, bool] = {
    # Hard gate ON for the heddle roots — Maya, 2026-08-16 ("yes and yes",
    # relayed by R): fresh watches, canonical repo_ids, small indexes. The
    # gate only fires in sessions that LOAD hooks (heddle repos' own
    # .claude/settings.json, HED-82) — workspace sessions keep record-only.
    str(Path.home() / "Developer" / "heddle"): True,
    str(Path.home() / "Developer" / "heddle-dashboard"): True,
}


def repo_id_for_path(cwd: str) -> str:
    """Best-effort repo_id for the cwd's indexed repo (message text only)."""
    root = indexed_repo_root_for_path(cwd or "")
    if root is None:
        return CANONICAL_REPO_ID
    name = root.name
    for repo_root, rid in HEDDLE_REPOS:
        if name == repo_root.name or name.startswith(f"{repo_root.name}."):
            return rid
    return CANONICAL_REPO_ID


def emit_discipline(data: dict, event: str) -> None:
    """Fleet discipline telemetry (HED-85 contract): append one 8-key JSON line
    to ~/.heddle/discipline.jsonl. Best-effort — never breaks a turn."""
    try:
        _cwd = data.get("cwd") or ""
        _sid = data.get("session_id") or ""
        _label_file = Path(os.path.expanduser("~/.claude/fleet-identity-cache")) / f"{_sid}.label"
        _agent = None
        if _label_file.is_file():
            _v = _label_file.read_text().strip()
            if 1 <= len(_v) <= 3:
                _agent = _v
        if not _agent:
            _agent = os.environ.get("FLEET_AGENT") or None
        _root = indexed_repo_root_for_path(_cwd)
        _line = json.dumps({
            "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time())),
            "session_id": _sid,
            "agent": _agent,
            "cwd": _cwd,
            "repo_id": repo_id_for_path(_cwd) if _root is not None else None,
            "tool_name": data.get("tool_name", ""),
            "hook_event_name": event,
            "gate": enforcement_enabled_for(_cwd),
        })
        _sink = Path(os.path.expanduser("~/.heddle"))
        _sink.mkdir(parents=True, exist_ok=True)
        with open(_sink / "discipline.jsonl", "a") as _f:
            _f.write(_line + "\n")
    except Exception:
        pass


def enforcement_enabled_for(cwd: str) -> bool:
    root = indexed_repo_root_for_path(cwd or "")
    if root is not None and str(root) in ENFORCEMENT_ROOTS:
        return ENFORCEMENT_ROOTS[str(root)]
    return ENFORCEMENT_ENABLED


# Serena symbol tools count as memory-layer usage (HED-82): they are the
# approved symbol-precise complement to memtrace, and the rules docs promise
# they are "not bypasses". Recorded so usage is measurable per session.
SERENA_MEMORY_TOOLS_RE = re.compile(
    r"^mcp__serena__(find_symbol|find_referencing_symbols|find_declaration|"
    r"find_implementations|get_symbols_overview|replace_symbol_body|"
    r"insert_(after|before)_symbol|rename_symbol)$"
)

SEARCH_RE = re.compile(r"(^|[;&|()]|\s)(git\s+grep|git\s+ls-files|rg|grep|find|fd|ag|ack)\b", re.IGNORECASE)
# NOTE: head/tail/ls/tree intentionally REMOVED. They caused false positives that
# slowed every instance: `git show HEAD:<path>` matched `head` (case-insensitive) and
# was wrongly blocked, and piping to `| head`/`| tail` to shape output tripped the gate.
# These are output-shaping / listing verbs, not source dumping. cat/sed/nl/awk (which
# actually dump file contents) stay gated.
SOURCE_READ_RE = re.compile(r"(^|[;&|()]|\s)(cat|sed|nl|awk)\b", re.IGNORECASE)
RECURSIVE_CODE_SEARCH_RE = re.compile(
    r"(^|[;&|()]|\s)(rg|ugrep)\b"
    r"|(^|[;&|()]|\s)grep\s+(-[A-Za-z]*[rR][A-Za-z]*|--recursive\b)",
    re.IGNORECASE,
)
SOURCE_PATH_RE = re.compile(
    r"(^|[\s'\"=:/])("
    r"apps/|src/|components/|lib/|app/|supabase/|scripts/|"
    r"[^\s'\";|()]+\.(ts|tsx|js|jsx|mjs|cjs|swift|kt|java|py|sql)"
    r")",
    re.IGNORECASE,
)
SOURCE_EXTENSIONS = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".swift", ".kt", ".java", ".py", ".sql"}
VALID_MEMTRACE_MCP_TOOLS = {
    "mcp__memtrace__find_code",
    "mcp__memtrace__find_symbol",
    "mcp__memtrace__get_symbol_context",
    "mcp__memtrace__analyze_relationships",
    "mcp__memtrace__get_impact",
    "mcp__memtrace__get_source_window",
    "mcp__memtrace__get_process_flow",
    "mcp__memtrace__find_central_symbols",
    "mcp__memtrace__find_bridge_symbols",
    "mcp__memtrace__get_evolution",
}
VALID_MEMTRACE_CLI_RE = re.compile(
    r"(^|[;&|()]|\s)memtrace\s+"
    r"(insight-card|find-code|find_code|find-symbol|find_symbol|search|query|symbol|context|impact|source-window)\b",
    re.IGNORECASE,
)

DOC_OR_CONFIG_MARKERS = (
    ".md",
    "readme",
    "context.md",
    "agents.md",
    "claude.md",
    "skill.md",
    "memory.md",
    "_vault",
    ".claude/",
    ".cursor/",
    ".codex/",
    "docs/",
    "references-and-documentation/",
    "package.json",
    "package-lock.json",
    "tsconfig",
    "app.json",
    "eas.json",
    "babel.config",
    "metro.config",
    "eslint",
    "prettier",
    ".env",
)


def state_for(data: dict) -> tuple[str, dict]:
    session_id = get_session_id(data)
    return session_id, load_state(session_id, STATE_NAME)


def tool_fingerprint(tool_name: str, tool_input: dict) -> str:
    command = tool_input.get("command", "")
    repo_id = tool_input.get("repo_id", "")
    query = tool_input.get("query", "")
    name = tool_input.get("name", "")
    file_path = tool_input.get("file_path", "")
    path = tool_input.get("path", "")
    pattern = tool_input.get("pattern", "")
    return "|".join([tool_name, str(repo_id), str(query), str(name), str(file_path), str(path), str(pattern), str(command)])


def save_for(session_id: str, state: dict) -> None:
    save_state(session_id, STATE_NAME, state)


def path_is_inside(path_text: str, root: Path) -> bool:
    try:
        Path(path_text).resolve().relative_to(root.resolve())
        return True
    except (ValueError, OSError, RuntimeError):
        return False


def normalized_path(path_text: str, cwd: str = "") -> Path | None:
    if not path_text:
        return None
    path = Path(path_text)
    if not path.is_absolute() and cwd:
        path = Path(cwd) / path
    try:
        return path.resolve()
    except (OSError, RuntimeError):
        return path


def indexed_repo_root_for_path(path_text: str, cwd: str = "") -> Path | None:
    path = normalized_path(path_text, cwd)
    if path is None:
        return None

    try:
        resolved_app = APP_MONOREPO.resolve()
        if path == resolved_app or path.relative_to(resolved_app):
            return resolved_app
    except (ValueError, OSError, RuntimeError):
        pass

    try:
        official_root = SPINVENTORY_OFFICIAL_ROOT.resolve()
        rel = path.relative_to(official_root)
        if rel.parts:
            worktree_name = rel.parts[0]
            if worktree_name == CANONICAL_REPO_ID or worktree_name.startswith(f"{CANONICAL_REPO_ID}."):
                return official_root / worktree_name
    except (ValueError, OSError, RuntimeError):
        pass

    # heddle repos (HED-82): the root itself covers nested .worktrees/<slug>;
    # ~/Developer/<repo>.<slug> siblings are the transitional layout.
    for repo_root, _rid in HEDDLE_REPOS:
        try:
            resolved = repo_root.resolve()
            if path == resolved or path.is_relative_to(resolved):
                return resolved
            dev_dir = resolved.parent
            rel = path.relative_to(dev_dir)
            if rel.parts and rel.parts[0].startswith(f"{repo_root.name}."):
                return dev_dir / rel.parts[0]
        except (ValueError, OSError, RuntimeError):
            continue

    return None


def cwd_inside_project_or_app(cwd: str) -> bool:
    if not cwd:
        return True
    return path_is_inside(cwd, PROJECT_ROOT) or path_is_inside(cwd, APP_MONOREPO)


def cwd_inside_indexed_repo(cwd: str) -> bool:
    return indexed_repo_root_for_path(cwd) is not None


def command_is_valid_memtrace_query(command: str) -> bool:
    lower = command.lower()
    if RECURSIVE_CODE_SEARCH_RE.search(command) or SEARCH_RE.search(command) or SOURCE_READ_RE.search(command):
        return False
    return (
        (VALID_MEMTRACE_CLI_RE.search(command)
         and any(rid.lower() in lower for rid in KNOWN_REPO_IDS))
        or "localhost:3030/api/repos" in lower
        or "127.0.0.1:3030/api/repos" in lower
    )


def tool_is_valid_memtrace_query(tool_name: str, tool_input: dict) -> bool:
    if tool_name not in VALID_MEMTRACE_MCP_TOOLS:
        return False

    repo_id = tool_input.get("repo_id")
    if repo_id and repo_id not in KNOWN_REPO_IDS:
        return False

    return True


def command_tokens(command: str) -> list[str]:
    try:
        return shlex.split(command)
    except ValueError:
        return re.split(r"\s+", command)


def command_targets_indexed_repo(command: str, cwd: str) -> bool:
    if cwd_inside_indexed_repo(cwd):
        return True

    if str(SPINVENTORY_OFFICIAL_ROOT) in command and CANONICAL_REPO_ID in command:
        return True

    if any(str(root) in command for root, _ in HEDDLE_REPOS):
        return True

    for token in command_tokens(command):
        cleaned = token.strip("'\"")
        if not cleaned or cleaned.startswith("-"):
            continue
        if "/" not in cleaned and not cleaned.startswith("."):
            continue
        if indexed_repo_root_for_path(cleaned, cwd) is not None:
            return True

    return False


def is_doc_or_config_search(command: str) -> bool:
    lower = command.lower()
    return any(marker in lower for marker in DOC_OR_CONFIG_MARKERS)


def is_doc_or_config_path(path_text: str) -> bool:
    lower = path_text.lower()
    return any(marker in lower for marker in DOC_OR_CONFIG_MARKERS)


def is_source_read_tool(tool_name: str, tool_input: dict, cwd: str) -> bool:
    if tool_name != "Read":
        return False

    file_path = str(tool_input.get("file_path", ""))
    path = normalized_path(file_path, cwd)
    if path is None:
        return False

    return (
        indexed_repo_root_for_path(str(path)) is not None
        and path.suffix.lower() in SOURCE_EXTENSIONS
        and not is_doc_or_config_path(str(path))
    )


def is_recursive_code_search(tool_name: str, tool_input: dict, cwd: str) -> bool:
    if tool_name != "Bash":
        return False

    command = tool_input.get("command", "")
    if not command or not RECURSIVE_CODE_SEARCH_RE.search(command):
        return False

    if is_doc_or_config_search(command) and not SOURCE_PATH_RE.search(command):
        return False

    return command_targets_indexed_repo(command, cwd)


def is_source_discovery(tool_name: str, tool_input: dict, cwd: str) -> bool:
    if is_source_read_tool(tool_name, tool_input, cwd):
        return True

    if tool_name in {"Grep", "Glob"}:
        return cwd_inside_project_or_app(cwd)

    if tool_name != "Bash":
        return False

    command = tool_input.get("command", "")
    if not command:
        return False

    if is_doc_or_config_search(command):
        return False

    if SEARCH_RE.search(command):
        return cwd_inside_project_or_app(cwd)

    if SOURCE_READ_RE.search(command) and SOURCE_PATH_RE.search(command):
        return cwd_inside_project_or_app(cwd)

    return False


def deny_recursive_search(data: dict) -> None:
    if not enforcement_enabled_for((data.get("cwd") or "")):
        sys.exit(0)  # opt-in for this root: gate disabled (see ENFORCEMENT_ROOTS / ENFORCEMENT_ENABLED)

    tool_name = data.get("tool_name", "")
    tool_input = data.get("tool_input", {})
    cwd = data.get("cwd", "")

    if not is_recursive_code_search(tool_name, tool_input, cwd):
        sys.exit(0)

    session_id, state = state_for(data)
    state["blocked_recursive_code_search_count"] = state.get("blocked_recursive_code_search_count", 0) + 1
    state["last_blocked_recursive_time"] = time.time()
    state["last_blocked_recursive_fingerprint"] = tool_fingerprint(tool_name, tool_input)
    save_for(session_id, state)

    rid = repo_id_for_path(data.get("cwd") or "")
    emit_discipline(data, "PreToolUse-denied")
    deny_pretool(
        f"BLOCKED: Recursive code search inside the indexed repo must use Memtrace MCP.\n\n"
        f"Use mcp__memtrace__find_code or mcp__memtrace__find_symbol with repo_id: {rid}. "
        "If Memtrace returns no useful result, broaden the Memtrace query or fix/reindex Memtrace instead of falling back to rg, ugrep, or grep -r.\n\n"
        "Bounded source reads or single-file checks may follow after a relevant Memtrace result."
    )


def record_memtrace(data: dict) -> None:
    tool_name = data.get("tool_name", "")
    tool_input = data.get("tool_input", {})
    command = tool_input.get("command", "")

    used_memtrace = (
        tool_is_valid_memtrace_query(tool_name, tool_input)
        or command_is_valid_memtrace_query(command)
        or bool(SERENA_MEMORY_TOOLS_RE.match(tool_name))
    )
    if not used_memtrace:
        sys.exit(0)

    session_id, state = state_for(data)
    now = time.time()
    fingerprint = tool_fingerprint(tool_name, tool_input)

    if (
        state.get("last_recorded_memtrace_fingerprint") == fingerprint
        and now - float(state.get("last_recorded_memtrace_time", 0)) < 5
    ):
        sys.exit(0)

    emit_discipline(data, data.get("hook_event_name", "PostToolUse"))

    state["queried_memtrace"] = True
    state["last_memtrace_time"] = now
    state["last_recorded_memtrace_time"] = now
    state["last_recorded_memtrace_fingerprint"] = fingerprint
    state["memtrace_count"] = state.get("memtrace_count", 0) + 1
    state["memtrace_grants"] = 1
    if command:
        commands = state.get("commands", [])
        commands.append(command[:500])
        state["commands"] = commands[-10:]
    save_for(session_id, state)
    sys.exit(0)


def enforce_query_order(data: dict) -> None:
    if not enforcement_enabled_for((data.get("cwd") or "")):
        allow_pretool()  # opt-in for this root: gate disabled (see ENFORCEMENT_ROOTS / ENFORCEMENT_ENABLED)

    tool_name = data.get("tool_name", "")
    tool_input = data.get("tool_input", {})
    cwd = data.get("cwd", "")
    now = time.time()

    session_id, state = state_for(data)
    if not is_source_discovery(tool_name, tool_input, cwd):
        allow_pretool()

    fingerprint = tool_fingerprint(tool_name, tool_input)
    if (
        state.get("last_allowed_source_fingerprint") == fingerprint
        and now - float(state.get("last_allowed_source_time", 0)) < 5
    ):
        allow_pretool()

    # Sticky grant: once Memtrace has been consulted at least once this session,
    # allow bounded source reads/searches freely for the rest of the session.
    # Previously each Memtrace query granted only ONE follow-up read, forcing a
    # re-query between every file — the main slowdown. The "Memtrace first" intent
    # is preserved (the FIRST discovery still requires a query), and broad recursive
    # search (rg / grep -r / find) stays hard-blocked by deny-recursive-search.
    if state.get("queried_memtrace"):
        state["source_discovery_after_memtrace_count"] = state.get("source_discovery_after_memtrace_count", 0) + 1
        state["last_source_discovery_time"] = now
        state["last_allowed_source_time"] = now
        state["last_allowed_source_fingerprint"] = fingerprint
        save_for(session_id, state)
        allow_pretool()

    state["blocked_source_search_count"] = state.get("blocked_source_search_count", 0) + 1
    state["last_blocked_time"] = now
    save_for(session_id, state)

    rid = repo_id_for_path(data.get("cwd") or "")
    emit_discipline(data, "PreToolUse-denied")
    deny_pretool(
        f"BLOCKED: Query Memtrace before source-code discovery in this repo.\n\n"
        f"Run a Memtrace query for this specific lookup first, for example:\n"
        f"  memtrace insight-card {rid}\n"
        f"or use mcp__memtrace__find_code / mcp__memtrace__find_symbol with repo_id: {rid}. "
        "list_indexed_repositories is setup only; it does not replace a code lookup.\n\n"
        "Each Memtrace query permits one follow-up source search/read when still needed."
    )


def stop_guard(data: dict) -> None:
    if not enforcement_enabled_for((data.get("cwd") or "")):
        allow_stop()  # opt-in for this root: gate disabled (see ENFORCEMENT_ROOTS / ENFORCEMENT_ENABLED)

    if is_stop_loop_guard_active(data):
        allow_stop()

    _session_id, state = state_for(data)
    if state.get("blocked_source_search_count") and not state.get("queried_memtrace"):
        block_stop(
            "Source-code discovery was attempted before Memtrace was queried. "
            "Query Memtrace now, then continue with source search/read only if it is still needed."
        )

    last_recursive_block = float(state.get("last_blocked_recursive_time", 0))
    last_memtrace = float(state.get("last_memtrace_time", 0))
    if state.get("blocked_recursive_code_search_count") and last_memtrace <= last_recursive_block:
        block_stop(
            "Recursive code search was blocked in this session. Use Memtrace MCP tools "
            f"for code discovery in {repo_id_for_path(data.get('cwd') or '')} before continuing."
        )

    allow_stop()


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: require-memtrace-first.py {record|enforce-query|stop}", file=sys.stderr)
        sys.exit(1)

    mode = sys.argv[1]
    data = read_hook_input()

    if mode == "record":
        record_memtrace(data)
    elif mode == "deny-recursive-search":
        deny_recursive_search(data)
    elif mode == "enforce-query":
        enforce_query_order(data)
    elif mode == "stop":
        stop_guard(data)
    else:
        print(f"Unknown mode: {mode}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
