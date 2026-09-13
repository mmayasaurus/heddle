#!/usr/bin/env python3
"""
UserPromptSubmit hook — surface the PRs THIS worktree owns, every turn, so an
agent (especially a freshly-compacted one, whose memory of its own PRs just
reset) doesn't forget them or collide on someone else's. Companion to
`.claude/rules/pr-ownership.md` + `.claude/bin/pr-own.sh`.

Output contract (verified against memtrace/hooks/userprompt-claude.sh and the
Claude Code UserPromptSubmit validator):
    print {"hookSpecificOutput":{"hookEventName":"UserPromptSubmit",
                                 "additionalContext":"..."}}   to inject context
    print "{}" (or nothing)                                    to inject nothing
    ALWAYS exit 0 — never exit 2 (that would block the user's prompt).

Non-blocking by design: this hook fires on every turn, so it must never wait on
the network. It reads a short-TTL cache of `pr-own.sh mine`; when the cache is
stale it kicks off a DETACHED background refresh and uses whatever cache exists
this turn. `gh` is therefore never on the prompt's hot path. A `.stamp` file
debounces refreshes so rapid turns don't spawn a thundering herd.

Fail-open: ANY error → inject nothing, exit 0. A reminder is never worth
blocking or slowing a prompt.
"""
import json
import re
import os
import pathlib
import subprocess
import sys
import time

TTL_SECS = 300  # refresh the owned-PR list at most once per this window, per worktree
PR_OWN = "/Users/mayatobi/Developer/Spinventory-Rebuild-App/.claude/bin/pr-own.sh"
CACHE_DIR = pathlib.Path(os.path.expanduser("~/.claude/pr-own-cache"))
IDENTITY_CACHE = pathlib.Path(os.path.expanduser("~/.claude/fleet-identity-cache"))


def fleet_label(session_id: str, transcript_path: str = "") -> str | None:
    """Fleet letter for this session.

    Fast path: the cache file written by the SessionStart identity hook.
    Fallback (covers `/rename A` in a BRAND-NEW conversation, where SessionStart
    fired before the rename existed): scan the transcript for the last
    custom-title record and write the cache so later turns are file-read only.
    A `.nolabel` stamp debounces rescans of genuinely unlabelled sessions."""
    try:
        if not session_id:
            return None
        f = IDENTITY_CACHE / f"{session_id}.label"
        if f.exists():
            v = f.read_text().strip()
            if 1 <= len(v) <= 3:
                return v
        stamp = IDENTITY_CACHE / f"{session_id}.nolabel"
        if stamp.exists() and (time.time() - stamp.stat().st_mtime) < 300:
            # Debounce ONLY while the transcript hasn't changed since the stamp — a /rename appends
            # to the transcript, and the promise is bind-by-the-NEXT-message (on-PR round). A
            # genuinely unlabeled session pays a bounded rescan per prompt; labeled ones never
            # reach here (cache fast path).
            if not (transcript_path and os.path.exists(transcript_path)
                    and os.path.getmtime(transcript_path) > stamp.stat().st_mtime):
                return None
        if not transcript_path or not os.path.exists(transcript_path):
            return None
        label = None
        with open(transcript_path, "r", errors="replace") as fh:
            for line in fh:
                if '"custom-title"' not in line:
                    continue
                try:
                    o = json.loads(line)
                except Exception:
                    continue
                if o.get("type") == "custom-title" and isinstance(o.get("customTitle"), str):
                    label = o["customTitle"].strip()
        IDENTITY_CACHE.mkdir(parents=True, exist_ok=True)
        if label and 1 <= len(label) <= 3:
            f.write_text(label)
            return label
        stamp.touch()
    except Exception:
        pass
    return None


