"""Conservative DEMOTION (never dropping) of bot usage-cap notices for pr-sweep.sh.

SPI-898. Design is layered, after adversarial review (heddle ledger 297) demolished the
first "drop the noise" attempt with real counterexamples:

  We DEMOTE cap-notices to a collapsed but still-VISIBLE group — we never drop them. Dropping
  coupled safety to regex precision, which is unreachable: text classification always leaks
  ("preview skipped" contains "review skipped"; ".{0,N}" bridges negations like "never hit";
  product copy in a codebase that HAS billing/quota/token features matches the phrases). Demote
  makes "a real finding is never HIDDEN" a property of the architecture, not of the regex.

  Layer 0 — author allowlist: only known capped-review-bot logins are demotion candidates. This
    structurally removes every human / finding-bot / product-copy counterexample (they are never
    demoted regardless of text). A fresh allowlisted bot still posts real findings, so the
    allowlist narrows WHO, not WHAT — Layers 1-2 + demote-not-drop cover the rest.
  Layer 1 — CAP_NOTICE: strong bot-status phrases, negation-proof (the status verb attaches to
    the topic via whitelisted connectors only — no wildcard gap a "never" can bridge).
  Layer 2 — FINDING_MARKER: keeps anything finding-shaped (severity badge / file:line / real
    file path) in the MAIN flow even if a cap phrase matched.

  Residual, stated honestly: a FRESH allowlisted bot posting a real finding about cap-topic code
  lands DEMOTED-BUT-VISIBLE (in the group, skimmable, length-flagged) — never hidden.
"""

import re

# Layer 0 — REAL GitHub logins of bots that emit usage-cap notices. A typo here is a silent
# coverage bug (the notice would never be demoted), so these are the exact `login` strings the
# GitHub API returns, bot suffix included.
KNOWN_CAP_BOTS = frozenset({
    "codereviewbot-ai[bot]",
    "sourcery-ai[bot]",
    "gitar-bot[bot]",
    "what-the-diff[bot]",
})

# Real notices run 150-351 chars; a longer body from these bots likely carries more than a bare
# cap notice, so it stays in the main flow (safe — visible) rather than being demoted.
MAX_CAP_NOTICE_CHARS = 600

# Layer 1 — negation-proof: the status verb (exceeded/reached) attaches to the topic through a
# whitelisted connector set only. No ".{0,N}" wildcard, so "rate limit check never hit" and
# "quota is never exceeded" do NOT match. "hit" is dropped entirely (leakiest verb).
_STATUS = r"(?:(?:already|has(?:\s+been)?|have|was|is)\s+)?(?:exceeded|reached)"
CAP_NOTICE = re.compile(
    r"(?:"
    r"\breview\s+skipped"                                  # \b so "preview skipped" does NOT match
    r"|rate.?limit\s+" + _STATUS +                          # "rate limit (already) exceeded/reached"
    r"|reached\s+your\s+[^\n]{0,30}?limit"                  # sourcery "reached your weekly rate limit" (no newline span)
    r"|\d+\s+reviews?\s+per\s+\d+\s+hours?"                 # per-window review allowance
    r"|included\s+automatic\s+processing"
    r"|for\s+this\s+billing\s+period"
    r"|automatic\s+reviews\s+are\s+paused"
    r"|ran\s+out\s+of\s+(?:tokens|credits)"
    r"|unable\s+to\s+summarize"                             # what-the-diff
    r"|usage\s+(?:cap|limit)\s+" + _STATUS +
    r"|quota\s+" + _STATUS + r"|out\s+of\s+quota"
    r"|upgrade\s+to\s+a\s+paid\s+plan"
    r")",
    re.IGNORECASE,
)

# Layer 2 — finding-shaped signals that force a body to the MAIN flow even from an allowlisted
# bot. Badges include LOW/CRITICAL/BLOCKER (common bot severities) but NOT "WARNING" — what-the-
# diff's real body opens "> **Warning**" and adding it would regress that bot's demotion.
FINDING_MARKER = re.compile(
    r"(?:"
    r"\b(?:P[0-4]|INFO|LOW|MEDIUM|HIGH|CRITICAL|BLOCKER)\b"  # severity badges (NOT WARNING — see above)
    r"|\b[^\s:]+\.[A-Za-z0-9_+-]+:\s*\d+\b"                  # file.ext:12  (space after colon tolerated)
    r"|\b[\w-]+\.[A-Za-z0-9]+#L\d+\b"                        # foo.ts#L12  (GitHub permalink line ref)
    r"|(?:^|[\s'\"`(\[<])(?:\.{0,2}[\\/])?(?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_-]+\.[A-Za-z0-9]{1,8}\b"  # dir/file.ext path (anchors incl. [ and `)
    r"|\b[A-Za-z0-9_-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|sh|bash|rb|go|rs|java|kt|swift|c|h|cc|cpp|css|scss|html|json|ya?ml|toml|sql|md|txt)\b"  # bare filename w/ code ext
    r")",
    re.IGNORECASE | re.MULTILINE,
)


def is_cap_notice(login: str, body: str) -> bool:
    """A DEMOTION candidate — NOT a drop. True only for a known capped bot posting a short,
    strong, marker-free cap notice. Demotion still renders the body, so a wrong True here
    demotes-but-shows; the layers exist to keep the group accurate, not to gate visibility."""
    body = (body or "").strip()
    return (
        login in KNOWN_CAP_BOTS
        and bool(body)
        and len(body) <= MAX_CAP_NOTICE_CHARS
        and bool(CAP_NOTICE.search(body))
        and not FINDING_MARKER.search(body)
    )


def demoted_line(login: str, body: str, ts: str = "", kind: str = "", after: bool = False) -> str:
    """A demoted entry: a locator header (login + kind + timestamp + ⏰) followed by the FULL body,
    indented. The complete body is ALWAYS shown — never truncated to a first line — so a real finding
    bundled after cap chatter in a hybrid notice is never hidden or made unrecoverable. (The sweep is
    plain terminal output with no 'expand' mechanism and the fetched JSON is deleted on exit, so a
    first-line-plus-hint row could silently drop a tail finding — SPI-898 review, chatgpt-codex P1 /
    qodo.) The group cuts noise by GROUPING + labeling, not by hiding text; the metadata makes each
    row locatable on the PR timeline."""
    body = (body or "").strip()
    meta = "  ".join(x for x in (f"({kind})" if kind else "", ts) if x)
    flag = "  ⏰ AFTER last push" if after else ""
    header = f"   • {login}" + (f"  {meta}" if meta else "") + flag + ":"
    indented = "\n".join(f"       {ln}" for ln in body.splitlines()) if body else "       (empty)"
    return f"{header}\n{indented}"


def render_demoted(rows) -> str:
    """The demoted-group block: a header + each notice's FULL body. `rows` is an iterable of
    (login, body, after, ts, kind). Returns '' when empty. VISIBLE output — not an auto-clear; the
    header says to skim it, and every body is printed in full so nothing is hidden or unrecoverable."""
    rows = list(rows)
    if not rows:
        return ""
    logins = sorted({r[0] for r in rows})
    out = [
        f"── Demoted: {len(rows)} likely rate-limit/cap notice(s) from {len(logins)} bot(s) "
        f"(heuristic, NOT cleared — full bodies below; skim before declaring clean): {', '.join(logins)}"
    ]
    for login, body, after, ts, kind in rows:
        out.append(demoted_line(login, body, ts, kind, after))
    return "\n".join(out)
