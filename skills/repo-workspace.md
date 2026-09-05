# Consumer Project Workspace Repo Skill Pack

Instructions for working inside the consumer project workspace repository. This repository has no
single unified npm gate or CI command.

## Verification
- Run the specific tests that cover the files you changed; do not claim a workspace-wide gate.
- For Python hook changes, run the relevant hook tests with both Homebrew `python3` and
  `/usr/bin/python3` (Python 3.9), and report each command and result separately.
- For `.claude/bin` changes, run the relevant `.claude/bin` selftests.
- Report honestly what was run versus only written, and name any failing tests with the exact
  command that produced them.

## Checkout Boundary
- Work only in the workspace repository and the cwd supplied by the dispatcher.
- Never `cd` to, inspect, or run verification from any consumer app checkout.