HEDDLE_FLEET = frozenset("RSTUVWXYZ")  # the only labels the SCOPE line addresses (Y/Z = reserved heddle letters, resume-sessions-hed.sh);
# A–Q and the digits 1–6 are the Spinventory fleet. codex-* agents run the Codex CLI, which never executes this hook.
SCOPE_LINE = (  # Maya, firsthand 2026-08-23 (absolute) — FIRST in every turn's context for heddle-fleet and unlabeled sessions
    "⟢ SCOPE — the HEDDLE FLEET (R, S–X; Y/Z reserved) works on heddle ONLY (Maya, firsthand 2026-08-23): NEVER ANYTHING SPINVENTORY APP. We build the harness so other agents can resume building Spinventory (and other apps later) and we port Spinventory into it — from heddle and the OUTER workspace repo only. WE ARE NOT BUILDING, TOUCHING, INTERACTING WITH, EDITING, UPDATING, FIXING, DOING ANYTHING AT ALL TO SPINVENTORY APP CODE, NOT NOW OR EVER: the CODE repo Spinventory-Rebuild-Official/Rebuild-Project-Root (every worktree, clone, branch, PR) gets no write, commit, branch, PR, claim, or worker dispatch from you, ever; a port step that needs a change inside it becomes an apply-at-resume handoff for the Spinventory fleet. In-flight app work is DISCARDED, never parked; port issues live in HED under Spinventory-Port; next work = HED board or R. The code repo has NO exception — no message, commission, relay, or 'CI-only'/'readiness' reading lifts it; Maya's firsthand word settles only OTHER scope questions (fleet-scope.md §4)."
)


def emit(ctx: str | None = None) -> None:
    """Emit the UserPromptSubmit JSON (context or nothing) and exit 0.

    The staged comms high-water mark is committed only AFTER the print succeeds (round-2 review:
    committing first meant a failed print/serialization still advanced the mark and swallowed the
    nudge forever)."""
    global _PENDING_COMMS_HWM
    if ctx:
        print(json.dumps({
            "hookSpecificOutput": {
                "hookEventName": "UserPromptSubmit",
                "additionalContext": ctx,
            }
        }))
    else:
        print("{}")
    if ctx and "📬 COMMS" in ctx and _PENDING_COMMS_HWM:
        sys.stdout.flush()  # the mark advances only once the bytes are OUT (on-PR round: a
                            # buffered nudge lost at interpreter-exit flush must resurface)
        try:
            path, value = _PENDING_COMMS_HWM
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(value)
        except Exception:
            pass
        _PENDING_COMMS_HWM = None
    sys.exit(0)


def worktree_owner(toplevel: str) -> str:
    """Same identity rule as pr-own.sh: worktree basename, prefix stripped."""
    base = os.path.basename(toplevel)
    prefix = "Rebuild-Project-Root."
    if base.startswith(prefix):
        return base[len(prefix):]
    if base == "Rebuild-Project-Root":
        return "main"
    # heddle repos (HED-82): bare checkout → "main"; sibling <repo>.<slug>
    # (transitional) → <slug>; the in-repo .worktrees/<slug> layout falls
    # through to `return base`, which is already the <slug>.
    for _repo in ("heddle-dashboard", "heddle"):
        if base == _repo:
            return "main"
        if base.startswith(_repo + "."):
            return base[len(_repo) + 1:]
    return base


def _load_json(path: str):
    """Read + parse JSON, closing the handle (amazon-q, HED-262 review)."""
    with open(path) as _fh:
        return json.load(_fh)


