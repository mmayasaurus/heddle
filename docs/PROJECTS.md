# Project registry

`~/.heddle/projects.json` binds a named project to workspace roots, agents, a Linear team, a
default room, a launcher, and optional repository-aware quality gates. Set `HEDDLE_PROJECTS` to use
another registry path; a blank value is unset and falls back to `~/.heddle/projects.json`.

## Schema

```json
{
  "schemaVersion": 1,
  "projects": [
    {
      "name": "acme",
      "workspaceRoots": ["/Users/example/Developer/acme"],
      "agentIds": ["A", "B"],
      "linearTeam": "ACM",
      "defaultRoom": "#acme",
      "launcher": "resume-acme.sh",
      "gates": {
        "app": { "parent": "acme-org", "dir": "acme-app", "pack": "acme-app-gate" },
        "byFolderName": { "acme-tools": "repo-acme-tools" },
        "byOriginName": { "acme-tools": "repo-acme-tools" }
      }
    }
  ]
}
```

`gates.app` identifies an app checkout by exact parent-directory and directory names. `byFolderName`
and `byOriginName` map exact repository names to installed packs. The loader validates ordinary
project fields; malformed gate entries degrade fail-soft so project lookup continues.

- `schemaVersion` must equal `PROJECTS_SCHEMA_VERSION` in `src/projects.ts` (currently `1`).
- `workspaceRoots` must be absolute and match cwd values only on path-segment boundaries; the longest
  matching root wins.
- `agentIds` match case-insensitively and cannot be claimed by two projects.
- The remaining required non-empty fields are `name`, `linearTeam`, `defaultRoom`, and `launcher`.

An absent registry is normal and loads as an empty registry. A present but unreadable registry,
invalid JSON, a schema-version mismatch, or malformed required project fields raises a clear error
naming the registry path. This separates normal unregistered projects from broken configuration.

## Consumer contract

Consumers load the registry and first call `projectForCwd` or `projectForAgent`. Only if there is no
registry match may they retain their existing inference fallback; an unregistered project must keep
working. The registry is shared project identity, not a reason to remove safe fallback behavior.

## Gate packs and resolution

Pack directories are searched in this order: directories in `HEDDLE_PACKS` (path-delimiter
separated), `~/.heddle/packs`, then heddle built-ins. A directory named `name.md` is not a pack.

When `quality-gate` is requested, resolution is:

1. No repository main root: drop the gate.
2. Exact registry app layout: use its pack.
3. Exact main-checkout folder name, corroborated by origin when present; an exact origin alone
   identifies a renamed clone.
4. Otherwise drop the gate.

There are no substring matches. Built-in folder and origin keys are immutable: a registry collision
is refused with a stderr warning naming the project. A key claimed by two projects with different
packs is dropped with one stderr warning naming both projects. Warnings are per defect (deduplicated
only where the loader already records a defect). Missing registries, malformed gates, unknown packs,
and unrecognized repositories fail soft rather than guessing a gate.

A registry-named pack that no pack directory can serve produces a warning and no gate for that
repository — never a fallback to another project's pack.

An explicit `HEDDLE_PACKS` `quality-gate.md` shadow retains its consumer-owned gate. A
`~/.heddle/packs/quality-gate.md` does not suppress repository resolution.

## API

- `loadProjectRegistry(path?)` loads the registry; a missing file yields an empty registry.
- `projectForCwd(registry, cwd)` selects the longest exact workspace-root boundary match.
- `projectForAgent(registry, agentId)` matches agent IDs case-insensitively.
