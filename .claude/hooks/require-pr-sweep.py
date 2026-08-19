#!/usr/bin/env python3
"""
Spinventory project hook: require a FULL 3-channel PR review sweep before an agent
declares any PR clean / merge-ready.

Maya's rule (2026-07-03): ~90% of the time an instance declares a PR merge-ready while
an unaddressed review or comment still sits on it — because it checked only one channel,
only the bot names it expected, or comments-not-reviews (or reviews-not-comments). This
is every instance (Claude / Codex / Gemini), every session. This hook enforces the sweep
so the claim can't be made blind. See Commandment #3 in CLAUDE.md / AGENTS.md and memory
feedback_sweep_all_pr_channels.

The THREE separate GitHub review channels that must ALL be swept for a PR:
  1. issue comments  — gh pr view <n> --json comments   (qodo / gitar / coderabbit / humans)
  2. review bodies   — gh pr view <n> --json reviews     (mmayasaurus / sourcery / cursor /
                                                           copilot / codex — the MOST-MISSED)
  3. inline threads  — GraphQL reviewThreads { ... isResolved }  (check EVERY thread)

Two modes:
  record        PostToolUse on Bash — detect READ-only gh / GraphQL PR-channel queries and
                record, per PR number, which of the 3 channels were swept THIS session.
  enforce-stop  Stop hook — if the agent's final message declares a numbered PR
                clean / merge-ready and that PR's 3-channel sweep is incomplete this
                session, block the stop with the exact missing channels + the commands.

Known limits (documented, not bugs): enforcement needs an explicit "#<number>" near the
readiness phrase; it verifies all 3 channels were swept this session but does NOT compare
the sweep time to the latest push (the "late review after your sweep" trap stays covered
by the written Commandment). It records a sweep only from read-shaped commands, never from
a write (gh pr comment / review / merge, POST/PATCH, GraphQL mutation).

FAIL-OPEN: any internal error allows the stop — a buggy hook must never brick a session.

Usage in .claude/settings.json:
  PostToolUse matcher "Bash":  command = "python3 .../require-pr-sweep.py record"
  Stop:                        command = "python3 .../require-pr-sweep.py enforce-stop"
"""
import json
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path.home() / ".claude" / "lib"))
from hook_utils import (
    read_hook_input,
    get_session_id,
    load_state,
    save_state,
    block_stop,
    allow_stop,
    is_stop_loop_guard_active,
)

STATE_NAME = "pr_sweep"
CHANNELS = ("comments", "reviews", "threads")

# Commands that WRITE / mutate rather than sweep — never count these as a channel sweep.
# NOTE: deliberately excludes `-f`/`-F` so a GraphQL *query* (`gh api graphql -f query=...`)
# that reads reviewThreads still counts; mutations are caught by the `mutation` keyword.
WRITE_MARKERS = (
    "gh pr comment",
    "gh pr review ",
    "gh pr merge",
    "gh pr close",
    "gh pr edit",
    "gh pr ready",
    "--method post",
    "--method patch",
    "--method put",
    "--method delete",
    "-x post",
    "-x patch",
    "-x delete",
    "mutation",
    "addpullrequestreview",
    "resolvereviewthread",
    "unresolvereviewthread",
)


def _pr_numbers(cmd: str) -> set:
    """Every PR number a read command references (pr view/checks/diff, api paths, GraphQL)."""
    nums = set()
    for m in re.finditer(r"\bpr\s+(?:view|checks|diff|status)\s+#?(\d{2,})", cmd):
        nums.add(m.group(1))
    for m in re.finditer(r"/(?:pulls|issues)/(\d{2,})", cmd):        # REST api paths
        nums.add(m.group(1))
    for m in re.finditer(r"\bnumber:\s*(\d{2,})", cmd):              # GraphQL pullRequest(number: N)
        nums.add(m.group(1))
    return nums


def _channels_in(cmd: str) -> set:
    """Which of the 3 review channels a read command covers."""
    found = set()
    low = cmd.lower()

    # inline threads — distinctive GraphQL / review-comment REST shape
    if "reviewthreads" in low or "isresolved" in low or re.search(r"/pulls/\d+/comments", low):
        found.add("threads")

    # review bodies
    if (
        re.search(r"--json[^|;&]*\breviews\b", low)
        or re.search(r"/pulls/\d+/reviews", low)
        or "latestreviews" in low
        or re.search(r"\breviews\s*\(", low)  # GraphQL reviews(first: ...)
    ):
        found.add("reviews")

    # issue comments (exclude the reviewThreads.comments sub-selection so it isn't conflated)
    if "reviewthreads" not in low and (
        re.search(r"--json[^|;&]*\bcomments\b", low)
        or re.search(r"\bpr\s+view\b[^|;&]*--comments", low)
        or re.search(r"/issues/\d+/comments", low)
    ):
        found.add("comments")

    return found


def record(data: dict) -> None:
    cmd = (data.get("tool_input", {}) or {}).get("command", "") or ""
    if not cmd.strip():
        sys.exit(0)
    low = cmd.lower()
    if any(w in low for w in WRITE_MARKERS):
        sys.exit(0)  # a write, not a sweep

    prs = _pr_numbers(cmd)
    chans = _channels_in(cmd)
    if not prs or not chans:
        sys.exit(0)

    session_id = get_session_id(data)
    state = load_state(session_id, STATE_NAME)
    sweeps = state.setdefault("sweeps", {})
    now = time.time()
    for pr in prs:
        entry = sweeps.setdefault(pr, {})
        for ch in chans:
            entry[ch] = now
    save_state(session_id, STATE_NAME, state)
    sys.exit(0)


