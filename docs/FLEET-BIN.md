# Fleet bin tools

`fleet/bin/` is the vendored, source-controlled canon for the daily pull-request, issue-tracker, communications, and account-state tools. This Phase 3a install surface is dark: installation does not change any existing launcher, hook, or invocation path.

Install the complete set into the current user's Heddle home directory:

```sh
heddle fleet install-bin
```

Preview actions without writing:

```sh
heddle fleet install-bin --dry-run
```

Text output starts with the target, followed by one sorted action per supported file:

```text
target: ~/.heddle/fleet/bin
would create tool.sh
```

Without `--dry-run`, actions are unprefixed (`created`, `updated`, or `unchanged`). `--json` is available in both modes and returns the target, actions, and `dryRun` value. The canon dynamically includes regular `.sh`, `.py`, and `.mjs` files. The installer copies both bytes and source permission bits, so executable tools remain `0755` and imported helper libraries remain `0644`.

Compare an installed set with the canon:

```sh
heddle fleet bin-diff
heddle fleet bin-diff --json
```

`bin-diff` reports missing, byte-different, and mode-different files. It exits 0 when clean and 1 when drift exists. Both bin commands exit 2 for usage errors. An empty canon or a supported-extension entry that is not a regular file fails as a canon-integrity error. Installed extra files are ignored.

## Phase scope

| Phase | Included | Deferred |
| --- | --- | --- |
| 3a | Pull-request flow, issue-tracker flow, communications helper and library, account-sharing helper, and imported sweep helper libraries | — |
| 3b | Watcher family, source-collection helper, runner-scaling helper, and import-testing tools | — |

## Parity manifest

`fleet/MANIFEST.sha256` records SHA-256 hashes for every regular fleet asset under `bin/`, `hooks/`, and `launchers/`; the manifest file itself is excluded because it is the record. The CI test recomputes the sorted, content-only list and rejects a changed, missing, or unlisted asset.

Regenerate the manifest only as part of an intentional re-vendor flow:

```sh
npm run fleet:manifest
```

The vendor copies are not patched locally. A canon correction belongs upstream, followed by a fresh vendor update and manifest regeneration.

## Why canon tests are not vendored

The workspace canon's own tests exercise its live local service, credentials, and operator setup. They are not portable assets and would create a second test suite whose environmental assumptions do not hold here. The parity manifest makes the copied runtime files tamper-evident, while this repository tests the install/diff engine and command contracts.

## PORTABILITY BLOCKER CATALOG

Catalog only: do not repair these copied files in place. The pointers describe machine and operator coupling generically; a future canon update must fix the source before re-vendoring.

- `comms-post.mjs:7-9` imports built modules from one absolute local checkout; `comms-post.mjs:21-26` reads a home-scoped agent credential registry.
- `comms-post-lib.mjs:1-25` relies on a configured agent registry and a watcher-specific message convention.
- `heddle-account-share.sh:28-30` assumes a home-scoped account registry, default client-state directory, and discoverable client executable; `heddle-account-share.sh:80-153` mutates per-account links and relies on that client's JSON auth-status contract.
- `lin.sh:51-59` fixes credential, token-cache, workspace-rule, and team-scope locations; `lin.sh:64-117` derives identity from the current worktree and obtains network credentials from that local registry; `lin.sh:682-737` selects tracker backend and repository/team configuration from a home-scoped project registry.
- `pr-linear-sync.sh:41-56` uses a home-scoped state and credential store; `pr-linear-sync.sh:104-109` uses an absolute source-repository path; `pr-linear-sync.sh:139-168` depends on per-agent OAuth material and a remote issue-tracker API.
- `pr-own.sh:26-77` derives ownership from local worktree and repository metadata and requires the command-line hosting-service client.
- `pr-sweep.sh:31-60` requires a repository checkout, its remote configuration, and authenticated hosting-service CLI context; `pr-sweep.sh:178-180` invokes its adjacent helper libraries by installed-directory-relative path.
- `pr-watch.sh:45-52` obtains repository identity through the hosting-service CLI and stores polling state in a home-scoped directory.
- `pr_sweep_cap_notice.py:27-35` contains a provider-specific bot-login configuration that requires source-level maintenance when provider identities change.
- `pr_sweep_cs.py:8-39` recognizes provider-specific code-scanning error wording; it has no local path dependency but its compatibility policy is tied to that remote API.
- `account-meter-watch.sh:16-20` fixes state and snapshot locations in home-scoped directories; `account-meter-watch.sh:59-67` requires the macOS notification executable; `account-meter-watch.sh:470` reads a home-scoped usage-limits input (`HEDDLE_LIMITS_PATH`, default `limits.json` under the usage directory).
- `attention.sh:19-21` fixes its durable queue spool in a home-scoped directory.
- `attention-watch.sh:15-21` fixes watcher state and queue locations in home-scoped directories; `attention-watch.sh:73-81` requires the macOS notification executable.
- `cursor-meter-watch.sh:16-20` fixes state and snapshot locations in home-scoped directories; `cursor-meter-watch.sh:75-83` requires the macOS notification executable; `cursor-meter-watch.sh:317` reads a home-scoped usage-limits input (`HEDDLE_LIMITS_PATH`, default `limits.json` under the usage directory).
- `headroom-watch.sh:16-23` fixes state and snapshot locations in home-scoped directories; `headroom-watch.sh:140-148` requires the macOS notification executable; `headroom-watch.sh:458` reads a home-scoped usage-limits input (`HEDDLE_LIMITS_PATH`, default `limits.json` under the usage directory).
- `linear-comment-watch.sh:14-27` requires adjacent issue-tracker helpers and a home-scoped state directory; `linear-comment-watch.sh:180-198` delegates remote polling and delivery to those helpers.
- The operator-decision-queue watcher `needs-<operator>-watch.sh:21-46` requires an adjacent issue-tracker helper, fixes the operator identity, and stores state in a home-scoped directory; `needs-<operator>-watch.sh:85-98` resolves an operator-rulings ledger (`DECISIONS.md`) at a path two levels above the installed script, which points outside any checkout once installed; `needs-<operator>-watch.sh:164-182` delivers alerts through a macOS notification executable (default `osascript`, optional `terminal-notifier`). Its canon filename embeds the operator's personal name and requires a rename before shipping.
- `push-source-collect.sh:29-48` fixes source queues, meter snapshots, and its output spool in home-scoped directories; `push-source-collect.sh:251-253` reads a home-scoped communications database.
- `runner-scale.sh:29-37` fixes the remote runner and repository identities and requires infrastructure and hosting-service CLIs; `runner-scale.sh:55-93` calls their remote queue and capacity APIs.
- `import-tester-issues.py:29-48` stores import state and agent credentials in a home-scoped registry; `import-tester-issues.py:34-46` hard-codes its import targets — a specific source spreadsheet, issue-tracker team and workflow-state identifiers, and a fixed agent attribution key; `import-tester-issues.py:51-91` depends on remote issue-tracker OAuth and GraphQL APIs.
- `tester-import-poll.sh:12-14` fixes a local interpreter and importer at absolute paths and writes logs in a home-scoped directory.

## Cutover is separate

Changing any workspace setting or launcher to invoke installed bin copies is a separate, operator-gated phase. `fleet/` remains outside the standalone release ship-set; genericizing the canon is required before it can be shipped in a snapshot.
