# Project↔fleet registry (HED-160)

Binds a **project** — a named set of workspace roots — to its dedicated **fleet**: which agent ids
belong to it, which Linear team tracks its issues, which chat room is its default, and which script
launches its sessions.

Ground truth that motivated it (Maya, verbatim): "how do we have projects associate with their
dedicated groups of agents? I want to open the Spinventory project inside heddle — the dashboard
shows Agents A through Q, chatrooms with just Spinventory agents." Without a registry, "which agents
belong to this project" has to be re-derived ad hoc by every consumer (dashboard roster, chatroom
membership, session launcher). The registry makes that association explicit and shared.

This doc covers the CORE module only: the loader and the two lookups in `src/projects.ts`. Wiring the
registry into the roster, chatroom, or launcher is separate follow-up work, not covered here.

## Where it lives

`~/.heddle/projects.json` — the FRAMEWORK layer, **never inside a project repo**. It spans tenants
(today Spinventory and heddle itself; more will be added later), so it cannot live inside any one of
the repos it describes. Same layer as `~/.heddle/accounts.json` (`src/capaware.ts`, the Claude
account registry) and the ledger (`~/.heddle/ledger.db`).

## Schema

```json
{
  "schemaVersion": 1,
  "projects": [
    {
      "name": "string",
      "workspaceRoots": ["absolute path", "..."],
      "agentIds": ["A", "B", "..."],
      "linearTeam": "string",
      "defaultRoom": "string",
      "launcher": "string"
    }
  ]
}
```

- `schemaVersion` — must equal `PROJECTS_SCHEMA_VERSION` in `src/projects.ts` (currently `1`). Every
  consumer parses this file, so a version drift is caught loudly at load time instead of being
  silently misread.
- `projects[].name` — the project's display name.
- `projects[].workspaceRoots` — absolute paths. A cwd under one of these belongs to the project,
  matched on path SEGMENT boundaries (`/a/foo` does not match `/a/foobar`). When two registered
  roots both match (nested roots, possibly from different projects), the longest match wins.
- `projects[].agentIds` — the fleet: letters and digits (e.g. `"A".."Q"`, `"1".."6"`), matched
  case-insensitively.
- `projects[].linearTeam` — the Linear team key issues for this project are filed under.
- `projects[].defaultRoom` — the chatroom a session for this project lands in by default.
- `projects[].launcher` — the script name that resumes/launches this project's fleet.

## Loading — `loadProjectRegistry(path = DEFAULT_PROJECTS_PATH)`

- **Fail-soft on absence.** No file yet is a normal state — most projects won't be registered from
  day one — so a missing file returns `{ schemaVersion: 1, projects: [] }` rather than throwing.
  Every consumer must work correctly against an empty registry.
- **Loud on corruption.** This file is Maya-edited config, not generated output — same discipline as
  the routing table (`src/routing.ts`, `loadRouting` / `listField`). Unparseable JSON, a
  missing/mismatched `schemaVersion`, or a project missing a required field / with a non-array
  `workspaceRoots` or `agentIds` all throw a clear `Error` naming the problem and the path.

## Consumer contract: registry is TRUTH, cwd inference is FALLBACK

A consumer (dashboard roster, chatroom membership, session launcher — separate lanes, not built by
this module) must:

1. Load the registry and try `projectForCwd` / `projectForAgent` first.
2. **Only when the registry has no match**, fall back to whatever cwd-based inference it already does
   today.

The fallback is never removed, even once every known project is registered — an unregistered project
(a brand-new tenant, or a one-off checkout) must keep working exactly as it does today. The registry
makes the project↔fleet association explicit; it does not become the only way that association can
be discovered.

## Example `~/.heddle/projects.json`

The two projects registered today:

```json
{
  "schemaVersion": 1,
  "projects": [
    {
      "name": "Spinventory",
      "workspaceRoots": ["/Users/mayatobi/Developer/Spinventory-Rebuild-App"],
      "agentIds": ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "1", "2", "3", "4", "5", "6"],
      "linearTeam": "SPI",
      "defaultRoom": "#spinventory",
      "launcher": "resume-sessions-spi.sh"
    },
    {
      "name": "heddle",
      "workspaceRoots": ["/Users/mayatobi/Developer/heddle", "/Users/mayatobi/Developer/heddle-dashboard"],
      "agentIds": ["R", "S", "T", "U", "V", "W"],
      "linearTeam": "HED",
      "defaultRoom": "#heddle",
      "launcher": "resume-sessions-hed.sh"
    }
  ]
}
```

## API (`src/projects.ts`)

- `PROJECTS_SCHEMA_VERSION` — the schema version this module reads/writes (`1`).
- `DEFAULT_PROJECTS_PATH` — `~/.heddle/projects.json`.
- `loadProjectRegistry(path?): ProjectRegistry` — see [Loading](#loading--loadprojectregistrypath--default_projects_path) above.
- `projectForCwd(reg, cwd): Project | null` — longest-matching `workspaceRoots` entry wins.
- `projectForAgent(reg, agentId): Project | null` — case-insensitive `agentIds` match.