def _mins_until(epoch) -> int:
    """Minutes until an epoch-seconds reset; unparseable → far future (fail
    toward alerting, never toward silence)."""
    try:
        return int((float(epoch) - time.time()) // 60)
    except (TypeError, ValueError):
        return 10**9


def _fmt_reset(epoch) -> str:
    """Compact time-to-reset suffix, e.g. ' (↻45m)'; empty when unknown."""
    if not epoch:
        return ""
    mins = _mins_until(epoch)
    if mins >= 10**9:
        return ""
    if mins <= 0:
        return " (↻now)"
    if mins < 100:
        return f" (↻{mins}m)"
    if mins < 48 * 60:
        return f" (↻{mins // 60}h{mins % 60:02d}m)"
    return f" (↻{mins // 1440}d{(mins % 1440) // 60}h)"


def _overage_suffix(acct_id: str, meter: str, acct_overage) -> str:
    """The ⛔ REAL-MONEY stop-posture suffix for an at-cap billable account (HED-443). `acct_overage`
    is True (declared on) or None (unknown — treated as billing until the operator declares it off)."""
    if acct_overage is True:
        return (f"⛔ REAL MONEY: OVERAGE BILLING ACTIVE on {acct_id} ({meter} ≥100%) — "
                "MINIMIZE TURNS: every token is billed now; finish the in-flight step, then HOLD for rotation")
    return (f"⛔ REAL MONEY? {acct_id} {meter} ≥100% and overage posture UNKNOWN — treat as billing: "
            "MINIMIZE TURNS and confirm/rotate (declare overageEnabled in ~/.heddle/accounts.json to silence if this account cannot bill)")


def _active_claude_cap(home: str) -> str:
    """Claude-cap fragment for THE ACCOUNT THIS PROCESS RUNS ON (HED-262).

    The per-turn line must reflect the running session's OWN account, resolved from
    $CLAUDE_CONFIG_DIR — not `~/.heddle/usage/claude.json`, which is the
    last-session-that-rendered fallback (a DIFFERENT account) and made the number bounce
    (2% / 28% / 84% across turns while a session sat on ONE account). Resolution:
    canonicalize $CLAUDE_CONFIG_DIR (unset = the default ~/.claude) and match it to
    `~/.heddle/accounts.json` claude[].configDir (null = that default) → id; then read
    `~/.heddle/usage/claude-<id>.json`. NAMES the resolved account as its own regression
    guard, and fails LOUD ("unresolved (fix me)") rather than ever silently reporting a
    different account's number."""
    default_dir = os.path.realpath(os.path.join(home, ".claude"))
    ccd = os.environ.get("CLAUDE_CONFIG_DIR")
    want = os.path.realpath(os.path.expanduser(ccd)) if ccd else default_dir
    reg = os.path.join(home, ".heddle", "accounts.json")
    if not os.path.exists(reg):
        return " · Claude 5h: unresolved (no account registry — fix me)"
    acct_id = None
    acct_overage = None  # operator-declared extra-usage posture: True/False/None(=unknown), HED-443
    for a in (_load_json(reg).get("claude") or []):
        cd = a.get("configDir")
        adir = default_dir if cd is None else os.path.realpath(os.path.expanduser(cd))
        if adir == want:
            acct_id = a.get("id")
            ov = a.get("overageEnabled")
            acct_overage = ov if isinstance(ov, bool) else None
            break
    if not acct_id:
        return f" · Claude 5h: unresolved account ({os.path.basename(want)} — fix me)"
    cap_file = os.path.join(home, ".heddle", "usage", f"claude-{acct_id}.json")
    if not os.path.exists(cap_file):
        return f" · {acct_id} 5h: no capture yet"
    d = _load_json(cap_file)
    rl = d.get("rate_limits") or {}
    fh = rl.get("five_hour") or {}
    sd = rl.get("seven_day") or {}
    up5, rs5 = fh.get("used_percentage"), fh.get("resets_at")
    up7, rs7 = sd.get("used_percentage"), sd.get("resets_at")
    if up5 is None:
        # Flat top-level `used` (keeper / flat captures) — 5h only, no resets;
        # same fallback the drawer reader uses (codeant, HED-262 review).
        up5 = d.get("used")
    if up5 is None:
        # 5h capture missing — but a billable 7d meter at/over cap is still real money, not merely
        # "unresolved" (HED-443 review, ledger 856 finding 3).
        if up7 is not None and int(up7) >= 100 and acct_overage is not False:
            return f" · {acct_id} 5h unresolved · 7d {int(up7)}% USED — {_overage_suffix(acct_id, '7d', acct_overage)}"
        return f" · {acct_id} 5h: unresolved (no usage — fix me)"
    line = f" · {acct_id} 5h {int(up5)}% USED{_fmt_reset(rs5)}"
    if up7 is not None:
        line += f" · 7d {int(up7)}% USED{_fmt_reset(rs7)}"
    # ⛔ Overage safeguard (HED-443, the 2026-08-29 real-money incident): at/over 100% on an account
    # whose extra-usage is ENABLED or UNKNOWN, the cap is a BILLING threshold, not a free floor — so the
    # doctrine flips from "keep working / never slow down" to "MINIMIZE TURNS." Only an account the
    # operator has DECLARED overage-off (accounts.json overageEnabled:false) keeps the normal path (there
    # 100% is a genuine hard stop, no billing). Reset timing is irrelevant here: billing is happening NOW.
    up7i = int(up7) if up7 is not None else None
    over_cap = int(up5) >= 100 or (up7i is not None and up7i >= 100)
    if over_cap and acct_overage is not False:
        which = "7d" if (up7i is not None and up7i >= 100) else "5h"
        return f"{line} — {_overage_suffix(acct_id, which, acct_overage)}"
    # Escalation doctrine (Maya 2026-08-21, after a 5h meter 23 minutes from
    # reset nearly ended an agent's night): usage is auto-managed by rotation —
    # the ONLY flag-worthy state is a meter ≥97%, and for the 5h meter only
    # when its reset is >30 min out (or unknown).
    alert5 = int(up5) >= 97 and (rs5 is None or _mins_until(rs5) > 30)
    alert7 = up7 is not None and int(up7) >= 97
    if alert7 or alert5:
        which = "7d" if alert7 else "5h"
        line += f" — ⚠️ {which} ≥97%: TELL MAYA NOW (needs rotation) and keep working"
    else:
        line += " — usage auto-managed (rotation); never slow down over it"
    return line


def delegation_nudge(label: str) -> str:
    """Per-turn heddle reinforcement (Maya 2026-08-15: 'most work with the least usage').

    Reads the heddle dispatch ledger for THIS agent's dispatches in the last 2h and the
    live shared Claude cap from the statusline tap, and returns a one-line, data-driven
    nudge. Zero dispatches → loud reminder; otherwise a compact scoreboard. Best-effort
    (≤~50ms, no network): any failure returns "" so it can never break a turn."""
    try:
        import sqlite3
        home = os.path.expanduser("~")
        n = None
        led = os.path.join(home, ".heddle", "ledger.db")
        mix = ""
        if os.path.exists(led):
            con = sqlite3.connect(f"file:{led}?mode=ro", uri=True, timeout=0.2)
            try:
                n = con.execute(
                    "SELECT COUNT(*) FROM dispatches WHERE orchestrator=? "
                    "AND started_at >= datetime('now','-2 hours')", (label,)).fetchone()[0]
                # Provider mix over 8h: monoculture is the anti-goal (Maya 2026-08-17: "the entire
                # point of this whole build" is spreading labor across Cursor/Gemini/Codex pools).
                rows = con.execute(
                    "SELECT provider, COUNT(*) FROM dispatches WHERE orchestrator=? "
                    "AND started_at >= datetime('now','-8 hours') GROUP BY provider", (label,)).fetchall()
                if rows:
                    by = {p: c for p, c in rows}
                    parts = [f"{p} {by[p]}" for p in sorted(by, key=by.get, reverse=True)]
                    mix = " · 8h mix: " + " / ".join(parts)
                    total8 = sum(by.values())
                    if by.get("codex", 0) == total8 and total8 >= 3:
                        mix += " — MONOCULTURE: route by task CLASS (scaffold→cursor, docs→gemini, review→grok), not direct:codex"
                    elif by.get("cursor", 0) == 0 and by.get("gemini", 0) == 0 and total8 >= 5:
                        mix += " — cursor+gemini idle: prefer class routing over direct provider picks"
            finally:
                con.close()
        # Per-turn Claude cap for THIS process's account (HED-262: was reading
        # claude.json, the last-rendered fallback = a DIFFERENT account, so the number
        # bounced across turns). Say USED + free explicitly ("5h cap 9%" was misread as
        # 9%-remaining fleet-wide, Maya 2026-08-19); the account is NAMED as a
        # regression guard. A cap-read failure must never break the turn, so it degrades
        # to a loud marker, never a wrong number.
        try:
            cap = _active_claude_cap(home)
        except Exception:
            cap = " · Claude 5h: unresolved (read error — fix me)"
        if n is None:
            return ""
        if n == 0:
            return (f"⟢ ⚠️ DELEGATION: you have dispatched 0 workers in the last 2h{cap}. Orchestrator turns are for "
                    f"judgment; LABOR (scaffolds, tests, ports, docs, research, mechanical edits) goes to "
                    f"`mcp__heddle__dispatch_worker` (agent=\"{label}\"; `list_task_classes` for routes). "
                    f"Before hand-writing code, ask: could a worker do this from my spec? ")
        return f"⟢ delegation: {n} worker dispatch(es) last 2h{cap}{mix} — keep labor on workers, judgment on the orchestrator. "
    except Exception:
        return ""


def _claude_ancestor_pid() -> int:
    """The hosting claude process's pid — bounded wrapper-aware ancestor walk.

    Command hooks may run under a shell wrapper, so os.getppid() can name the wrapper while the
    comms channel-server (a DIRECT child of claude) keys the bridge on claude's pid (on-PR round,
    #44). Same semantics as agent-preflight.py's find_claude_parent; falls back to os.getppid()
    when no claude ancestor is found within 4 hops (fail-soft: worst case the bridge stays unbound,
    exactly as before)."""
    try:
        pid = os.getppid()
        for _ in range(4):
            argv = None
            try:
                with open(f"/proc/{pid}/cmdline", "r", errors="replace") as fh:
                    argv = fh.read().replace("\0", " ")
            except Exception:
                try:
                    r = subprocess.run(["/bin/ps", "-ww", "-o", "command=", "-p", str(pid)],
                                       capture_output=True, text=True, timeout=1)
                    argv = r.stdout.strip() if r.returncode == 0 else None
                except Exception:
                    argv = None
            if argv and re.match(r"(?:\S*/)?claude(?:\.exe)?(?:\s|$)", argv.lstrip()):
                return pid
            try:
                r = subprocess.run(["/bin/ps", "-o", "ppid=", "-p", str(pid)],
                                   capture_output=True, text=True, timeout=1)
                parent = int(r.stdout.strip()) if r.returncode == 0 and r.stdout.strip() else 0
            except Exception:
                parent = 0
            if not parent or parent == pid:
                break
            pid = parent
    except Exception:
        pass
    return os.getppid()


COMMS_DB = os.path.expanduser("~/.heddle/comms.db")
_PENDING_COMMS_HWM = None  # (path, value) staged by comms_unread_nudge; committed by emit() ONLY
                           # when the 📬 line is actually part of the emitted context (review: an
                           # advance-before-emit lost nudged ids forever when a later step failed).


def comms_unread_nudge(label: str) -> str:
    """HED-387: pull-mode visibility. Counts DIRECT messages to `label` that the broker never
    live-injected (no deliveries row with transport='channel' AND code='channel-written' — the
    broker's own delivered-live test, log.ts), NEW since this hook's last turn (a high-water mark
    in the identity cache, so the nudge drains once surfaced). Read-only; every failure is silent —
    a nudge must never cost a prompt."""
    global _PENDING_COMMS_HWM
    try:
        if not label or not os.path.exists(COMMS_DB):
            return ""
        import sqlite3
        hwm_file = IDENTITY_CACHE / f"comms-hwm-{label}"
        con = sqlite3.connect(f"file:{COMMS_DB}?mode=ro", uri=True, timeout=0.3)
        try:
            if not hwm_file.exists():
                # First labeled turn: SEED at the current tip, silently — never scan history
                # (review: hwm=0 walked every historic row; the nudge is for NEW mail only).
                tip = con.execute("SELECT COALESCE(MAX(id), 0) FROM messages").fetchone()[0]
                try:
                    IDENTITY_CACHE.mkdir(parents=True, exist_ok=True)
                    hwm_file.write_text(str(tip))
                except Exception:
                    pass
                return ""
            try:
                hwm = int(hwm_file.read_text().strip())
            except Exception:
                # Corrupt mark: RE-SEED at the tip (round-2 review: returning forever left the
                # nudge dead with no recovery; the unknown window is unrecoverable either way).
                tip = con.execute("SELECT COALESCE(MAX(id), 0) FROM messages").fetchone()[0]
                try:
                    hwm_file.write_text(str(tip))
                except Exception:
                    pass
                return ""
            # One statement = one snapshot: qualifying count/max AND the overall tip together.
            n, mx, tip = con.execute(
                "SELECT COUNT(*), COALESCE(MAX(m.id), 0), "
                "(SELECT COALESCE(MAX(id), 0) FROM messages) FROM messages m "
                "WHERE m.target = ? AND m.sender <> ? AND m.id > ? "
                "AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.message_id = m.id "
                "AND d.transport = 'channel' AND d.outcome = 'sent' AND d.code = 'channel-written')",
                (label, label, hwm)).fetchone()
        finally:
            con.close()
        if not n:
            if tip < hwm:
                # The db was replaced/restored with a LOWER id sequence (on-PR round): the stale
                # mark would disable the nudge until ids caught up — re-seed at the new tip.
                try:
                    hwm_file.write_text(str(tip))
                except Exception:
                    pass
                return ""
            # Nothing to show: advance the mark to the tip directly (round-2 review: leaving it
            # meant every turn re-scanned the growing delivered/nonqualifying tail). Safe — no
            # qualifying row ≤ tip exists in this snapshot, so nothing showable is skipped.
            if tip > hwm:
                try:
                    hwm_file.write_text(str(tip))
                except Exception:
                    pass
            return ""
        _PENDING_COMMS_HWM = (hwm_file, str(mx))  # committed by emit() iff the line is shown
        return (f"⟢ 📬 COMMS: {n} message(s) addressed to {label} arrived WITHOUT live injection "
                f"(pull mode or pre-wiring) — run check_inbox before other work. ")
    except Exception:
        return ""


OPERATOR_MODE_PATH = os.path.expanduser("~/.heddle/operator-mode.json")


def operator_mode_block() -> str:
    """HED-336 carrier: turn the host-side operator mode (~/.heddle/operator-mode.json, written by
    `heddle mode` / the pocket console / the desktop app) into a SHORT per-turn directive block.

    `desktop` — and ANY absent/unreadable/malformed/unknown state — injects NOTHING: that is today's
    behavior, and a broken file must never silently escalate the fleet into mobile/away. `mobile` and
    `away` inject headline directives only; the full doctrine lives in
    .claude/rules/operator-modes.md. Robust by construction — any failure returns "" (this rides the
    per-turn hot path for every agent and must never raise)."""
    try:
        with open(OPERATOR_MODE_PATH, encoding="utf-8") as handle:
            mode = json.load(handle).get("mode")
    except Exception:
        return ""
    if mode == "mobile":
        return (
            "⟢ OPERATOR MODE: MOBILE — Maya is on the pocket console (her phone). Decisions: only "
            "when genuinely stalled, and ONLY via AskUserQuestion (structured option cards) — never a "
            "free-text question buried in a transcript she cannot see; non-stalling questions go to an "
            "async needs-maya comment. Keep operator-facing messages phone-sized (headline + one-line "
            "options; long reports live on tickets/docs with a link). Screenshots over prose for any "
            "UI-visible work. Prompts are phone interrupts — prefer allowlisted/auto-allowed ops, "
            "batch every prompt-needing step into one turn, sequence them LAST (keep-moving §9). "
            "Full doctrine: .claude/rules/operator-modes.md. "
        )
    if mode == "away":
        return (
            "⟢ OPERATOR MODE: AWAY — Maya is away: only URGENT interrupts reach her now (permission "
            "blocks, needs-clear); everything else digests or parks until she is back — never idle "
            "waiting. Otherwise the MOBILE discipline applies (decisions via AskUserQuestion only when "
            "stalled, phone-sized messages, prompt hygiene §9). Full doctrine: "
            ".claude/rules/operator-modes.md. "
        )
    return ""  # desktop or any unknown value → no block (today's behavior)


def main() -> None:
    label = None  # resolved inside the try; the failure fallback gates the SCOPE line on it
    try:
        # stdin carries session_id (for the fleet-identity lookup); prompt text unused.
        try:
            payload = json.load(sys.stdin)
        except Exception:
            payload = {}
        label = fleet_label(payload.get("session_id") or "",
                            payload.get("transcript_path") or "")
        if label:
            try:
                # HED-387: pid bridge — the comms channel-server is a child of this same claude
                # process; an unbound (hand-created) session binds lazily from this file, so a
                # /rename connects to comms by the very next message. Refreshed every turn.
                IDENTITY_CACHE.mkdir(parents=True, exist_ok=True)
                (IDENTITY_CACHE / f"pid-{_claude_ancestor_pid()}.label").write_text(label)
            except Exception:
                pass
        # SCOPE — first, every turn, every session in every repo that bridges this hook (Maya,
        # firsthand 2026-08-23, absolute): this fleet is heddle-only; the Spinventory app repo is
        # never touched. Precedes identity so it is read even by an unlabeled session.
        scope_line = SCOPE_LINE if (not label or label in HEDDLE_FLEET) else ""
        id_line = (scope_line + "\n" if (scope_line and label) else scope_line) + (
            f"⟢ You are Agent {label} (fleet identity — sign as '[Agent {label}]', "
            f"lin.sh --agent {label}). Use Memtrace FIRST for code discovery, impact, and "
            f"history — find_symbol / find_code before grep/glob/read (Commandment #2; "
            f"Serena's symbol tools are the approved complement). " if label else ""
        )
        if label:
            # HED-336: operator-mode overlay first — "Maya is on her phone / away" reframes how every
            # directive below is carried out. Empty in desktop mode, so it costs nothing normally.
            id_line += operator_mode_block()
            id_line += comms_unread_nudge(label)
            id_line += delegation_nudge(label)
            # KEEP MOVING — baked into the per-turn line (Maya, firsthand 2026-08-22): with
            # ~7 HED + ~17 SPI tabs she cannot babysit every turn-end, and agents were
            # hedging ("good stopping point", "let me know if you want me to continue"),
            # parking work for hours. Rules this enforces: keep-moving.md §1 (blocked ≠
            # idle), §4 (hedging ban), §6 (only Maya's wrap/pause/hold stops), §8
            # (context-drift → flag+land, not grind) + needs-maya.md (retained classes →
            # flag + park THAT item, keep going on others). The rules file isn't re-read
            # at turn-end; this hook fires on EVERY message, so the line rides here for
            # every labeled fleet agent. Wording tightened per pre-PR review (ledger 405)
            # and the on-PR round (codeant/codex P1s): context-drift is its OWN clause —
            # §8 reconciles flag-and-keep-working as park-the-drift-item + mechanical/
            # reversible work only until the /clear, so "GO" can never read as
            # grind-on-degraded or proceed-through-Maya-gates. MONITORS line: Maya,
            # firsthand 2026-08-22 ("timers as backup, monitors as default") = §10.
            # Keep it short — it costs every turn, fleet-wide.
            # Heddle fleet: "list" means the HED board only (fleet-scope.md; lin.sh defaults to SPI).
            next_src = ("follow-ups→mine→`LIN_TEAM=HED lin.sh list` (HED board ONLY)→R"
                        if label in HEDDLE_FLEET else "follow-ups→mine→list→orchestrator")
            id_line += (
                "⟢ KEEP MOVING: never hedge at turn-end (no 'stopping point'/'continue?'/"
                f"'up to you'). Finish→next ({next_src}; resume-day: "
                "untriaged PR slate first). Blocked≠idle: park+watcher, take other work. "
                "Stop only on Maya's wrap/pause/hold. needs-maya / retained-class: flag, "
                "park that item, GO on the next — not a halt. Context-drift: flag 🧹, land+push, "
                "then MECHANICAL/reversible work only (no retained-class or merge actions) "
                "until Maya's /clear (§8). "
                "⟢ MONITORS DEFAULT: wait on events (reviews/CI/gate/dispatches) with a "
                "watcher/notification — pr-watch.sh in a read-only Monitor; dispatches notify "
                "on exit — never sleep-poll as the primary wait; a timer is only the long-stop "
                "BACKUP for a watcher that can hang (Maya 2026-08-22, §10). "
            )

        if not os.path.exists(PR_OWN):
            emit(id_line or None)

        top = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, timeout=3,
        )
        if top.returncode != 0 or not top.stdout.strip():
            emit(id_line or None)  # not in a git repo → identity only
        toplevel = top.stdout.strip()
        owner = worktree_owner(toplevel)

        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        cache = CACHE_DIR / f"{owner}.txt"
        stamp = CACHE_DIR / f"{owner}.stamp"

        fresh = stamp.exists() and (time.time() - stamp.stat().st_mtime) < TTL_SECS
        if not fresh:
            # Debounce first (reset the window BEFORE spawning) so concurrent turns
            # don't each spawn a refresh, then fire a detached, non-blocking refresh.
            stamp.touch()
            tmp = f"{cache}.{os.getpid()}.tmp"
            try:
                # HED-191: run the refresh via an argv list (no shell) so a worktree/dir name (or
                # PR_OWN) with shell metacharacters can't inject. The old shell-interpolated pipeline
                # (> tmp && mv || rm) becomes a detached, ISOLATED python -c helper: os.replace on
                # success, unlink on failure. Two hardening points (grok review): the helper runs with
                # -I (isolated) and cwd=CACHE_DIR — NOT the worktree root — so a malicious `subprocess.py`
                # planted in a checkout can never reach sys.path[0]; toplevel is passed as argv and used
                # only as the cwd of the inner `pr-own.sh` run (which needs the git root).
                subprocess.Popen(
                    [sys.executable, "-I", "-c",
                     "import subprocess,sys,os\n"
                     "own,tmp,cache,top=sys.argv[1],sys.argv[2],sys.argv[3],sys.argv[4]\n"
                     "try:\n"
                     "    with open(tmp,'wb') as f:\n"
                     "        rc=subprocess.run([own,'mine'],stdout=f,stderr=subprocess.DEVNULL,cwd=top).returncode\n"
                     "    if rc==0:\n"
                     "        os.replace(tmp,cache)\n"
                     "    else:\n"
                     "        os.unlink(tmp)\n"
                     "except Exception:\n"
                     "    try:\n"
                     "        os.unlink(tmp)\n"
                     "    except OSError:\n"
                     "        pass\n",
                     str(PR_OWN), str(tmp), str(cache), str(toplevel)],
                    cwd=str(CACHE_DIR), start_new_session=True,
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                )
            except Exception:
                pass

        if not cache.exists():
            emit(id_line or None)  # first run — background refresh populates next turn

        owned = [ln.strip() for ln in cache.read_text().splitlines() if ln.strip().startswith("#")]
        if not owned:
            emit(id_line or None)  # no owned PRs — identity only

        listing = "; ".join(owned)
        ctx = (
            f"{id_line}"
            f"⟢ PR ownership (worktree '{owner}'): you currently own {len(owned)} open "
            f"PR(s) — {listing}. Drive each to green + merged, or release it "
            f"(.claude/bin/pr-own.sh release <n>) — don't strand it. While one is open, keep a "
            f"READ-ONLY Monitor armed for new reviews/threads + the `gate` result and address "
            f"findings as they land — don't go idle waiting to be poked (see the WATCH section of "
            f".claude/rules/pr-review-sweep.md). Before you push to, "
            f"comment on, resolve a thread on, or merge any PR you did NOT open this "
            f"session, run `.claude/bin/pr-own.sh check <n>` and stand down if it's "
            f"another instance's fresh claim. (see .claude/rules/pr-ownership.md)"
        )
        emit(ctx)
    except Exception:
        # Never block or slow a prompt over a reminder — but the SCOPE line must survive any failure
        # for a heddle-fleet or still-unknown session. A label already resolved to the Spinventory
        # fleet (A–Q, digits) gets NOTHING here — never a heddle-only directive (on-PR round, #38).
        try:
            if not label or label in HEDDLE_FLEET:
                print(json.dumps({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit",
                                                         "additionalContext": SCOPE_LINE.strip()}}))
        except Exception:
            pass
        sys.exit(0)


if __name__ == "__main__":
    main()
