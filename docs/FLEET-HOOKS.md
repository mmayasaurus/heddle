# Fleet hooks

`fleet/hooks/` is the vendored, source-controlled canon-to-be for Heddle fleet-discipline hooks. It is dark in Phase 1: no repository settings consume it yet.

Install the canon into the current user's Heddle home directory:

```sh
heddle fleet install-hooks
```

Preview file actions without writing:

```sh
heddle fleet install-hooks --dry-run
```

Compare the installed copies with the vendored canon:

```sh
heddle fleet hooks-diff
```

`hooks-diff` prints each missing or differing file and exits with status 1 when drift exists. It exits 0 when the installed hooks match the canon.

## Cutover is separate

CUTOVER — changing any repository's `.claude/settings.json` to invoke the installed hooks — is a separate, operator-gated change. It is explicitly not part of this vendoring and install/diff work.

## Runtime dependency: `~/.claude/lib/hook_utils.py`

Two vendored hooks import `hook_utils` from `~/.claude/lib` via an absolute, home-anchored `sys.path` entry (independent of the hook file's own location): `require-memtrace-first.py` (top-level import — hard dependency) and `require-pr-sweep.py` (function-scoped import). That file is machine-local and tracked in no repository today. The vendored copies behave identically to the workspace originals in this respect, but any cutover checklist must verify `~/.claude/lib/hook_utils.py` exists on the target machine. Bringing it under source control is an open item for a later HED-96 phase.

## `hooks-diff` scope

`hooks-diff` compares only files present in the canon; an installed file that is no longer in the canon is not reported (asserted in `test/fleet.test.ts`). Inert for cutover — settings entries reference canon files by name — but worth knowing when reading its output.
