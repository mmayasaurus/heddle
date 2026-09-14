#!/usr/bin/env python3
"""Pure code-scanning classification helpers for pr-sweep.sh (SPI-924)."""

import json
import sys


def is_not_enabled_error(error_text: str) -> bool:
    """Whether GitHub's error text means code scanning is genuinely UNAVAILABLE on this repo.

    This is the ONLY benign pass-by-silence signal (SPI-924), so it must be tight in BOTH
    directions:
      - Too broad → a transient/other error passes the sweep with no real scan (fail-OPEN, the
        original bug). So we REQUIRE the text to be about code scanning / (advanced) security AND
        to say that feature is unavailable, and we exclude look-alikes:
          * "no analysis found" — GitHub's CodeScanningNoAnalysisFound (404): scanning IS in play,
            results are merely absent (SARIF not uploaded yet, analysis deleted, wrong ref). NOT
            benign — a heddle repo that uploads SARIF must fail CLOSED here, not pass.
          * "resource not accessible ..." — a token/permission problem, not a not-enabled repo.
          * another feature's "not enabled" (secret scanning, Dependabot, Actions) — the feature
            gate below is what excludes these.
      - Too narrow → a repo that genuinely lacks code scanning fail-CLOSES forever (freezing
        merges), so we match GitHub's documented phrasings: not/must-be/not-been enabled, disabled.
    HTTP status is deliberately ignored — a rate-limit is also HTTP 403.
    """
    text = " ".join((error_text or "").lower().split())
    # Gate 1: the error must be ABOUT code scanning / (advanced) security — never another feature,
    # a permissions error, or a "no results" (no-analysis-found) response.
    if not ("code scanning" in text or "code security" in text or "advanced security" in text):
        return False
    # Gate 2: ... and that feature must be stated UNAVAILABLE, in any of GitHub's documented forms.
    return (
        "not enabled" in text
        or "must be enabled" in text
        or "not been enabled" in text
        or "is disabled" in text
        or "has been disabled" in text
        or "disabled by policy" in text
    )


def classify_cs(status: str, cs_json: str):
    """Return (alerts, unavailable, error) for a code-scanning API outcome.

    ONLY an explicit ``ok`` status parses the JSON; ``notenabled`` passes by silence; EVERYTHING
    else — ``error``, empty, or any unrecognized status — fails CLOSED (SPI-924). An unknown status
    must never be trusted as a clean scan, so the JSON is parsed only when the shell explicitly
    reported success.
    """
    normalized_status = (status or "").strip().lower()
    if normalized_status == "notenabled":
        return [], True, False
    if normalized_status == "ok":
        try:
            parsed = json.loads(cs_json) if (cs_json or "").strip() else None
        except (TypeError, ValueError):
            parsed = None
        if isinstance(parsed, list):
            return parsed, False, False
        return [], False, True  # ok status but malformed/empty body → fail closed
    # "error", empty, or any unrecognized status → fail closed
    return [], False, True


def _main(argv):
    """Minimal shell bridge: exit 0 only for the benign not-enabled signal."""
    if len(argv) == 3 and argv[1] == "is-not-enabled":
        try:
            with open(argv[2], "r") as error_file:
                error_text = error_file.read()
        except OSError:
            return 1
        return 0 if is_not_enabled_error(error_text) else 1
    print("usage: pr_sweep_cs.py is-not-enabled <error-file>", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(_main(sys.argv))
