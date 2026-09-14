#!/usr/bin/env python3
"""One-pass inbound watcher for the needs-Maya decision pipeline.

Integrity design: the broker relay is a POINTER, not the authority — the
flagging agent re-reads Maya's own Linear comment directly before acting; this
watcher only detects + records. Every mutating step (--ack) INDEPENDENTLY
re-derives the decision from Linear and cross-checks the caller's claim before
it touches the ledger or clears a label; it never mutates on trust.
"""
import argparse
import importlib.machinery
import importlib.util
import os
import pathlib
import shutil
import subprocess
import sys
from datetime import datetime, timezone


SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
LIN_PATH = SCRIPT_DIR / "lin.sh"
if not LIN_PATH.is_file():
    raise RuntimeError(f"needs-maya-watch: missing required sibling {LIN_PATH}")
_loader = importlib.machinery.SourceFileLoader("spinventory_lin", str(LIN_PATH))
_spec = importlib.util.spec_from_file_location("spinventory_lin", LIN_PATH, loader=_loader)
if _spec is None or _spec.loader is None:
    raise RuntimeError(f"needs-maya-watch: cannot import required sibling {LIN_PATH}")
lin_module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(lin_module)

Lin = lin_module.Lin
NEEDS_MAYA = lin_module.NEEDS_MAYA
read_needs_maya_queue = lin_module.read_needs_maya_queue
resolve_agent = lin_module.resolve_agent
short = lin_module.short
write_needs_maya_queue = lin_module.write_needs_maya_queue

# The operator (Maya), pinned by stable Linear user id + email so the Linear system integration user
# (…@linear.linear.app) and any other workspace member are never mistaken for a ruling.
OPERATOR_ID = "e4d1cb89-bda6-47bf-82d0-ae1c918d39eb"
OPERATOR_EMAIL = "maya@verygoodfibergoods.com"
MARKER_PREFIX = "🔶 DECISION NEEDED"
ISSUE_PAGE = 250  # Linear's max page; a needs-maya decision queue is never remotely this deep
STATE_DIR = pathlib.Path(os.path.expanduser(
    os.environ.get("NEEDS_MAYA_WATCH_STATE_DIR", "~/.claude/spinventory-fleet/needs-maya-watch")))
NOTIFIED_SEEN = STATE_DIR / "notified.seen"
ACTED_SEEN = STATE_DIR / "acted.seen"

# The needs-maya label is WORKSPACE-level, so find flagged issues by NAME across all teams.
ISSUES_QUERY = """query($n:Int!){ issues(filter:{labels:{name:{eq:"needs-maya"}}}, first:$n){ nodes{
  id identifier url title team{key}
  labels{ nodes{ id name } }
  comments(last:50){ nodes{ id createdAt body user{ id name email } } }
}}}"""

ISSUE_QUERY = """query($id:String!){ issue(id:$id){
  id identifier url title
  labels{ nodes{ id name } }
  comments(last:50){ nodes{ id createdAt body user{ id name email } } }
} }"""

DECISIONS_HEADER = """# DECISIONS.md — operator rulings ledger

Append-only. Each entry is one ratified decision from Maya (the operator), recorded VERBATIM.
Auto-appended by `.claude/bin/needs-maya-watch.sh --ack` when a needs-maya flag is resolved; may
also be added by hand for rulings that did not come through the needs-maya pipeline.

Format (one entry per ruling):

    ## YYYY-MM-DD — <issue-id> <topic>

    > Maya's exact words, quote-blocked, never paraphrased.

    Context: <one line>
    Source: <Linear issue URL> (comment <id>)
    <!-- src:<comment-id> -->

Doctrine (Maya, 2026-08-21): "our channel IS the notification system; Linear is only the durable record."

---
"""


def decisions_path():
    override = os.environ.get("NEEDS_MAYA_DECISIONS_PATH")
    if override:
        return pathlib.Path(override)
    try:
        root = subprocess.run(
            ["git", "-C", str(SCRIPT_DIR), "rev-parse", "--show-toplevel"],
            check=True, capture_output=True, text=True,
        ).stdout.strip()
        if root:
            return pathlib.Path(root) / "DECISIONS.md"
    except Exception:
        pass
    return SCRIPT_DIR.parent.parent / "DECISIONS.md"


DECISIONS_PATH = decisions_path()


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