# --- Stop enforcement -------------------------------------------------------

READY_RE = re.compile(
    r"merge[\s-]*ready|ready\s+to\s+merge|ready\s+for\s+merge|safe\s+to\s+merge|"
    r"good\s+to\s+merge|cleared?\s+to\s+merge|"
    r"(?:100\s*%|fully|completely)\s+clean|"
    r"(?:pr|#\d{2,})\s+is\s+(?:now\s+)?clean|"
    r"no\s+(?:outstanding|unresolved|open|remaining)\s+"
    r"(?:comments?|reviews?|threads?|issues?|findings?)|"
    r"\bLGTM\b|(?:green\s+and\s+clean|clean\s+and\s+(?:ready|green|mergeable))",
    re.IGNORECASE,
)
# If any of these sit near the readiness phrase, it's discussing the rule / a NOT-ready
# state, not declaring readiness — skip it.
NEGATION_RE = re.compile(
    r"\bnot\b|isn'?t|aren'?t|before\s+declaring|do\s+not|don'?t|"
    r"must\s+(?:check|sweep|verify|re-?sweep)|still\s+(?:has|have|open|need|needs)|"
    r"has\s+(?:open|unresolved|outstanding)|pending\s+(?:review|sweep|bot)|"
    r"await(?:ing|s)?\s+|not\s+yet",
    re.IGNORECASE,
)
PR_REF_RE = re.compile(r"#(\d{2,})")


def _last_assistant_text(transcript_path: str) -> str:
    """Concatenated text of the LAST assistant message in the transcript JSONL."""
    try:
        p = Path(transcript_path)
        if not p.exists():
            return ""
        text = ""
        for line in p.read_text(errors="ignore").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if obj.get("type") != "assistant":
                continue
            msg = obj.get("message", {}) or {}
            if msg.get("role") != "assistant":
                continue
            content = msg.get("content", [])
            parts = []
            if isinstance(content, str):
                parts.append(content)
            elif isinstance(content, list):
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "text":
                        parts.append(block.get("text", ""))
            text = "\n".join(parts)  # overwrite → ends on the LAST assistant message
        return text
    except Exception:
        return ""


def enforce_stop(data: dict) -> None:
    if is_stop_loop_guard_active(data):
        allow_stop()

    text = _last_assistant_text(data.get("transcript_path", ""))
    if not text or not READY_RE.search(text):
        allow_stop()

    # Only PR numbers that appear NEAR a readiness phrase and are not obviously negated.
    declared = set()
    for m in READY_RE.finditer(text):
        window = text[max(0, m.start() - 220): m.end() + 220]
        if NEGATION_RE.search(window):
            continue
        for pm in PR_REF_RE.finditer(window):
            declared.add(pm.group(1))
    if not declared:
        allow_stop()

    session_id = get_session_id(data)
    sweeps = load_state(session_id, STATE_NAME).get("sweeps", {})

    problems = []
    for pr in sorted(declared, key=int):
        have = set((sweeps.get(pr, {}) or {}).keys())
        missing = [c for c in CHANNELS if c not in have]
        if missing:
            problems.append((pr, missing))
    if not problems:
        allow_stop()

    label = {
        "comments": "issue comments   (gh pr view <n> --json comments)",
        "reviews": "review bodies    (gh pr view <n> --json reviews)   ← most-missed",
        "threads": "inline threads   (GraphQL reviewThreads { … isResolved })",
    }
    lines = [
        "\U0001F6D1 PR CLEAN / MERGE-READY CLAIM WITHOUT A COMPLETE REVIEW SWEEP (Commandment #3).",
        "",
        "Your message declares a PR clean / merge-ready, but this session has NOT swept all",
        "three GitHub review channels for it. ~90% of missed items hide in a channel the",
        "instance skipped — usually the REVIEW BODIES, or a review that landed after the sweep.",
        "",
    ]
    for pr, missing in problems:
        lines.append(f"  • PR #{pr} — not swept this session:")
        for c in missing:
            lines.append(f"      - {label[c]}")
    lines += [
        "",
        "Sweep ALL THREE against the CURRENT HEAD, for EVERY author (bots + humans), then",
        "re-check before you say a word about readiness:",
        "  1. gh pr view <n> --json comments   (issue comments)",
        "  2. gh pr view <n> --json reviews    (REVIEW BODIES — empty body = clean; the most-missed)",
        "  3. GraphQL reviewThreads { nodes { isResolved … } }   (check EVERY thread)",
        "",
        "Reviews AND comments, not one or the other; don't stop at names you expected. Address",
        "every item (fix, or reply + resolve), re-sweep after any new commit, THEN report.",
        "Mergeability is Maya's call — and only after this is genuinely clean.",
    ]
    block_stop("\n".join(lines))


def main():
    if len(sys.argv) < 2:
        print("Usage: require-pr-sweep.py {record|enforce-stop}", file=sys.stderr)
        sys.exit(0)  # fail-open
    mode = sys.argv[1]
    try:
        data = read_hook_input()
        if mode == "record":
            record(data)
        elif mode == "enforce-stop":
            enforce_stop(data)
        else:
            sys.exit(0)
    except SystemExit:
        raise
    except Exception as e:  # fail-open — never brick a session on a hook bug
        print(f"[require-pr-sweep] non-fatal: {e}", file=sys.stderr)
        sys.exit(0)


if __name__ == "__main__":
    main()
