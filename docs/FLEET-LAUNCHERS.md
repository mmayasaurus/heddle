# Fleet launchers

`fleet/launchers/` is the vendored, source-controlled canon-to-be for Heddle fleet launchers. It is dark in this phase: installing the copies does not change any invocation path.

For the separately installed bin-tool set and the fleet-wide parity manifest, see [Fleet bin tools](FLEET-BIN.md).

Install the complete launcher set into the current user's Heddle home directory:

```sh
heddle fleet install-launchers
```

Preview file actions without writing:

```sh
heddle fleet install-launchers --dry-run
```

Text output always starts with the installation target, followed by one action per launcher:

```text
target: ~/.heddle/fleet/launchers
would create resume-sessions-v2.sh
```

Without `--dry-run`, the action is unprefixed (for example, `created resume-sessions-v2.sh`). `--json` is available for both install modes and includes the target, file actions, and `dryRun: true` or `dryRun: false`.

If installation fails partway through, files handled earlier in the run remain installed. The error names the file that failed and separately lists files written in that run and files left unchanged. In `--dry-run`, where nothing is written, that same error reports `files written this run: none (dry run — planned: …)` instead of claiming writes.

A canon directory that exists but contains no `.sh` files fails loudly (`fleet launcher canon is empty`) rather than reporting a vacuously clean install or diff, and a `.sh` entry that is not a regular file (a directory or symlink) fails as a canon-integrity error instead of being silently skipped. The same hardening applies to the hook set.

Compare the installed copies with the vendored canon:

```sh
heddle fleet launchers-diff
```

Use `--json` with either command when machine-readable output is needed:

```sh
heddle fleet install-launchers --json
heddle fleet launchers-diff --json
```

`launchers-diff` prints each missing or differing file and exits with status 1 when drift exists. It exits 0 when the installed launchers match the canon. Both fleet commands exit 2 for usage errors.

Drift includes permission mode differences as well as byte differences. When bytes match but a launcher's permission bits differ from the vendored source, `launchers-diff` reports it as differing and `install-launchers` updates it to the source mode.

## `launchers-diff` scope

`launchers-diff` compares only the `.sh` files present in the canon directory (discovered dynamically, like the hook set's `.py` discovery — the canon directory is git-controlled, so additions arrive only via reviewed commits); installed extras are ignored. Dynamic discovery keeps `src/fleet.ts` name-free and the test fixtures use neutral names; this document names only identity-free launcher filenames, and the catalog below describes identity-bearing couplings generically with file:line pointers — so the shipped doc carries no tenant or machine identity (both the public-scrub suite and the release generator's output gate verify this, with an empty allowlist).

## Cutover is separate

CUTOVER — invoking installed launcher copies — is a separate, operator-gated change. Nothing currently invokes these installed copies. Workspace shims and any `--project` / `projects.json` genericization are later phases.

## Standalone snapshot: deliberately excluded

`fleet/` is structurally outside `isIncluded` in `src/release/shipset.ts`; no ship-set probe is needed. The launcher canon is therefore not present in a standalone snapshot. Shipping it requires a genericized canon in a later phase.

## Why `resume-sessions.sh` is not vendored

The v1 `resume-sessions.sh` was a 2026-06-29 crash-recovery one-off with hardcoded session IDs. The v2 launcher discovers sessions at runtime, so only the v2 set and its wrappers are vendored.

## PORTABILITY BLOCKER CATALOG

Catalog only: do not fix these in the installed-copy phase. Canon bugs route upstream and are then re-vendored, following the HED-499 pattern.

- `resume-sessions-v2.sh:118-119` hardcodes the operator's workspace root and its inner repository/worktree location as absolute paths.
- `resume-sessions-v2.sh:122-123, 125` assumes the local Claude session store, `~/.heddle/accounts.json`, and a Heddle CLI build at `~/Developer/heddle/dist/cli.js`.
- `resume-sessions-v2.sh:166`, `resume-sessions-v2.sh:271-274`, and `resume-sessions-v2.sh:879-882` hardcode an absolute, operator-home-anchored path to the heddle comms channel-server build (`dist/comms/channel-server.js` under the operator's checkout) and disable comms when that file is absent.
- `resume-sessions-v2.sh:183` and `resume-sessions-v2.sh:200-211` couple optional settings overlays to a caller-provided, readable `FLEET_SETTINGS_FILE`, canonicalized to the current filesystem and constrained for tab-shell emission.
- `resume-sessions-v2.sh:320-326` assumes the user's `~/.claude` store is shared into each configured account directory and invokes the workspace-local `.claude/bin/heddle-account-share.sh` remediation path.
- `resume-sessions-v2.sh:801, 812-815` defaults Heddle-fleet sessions to `~/Developer/heddle` and forces R–Z into that cwd; `resume-sessions-v2.sh:1051-1074` recreates missing session/worktree directories and uses the hardcoded inner repository for `git worktree add`.
- `resume-sessions-v2.sh:819-821, 885-892` launches every resumed session from the session-derived or forced project cwd, so successful resume depends on those workspace paths existing and matching Claude's cwd-scoped session storage.
- `resume-sessions-v2.sh:997-1046` requires macOS `osascript` automation for iTerm2 or Terminal.app and defaults unrecognized terminal environments to iTerm2.
- `resume-sessions-spi.sh:23` and `fleet-relaunch.sh:115` hardcode an absolute consumer-pack path in `HEDDLE_PACKS`.
- `resume-sessions-gpt.sh:23-28` requires the local `claudex` proxy harness/default store and fixes the numbered-fleet launch policy around it.
- `fleet-relaunch.sh:41-53` reads and validates `FLEET_MAX` only for a numbered agent selector; letter selectors deliberately avoid that environment coupling, while numbered selectors additionally inherit the launcher's three-digit discovery ceiling.

Line numbers above are current as of the launcher re-vendor; anchor by content when they drift.

The wrapper `cd` calls (`resume-sessions-hed.sh:17`, `resume-sessions-gpt.sh:13`, `resume-sessions-spi.sh:16`, and `fleet-relaunch.sh:28`) intentionally resolve their shared files relative to the installed launcher directory. They require the five-file set to be installed together, but do not themselves assume the original workspace checkout path.