def maya_comment(comment):
    """True only for a comment authored by the operator (Maya), pinned by stable Linear user id or
    email. NOT "any human": the workspace also carries a Linear system integration user
    (…@linear.linear.app) and could gain other members — none of them may record or clear a ruling.
    Fails closed on a null user. NEEDS_MAYA_OPERATOR_EMAIL overrides the pin with an exact email match
    (deployment override + test hook)."""
    user = comment.get("user")
    if not user:
        return False
    email = (user.get("email") or "").strip()
    override = (os.environ.get("NEEDS_MAYA_OPERATOR_EMAIL") or "").strip()
    if override:
        return email == override
    return user.get("id") == OPERATOR_ID or email.lower() == OPERATOR_EMAIL


def newest(comments):
    return max(comments, key=lambda comment: comment.get("createdAt") or "")


def markers_of(comments):
    return [c for c in comments if (c.get("body") or "").startswith(MARKER_PREFIX)]


def derive(issue, queue_by_issue):
    """Return (cutoff, marker, newest_decision) for a labeled issue, or (None, None, None) if it
    is not a real flag (no marker AND no queue row — e.g. a Maya self-label, or a flag whose marker
    post failed). The cutoff is the marker's timestamp, falling back to the queue row's flag `ts`
    when the marker has aged out of the comment window, so Maya's (recent) ruling is never silently
    dropped. newest_decision is the most recent operator comment strictly after the cutoff."""
    comments = issue["comments"]["nodes"]
    ms = markers_of(comments)
    marker = newest(ms) if ms else None
    qentry = queue_by_issue.get(issue["identifier"])
    if marker:
        cutoff = marker["createdAt"]
    elif qentry and qentry.get("ts"):
        cutoff = qentry["ts"]
    else:
        return None, None, None
    decisions = [c for c in comments
                 if (c.get("createdAt") or "") > cutoff and maya_comment(c)]
    return cutoff, marker, (newest(decisions) if decisions else None)


def _osascript_notify(identifier, title):
    # AppleScript strings: escape backslash first, then double-quote, so a value containing " or \
    # cannot break out of the literal. Reliable delivery on stock macOS, but respects Do Not
    # Disturb and is NOT clickable (osascript display-notification has no click action).
    msg = short(title, 120).replace("\\", "\\\\").replace('"', '\\"')
    subj = identifier.replace("\\", "\\\\").replace('"', '\\"')
    subprocess.run(
        ["osascript", "-e",
         f'display notification "{msg}" with title "needs-Maya" subtitle "{subj}" sound name "Glass"'],
        check=True, timeout=10)


def notify(issue):
    """Fire ONE native macOS notification. Return True only on a clean exit — the caller records
    the dedup key only then, so a notifier failure is retried next poll rather than silently
    swallowing Maya's primary alert.

    Default path is osascript: it delivers reliably on stock macOS. Set NEEDS_MAYA_NOTIFIER=
    terminal-notifier to use terminal-notifier instead — it adds a clickable Linear deep link
    (-open), a sound, and pierces Do Not Disturb (-ignoreDnD), but macOS SILENTLY DROPS its
    notifications until its .app is granted permission in System Settings > Notifications, and it
    exits 0 either way (so its "success" cannot be trusted as delivery) — hence opt-in, not default.
    Both paths are bounded by a timeout so a hung notifier (observed with -sender) cannot wedge the
    poll."""
    identifier, title, url = issue["identifier"], issue["title"], issue["url"]
    mode = os.environ.get("NEEDS_MAYA_NOTIFIER", "osascript").strip().lower()
    try:
        if mode == "terminal-notifier" and shutil.which("terminal-notifier"):
            subprocess.run(
                ["terminal-notifier", "-title", "needs-Maya", "-subtitle", identifier,
                 "-message", short(title, 120), "-open", url, "-sound", "default", "-ignoreDnD"],
                check=True, timeout=10)
        else:
            _osascript_notify(identifier, title)
        return True
    except Exception as exc:
        print(f"[watch-error] notify {identifier} {exc}")
        return False


