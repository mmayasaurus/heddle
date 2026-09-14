# Fleet hooks

`fleet/hooks/` is the vendored, source-controlled canon-to-be for Heddle fleet-discipline hooks. It is dark in Phase 1: no repository settings consume it yet.

For the separate vendored launcher set and its portability catalog, see [Fleet launchers](FLEET-LAUNCHERS.md). Since the launcher work landed, both sets share one engine with the same hardening: an empty canon directory or a non-regular canon entry fails loudly instead of reporting vacuous success, and a `--dry-run` partial-failure error reports planned actions as `none (dry run — planned: …)` rather than as written files.

Install the canon into the current user's Heddle home directory:

```sh
heddle fleet install-hooks
```

Preview file actions without writing:

```sh
heddle fleet install-hooks --dry-run
```

Text output always starts with the installation target, followed by one action per hook:

```text
target: ~/.heddle/fleet/hooks
would create agent-identity.py
```

Without `--dry-run`, the action is unprefixed (for example, `created agent-identity.py`). `--json` is available for both install modes and includes the target, file actions, and `dryRun: true` or `dryRun: false`.

If installation fails partway through, files handled earlier in the run remain installed. The error names the file that failed and separately lists files written in that run and files left unchanged.

Compare the installed copies with the vendored canon:

```sh
heddle fleet hooks-diff
```

Use `--json` with either command when machine-readable output is needed:

```sh
heddle fleet install-hooks --json
heddle fleet hooks-diff --json
```

`hooks-diff` prints each missing or differing file and exits with status 1 when drift exists. It exits 0 when the installed hooks match the canon. Both fleet commands exit 2 for usage errors.

Drift includes permission mode differences as well as byte differences. When bytes match but a hook's permission bits differ from the vendored source, `hooks-diff` reports it as differing and `install-hooks` updates it to the source mode.

`agent-identity.py` intentionally has mode `0644`, matching its source. Hooks are invoked as `python3 <path>`, so this hook does not need an executable bit.

## Cutover is separate

CUTOVER — changing any repository's `.claude/settings.json` to invoke the installed hooks — is a separate, operator-gated change. It is explicitly not part of this vendoring and install/diff work.

## Runtime dependency: `~/.claude/lib/hook_utils.py`

Two vendored hooks import `hook_utils` from `~/.claude/lib` via an absolute, home-anchored `sys.path` entry (independent of the hook file's own location): `require-memtrace-first.py` (top-level import — hard dependency) and `require-pr-sweep.py` (function-scoped import). That file is machine-local and tracked in no repository today. The vendored copies behave identically to the workspace originals in this respect, but any cutover checklist must verify `~/.claude/lib/hook_utils.py` exists on the target machine. Bringing it under source control is an open item for a later HED-96 phase.

## `hooks-diff` scope

`hooks-diff` compares only files present in the canon; an installed file that is no longer in the canon is not reported (asserted in `test/fleet.test.ts`). Inert for cutover — settings entries reference canon files by name — but worth knowing when reading its output.

## Standalone snapshot: deliberately excluded

`fleet/hooks/` is NOT in the standalone release ship-set (`src/release/shipset.ts`), and that is a decision, not an omission: the canon carries this fleet's identity by construction (operator name, scope text, machine paths), and the snapshot's output scrub gate — correctly — rejects generation when it is included (verified empirically 2026-09-13: `release --standalone --verify` returns `ok:false` on `fleet/hooks/agent-identity.py` identity strings). In a generated snapshot, `heddle fleet install-hooks` / `hooks-diff` therefore fail with `fleet hook canon not found` by design. Shipping a canon in the snapshot requires a GENERICIZED canon — a later HED-96 phase, the same portability work as the cutover blockers below.

## Cutover blockers found in review

`require-memtrace-first.py` derives `PROJECT_ROOT` from `Path(__file__).resolve().parent.parent.parent` and hardcodes workspace-relative expectations. An installed copy at `~/.heddle/fleet/hooks` therefore resolves `PROJECT_ROOT` to `~/.heddle` and misclassifies working directories. Pointing settings at the installed copy of this hook is blocked until a later phase adds an explicit project-root override to the canon at source, or cutover invokes this one hook from the repository checkout.

`agent-preflight.py` falls back to an author-machine absolute `HEDDLE_CANON` path, so other machines report `SKIP`; `remind-owned-prs.py` invokes the workspace `pr-own.sh` by absolute path. Both are correct for this machine and are tracked for the canon home repository on HED-499; this review does not change either hook.
