#!/usr/bin/env python3
"""Regression fixtures for canonical pr-sweep.sh credit in require-pr-sweep."""

import importlib.util
import pathlib
import sys

_p = pathlib.Path(__file__).parent.parent / "require-pr-sweep.py"
_spec = importlib.util.spec_from_file_location("require_pr_sweep", _p)
if _spec is None or _spec.loader is None:
    raise RuntimeError(f"cannot load {_p}")
mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mod)

ALL_CHANNELS = {"comments", "reviews", "threads"}


def check(name, condition):
    if not condition:
        raise AssertionError(name)
    print(f"OK: {name}")


def check_sweep_invocation(name, cmd):
    check(f"{name} identifies PR 92", mod._pr_numbers(cmd) == {"92"})
    check_credits(f"{name} credits all channels", cmd, {"92": ALL_CHANNELS})


def check_credits(name, cmd, expected_dict):
    check(name, mod._credits(cmd) == expected_dict)


def main():
    check("no hook_utils dependency at import", "hook_utils" not in sys.modules)

    check_credits(
        "sweep credit stays with its own PR",
        "/Users/x/.claude/bin/pr-sweep.sh 92; gh pr view 93 --json comments",
        {"92": ALL_CHANNELS, "93": {"comments"}},
    )
    check_sweep_invocation("pure sweep invocation", "pr-sweep.sh 92")
    check("sweep invocation alone has no raw channels", mod._channels_in("pr-sweep.sh 92") == set())
    check_sweep_invocation(
        "multi-line canonical sweep invocation",
        'out=/tmp/x\n/Users/x/.claude/bin/pr-sweep.sh 92 > "$out"',
    )

    check_credits("non-numeric suffix is rejected", "pr-sweep.sh 92x", {})
    check_credits("hash-prefixed argument is rejected", "pr-sweep.sh #92", {})
    check_credits("echo mention is not a sweep", "echo pr-sweep.sh 92", {})

    check_credits(
        "direct comments query credits comments",
        "gh pr view 92 --json comments",
        {"92": {"comments"}},
    )
    check_credits(
        "REST reviews query credits reviews",
        "gh api repos/o/r/pulls/92/reviews",
        {"92": {"reviews"}},
    )
    check_credits(
        "GraphQL thread query credits threads",
        "gh api graphql -f query='pullRequest(number: 92) { reviewThreads { isResolved } }'",
        {"92": {"threads"}},
    )

    # single-digit PRs (workspace #1 is open) — \d+ not \d{2,}
    check("single-digit sweep identifies PR 1", mod._pr_numbers("pr-sweep.sh 1") == {"1"})
    check_credits(
        "single-digit sweep credits all channels",
        "/Users/x/.claude/bin/pr-sweep.sh 1",
        {"1": ALL_CHANNELS},
    )
    check_credits(
        "single-digit direct comments query credits comments",
        "gh pr view 1 --json comments",
        {"1": {"comments"}},
    )
    check_credits(
        "single-digit REST reviews path credits reviews",
        "gh api repos/o/r/pulls/1/reviews",
        {"1": {"reviews"}},
    )

    # FAIL-OPEN: credit LIBERALLY after any separator — over-credit is the safe direction, a
    # false-BLOCK is the harm (codex P1/P2 on ws#25). A `||`-fallback and a pipeline DO run the sweep
    # (when the left fails / as a pipeline), so they credit; an `&&` may or may not run, but we credit
    # it too rather than risk false-blocking a real invocation. We do NOT model shell execution.
    check_sweep_invocation("|| fallback credits (runs when left fails)", "flaky || pr-sweep.sh 92")
    check_sweep_invocation("piped sweep credits (pipeline runs it)", "echo x | pr-sweep.sh 92")
    check_sweep_invocation("&&-sequenced sweep credits", "git fetch && /Users/x/.claude/bin/pr-sweep.sh 92")
    check_sweep_invocation("semicolon-sequenced sweep credits", "cd /r; pr-sweep.sh 92")
    check_sweep_invocation("backgrounded-then sweep credits", "tail -f log & pr-sweep.sh 92")
    check_sweep_invocation("multi-line sweep credits (newline runs it)", "flaky ||\npr-sweep.sh 92")
    check_credits(
        "single-digit GraphQL number credits threads",
        "gh api graphql -f query='pullRequest(number: 1) { reviewThreads { isResolved } }'",
        {"1": {"threads"}},
    )

    # token boundary (?![\w<>#.]): a digit run that is a PREFIX of a larger non-PR token is NOT a PR
    # arg — pr-sweep.sh rejects it and exits nonzero, so crediting the prefix would credit the WRONG
    # pr. NEGATIVE list only (reject known-bad suffixes), so `|`/`&`/`)` terminators still credit.
    check_credits("redirect fd is not a sweep arg", "pr-sweep.sh 2>&1", {})
    check_credits("dotted non-int arg does not credit", "pr-sweep.sh 1.5", {})
    check_credits("hash-suffixed arg does not credit", "pr-sweep.sh 92#foo", {})
    check_credits("real arg still credits despite trailing redirect", "pr-sweep.sh 92 2>&1", {"92": ALL_CHANNELS})
    check_sweep_invocation("piped-to arg still credits (| terminator)", "pr-sweep.sh 92|tee log")
    check_credits("pr view redirect fd does not credit", "gh pr view 2>&1 --json comments", {})

    # Stop-path stays prose-safe (SPI-928 review F1): PR_REF_RE / READY_RE keep \d{2,} so ordinary
    # prose (`Commandment #3`, `#1 failure`) is never read as a declared PR that blocks a ready claim.
    check("prose #3 is not a declared PR", mod.PR_REF_RE.findall("per Commandment #3") == [])
    check("two-digit #92 is a declared PR", mod.PR_REF_RE.findall("PR #92 is ready") == ["92"])
    check("single-digit readiness claim is not enforced (prose-safe)", mod.READY_RE.search("#1 is now clean") is None)
    check("two-digit readiness claim is recognized", mod.READY_RE.search("#92 is now clean") is not None)


if __name__ == "__main__":
    main()