def drop_needs_maya_entry(issue_identifier):
    """Mirror lin.sh append_needs_maya_entry locking while removing one issue's queue row."""
    import fcntl  # POSIX-only; imported lazily (matches lin.sh) so module import never hard-crashes
    NEEDS_MAYA.parent.mkdir(parents=True, exist_ok=True)
    lock_path = NEEDS_MAYA.with_suffix(NEEDS_MAYA.suffix + ".lock")
    with lock_path.open("a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            entries = read_needs_maya_queue()
            write_needs_maya_queue(
                NEEDS_MAYA,
                [entry for entry in entries if entry.get("issue") != issue_identifier],
            )
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def quote_body(body):
    return "\n".join(f"> {line}" for line in body.split("\n"))


def append_decision(comment, issue, path):
    """Append one verbatim ruling under an exclusive lock. Idempotent: the per-comment sentinel is
    matched as a WHOLE, non-quoted line, so the same string quoted inside an earlier ruling body
    cannot cause a false 'already recorded' skip. The lock lives beside the state files (out of the
    repo) so concurrent --ack runs cannot duplicate an entry or race the header write."""
    import fcntl  # POSIX-only; imported lazily (matches lin.sh) so module import never hard-crashes
    sentinel = f"<!-- src:{comment['id']} -->"
    path.parent.mkdir(parents=True, exist_ok=True)
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    lock_path = STATE_DIR / "decisions.lock"
    with lock_path.open("a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            text = path.read_text() if path.exists() else ""
            if any(line.strip() == sentinel
                   for line in text.splitlines() if not line.startswith("> ")):
                return False
            created = datetime.fromisoformat(comment["createdAt"].replace("Z", "+00:00"))
            date = created.astimezone(timezone.utc).date().isoformat()
            entry = (
                f"## {date} — {issue['identifier']} {issue['title']}\n\n"
                f"{quote_body(comment['body'])}\n\n"
                f"Context: {issue['title']}\n"
                f"Source: {issue['url']} (comment {comment['id']})\n"
                f"{sentinel}\n"
            )
            with path.open("a") as ledger:
                if not text:
                    ledger.write(DECISIONS_HEADER)
                ledger.write("\n" + entry)
                ledger.flush()
                os.fsync(ledger.fileno())
            return True
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def watch(agent):
    # A failure here must be VISIBLE to a supervisor, never masked as a healthy poll: identity/
    # credential resolution (a config error) fails loudly by propagating, and a query error both
    # prints [watch-error] AND returns nonzero so a Monitor/cron wrapper can alert on it.
    lin = Lin(resolve_agent(agent))
    try:
        data = lin.gql(ISSUES_QUERY, {"n": ISSUE_PAGE})
    except Exception as exc:
        print(f"[watch-error] issues-query {exc}")
        return 1

    nodes = ((data or {}).get("issues") or {}).get("nodes") or []
    if len(nodes) >= ISSUE_PAGE:
        print(f"[watch-warn] labeled-issue count hit the {ISSUE_PAGE}-page cap — some may be unseen")
    notified = seen_keys(NOTIFIED_SEEN)
    acted = seen_keys(ACTED_SEEN)
    # Surface ONCE (not every poll) when the operator opted into terminal-notifier but it is not
    # installed, so the silent fall back to osascript (no clickable link, no DnD-pierce) is visible.
    if (os.environ.get("NEEDS_MAYA_NOTIFIER", "").strip().lower() == "terminal-notifier"
            and not shutil.which("terminal-notifier")
            and "warn:no-terminal-notifier" not in notified):
        print("[watch-warn] NEEDS_MAYA_NOTIFIER=terminal-notifier but it is not installed — using "
              "osascript (install: brew install terminal-notifier)")
        record_seen(NOTIFIED_SEEN, "warn:no-terminal-notifier")
        notified.add("warn:no-terminal-notifier")
    queue_by_issue = {e.get("issue"): e for e in read_needs_maya_queue() if e.get("issue")}
    for issue in nodes:
        cutoff, marker, decision = derive(issue, queue_by_issue)
        if cutoff is None:
            print(f"[watch-warn] issue={issue['identifier']} labeled-without-marker-or-queue "
                  "(skipping both legs)")
            continue
        qentry = queue_by_issue.get(issue["identifier"])
        # OUTBOUND: notify once per flag, keyed on a STABLE anchor — the queue row's flag ts when
        # present (it survives the marker aging out of the comment window), else the marker ts — so a
        # flag that arrived while the watcher was offline still alerts once, and never twice.
        anchor = (qentry.get("ts") if qentry and qentry.get("ts")
                  else (marker["createdAt"] if marker else None))
        if anchor:
            notify_key = f"notify:{issue['identifier']}:{anchor}"
            if notify_key not in notified and notify(issue):
                record_seen(NOTIFIED_SEEN, notify_key)
                notified.add(notify_key)
                print(f"[flag] issue={issue['identifier']} url={issue['url']}")
        # INBOUND: emit the newest un-acked operator decision. Never writes acted.seen — re-emitting
        # every poll until --ack is the intended at-least-once guarantee.
        if decision is None:
            continue
        act_key = f"act:{issue['identifier']}:{decision['id']}"
        if act_key in acted:
            continue
        agent_key = qentry.get("agent", "?") if qentry else "?"
        print(f"[decision] issue={issue['identifier']} agent={agent_key} "
              f"comment_id={decision['id']} url={issue['url']}")
    return 0


def ack(agent, issue_identifier, comment_id):
    act_key = f"act:{issue_identifier}:{comment_id}"
    if act_key in seen_keys(ACTED_SEEN):
        print(f"[ack] issue={issue_identifier} already-acted")
        return 0
    # Re-derive the decision from Linear and cross-check the caller's (issue, comment) claim before
    # any mutation — never trust the CLI args. This fails closed on a mismatched issue/comment, a
    # non-operator comment, or a STALER comment than the current newest ruling (a correction that
    # landed after the [decision] line was emitted): refuse, leave the flag up, let the next poll
    # re-emit the newer decision.
    lin = Lin(resolve_agent(agent))  # config error → fail loudly, not masked into a soft return
    try:
        data = lin.gql(ISSUE_QUERY, {"id": issue_identifier})
        issue = (data or {}).get("issue")
        if issue is None:
            raise RuntimeError(f"issue {issue_identifier} not found")
    except Exception as exc:
        print(f"[watch-error] ack-fetch {exc}")
        return 1

    queue_by_issue = {e.get("issue"): e for e in read_needs_maya_queue() if e.get("issue")}
    cutoff, _marker, decision = derive(issue, queue_by_issue)
    if cutoff is None:
        print(f"[watch-error] ack-validate issue={issue_identifier} is not a live flag "
              "(no marker and no queue row)")
        return 1
    if decision is None or decision["id"] != comment_id:
        got = decision["id"] if decision else "none"
        print(f"[watch-error] ack-stale issue={issue_identifier} newest-decision={got} "
              f"!= --comment {comment_id}; not clearing")
        return 1
    comment = decision

    try:
        append_decision(comment, issue, DECISIONS_PATH)
    except Exception as exc:
        print(f"[watch-error] ack-decisions {exc}")
        return 1

    # Remove EVERY label named needs-maya, not just the first — during the team→workspace migration an
    # issue can carry a legacy team-scoped one AND the workspace one; leaving either attached keeps the
    # issue in the watcher's query forever after its decision is acked.
    for lbl in [item for item in issue["labels"]["nodes"] if item.get("name") == "needs-maya"]:
        try:
            res = lin.gql("""mutation($id:String!,$lid:String!){ issueRemoveLabel(id:$id, labelId:$lid){ success } }""",
                          {"id": issue["id"], "lid": lbl["id"]})
        except Exception as exc:
            print(f"[watch-error] ack-removelabel {exc}")
            return 1
        # Linear can return a 200 with success=false; treat that as NOT cleared and abort before
        # dropping local state, so a stuck label cannot silently suppress future polls.
        if not (res or {}).get("issueRemoveLabel", {}).get("success"):
            print(f"[watch-error] ack-removelabel issue={issue_identifier} label={lbl['id']} "
                  "success=false — leaving flag up")
            return 1

    try:
        drop_needs_maya_entry(issue_identifier)
        record_seen(ACTED_SEEN, act_key)
    except Exception as exc:
        print(f"[watch-error] ack-record {exc}")
        return 1
    print(f"[ack] issue={issue_identifier} comment_id={comment_id} "
          "decisions-appended removed-label queue-dropped")
    return 0


def main():
    parser = argparse.ArgumentParser(description="One-pass needs-Maya decision watcher")
    parser.add_argument("--agent", help="fleet agent key; else $FLEET_AGENT or .fleet-agent")
    parser.add_argument("--ack", metavar="ISSUE-ID", help="acknowledge a relayed decision")
    parser.add_argument("--comment", metavar="COMMENT-ID", help="Linear decision comment ID for --ack")
    args = parser.parse_args()
    if args.ack and not args.comment:
        parser.error("--ack requires --comment COMMENT-ID")
    if args.comment and not args.ack:
        parser.error("--comment requires --ack ISSUE-ID")
    return ack(args.agent, args.ack, args.comment) if args.ack else watch(args.agent)


if __name__ == "__main__":
    sys.exit(main())
