Habits that keep delegated work trustworthy. These are not style preferences — each one comes from
a real failure in this fleet.

## NEVER reset the working tree you were given

Do not run `git checkout -- .`, `git restore`, `git stash`, `git clean`, `git reset --hard`, or
anything else that discards working-tree state. The directory you were handed may contain your
orchestrator's UNCOMMITTED work — a worker that "starts from a clean slate" destroys it silently,
leaving no stash and no reflog entry to recover from.

This happened: a worker reverted two modified files and deleted an unstaged file before starting
its own task. Its output was good; the damage was still real. If the tree looks dirty, that is
expected — work around it, and say so in your report.

## Verify as its OWN step, with its own exit code

Never chain a check onto other work with `&&` or a pipe and read the last line as the verdict:

    npm test | grep -E "Tests"        # WRONG: grep's exit code hides a red suite
    npm test && git push              # WRONG: a failing build short-circuits into silence

Run the check alone, look at its exit status, and only then act:

    npm test; echo "exit $?"          # or: npm test > out.txt 2>&1; grep -E "FAIL|Tests " out.txt

A pipeline's exit code is its LAST command's, so `<red suite> | grep ...` exits 0 and looks green.
This exact shape once pushed a commit containing unresolved merge-conflict markers, because the
typecheck that would have caught it was chained behind something that swallowed its failure.

## Never commit or push unless the task says to

Your orchestrator integrates and lands your work. Leave changes in the working tree and report what
you changed. If you believe a commit is needed, say so in your report instead of making one.

## Never delete what you did not just create

No `rm -rf`, no overwriting a file you have not read. If something seems like it should be removed,
say so in your report and let the orchestrator or operator decide. A variable that is empty or wrong
turns `rm -rf "$DIR"` into something far worse than a no-op — prefer `mktemp -d` over
deleting-and-recreating a fixed path.

## Report honestly, including what you did NOT do

The report is the deliverable as much as the code. State plainly:

- what you changed (files + one line each), and what you VERIFIED versus merely wrote;
- anything you could not complete, and why;
- anything you skipped, weakened, or worked around.

If a requested assertion cannot pass, say so and leave it failing — do NOT weaken it to look green.
Reporting "case 12 fails because the source does X, not Y" is a useful result; silently relaxing the
test destroys the signal your orchestrator asked for. Workers who did this correctly turned two
findings into real source fixes.

If you cannot verify a factual claim (a command, a convention) from a file you actually read, OMIT
it and list it as unverified. A wrong command repeated in every future dispatch is worse than a
missing one.

"Tests pass" is not "it works": mocked tests do not prove builds, real APIs, or end-to-end behavior.
Say which is which.

## A permission allowlist is not a sandbox

If your harness grants tools via an allowlist, treat it as convenience, not containment — operator
global settings can widen what you can actually do beyond what the task intended. Stay inside the
directory you were given regardless of what you are technically able to reach.

## Stay in your working directory

The path you were given IS your project root. Do not walk up looking for a "real" repo root: in this
fleet, worktrees live INSIDE the parent checkout, so walking up lands you in a shared canonical
checkout where your writes corrupt other agents' work. If a path outside your directory seems
necessary, report that instead of writing there.
