# `heddle init-project` — portable discipline installer (HED-84)

> Slice of the HED-299 `heddle init` epic (workstreams 2–3). operator-approved design 2026-08-15
> ("yes and yes"); this doc is the build contract for v1. HED-96 later relocates the CANONICAL
> to heddle's own `fleet/` — this installer is what links FROM the canonical into any project, so
> it is written against a *configurable* canonical root, never a byte-copy.

## Problem

The enforcement stack (identity / delegation-nudge / memtrace-first / pr-sweep / stop checks)
lives in one workspace's `.claude/`. A session whose project dir is any other repo silently loses
all of it. heddle's own repos bridge to it today by hand-written absolute-path hook entries in
their `.claude/settings.json` (HED-107) — drift-prone and unrepeatable for a new project.

## Contract

`heddle init-project <dir> [--canonical <path>] [--name <n>] [--team <KEY>] [--agents A,B,…]
[--room <#room>] [--launcher <script>] [--enforce-memtrace] [--dry-run] [--json]`

Installs/links the canonical discipline set into `<dir>` and registers the project. **Idempotent and
re-runnable**: every step is a no-op when already correct; re-running after a canonical change
re-renders only what drifted. Never lossy: generated files (settings.json hooks, .mcp.json, .memtraceignore, the registry) are
*merged* — everything not owned by the installer is preserved byte-for-byte in content, and every
file whose bytes change is reported as `update` (a one-time re-serialization of a hand-formatted file
is expected and reported). Files the installer only seeds (rules stubs, /heddle-gate) are never
rewritten once present.

### Steps (each reported as `ok | created | updated | skipped(reason) | would-<verb>` under --dry-run)

1. **Canonical root** — resolve `--canonical`, else `HEDDLE_CANONICAL`, else the path
   recorded in `~/.heddle/canonical.json`. One of these is required: heddle does not yet ship a
   vendored discipline-hook set (that relocation is HED-96), so a machine-specific fallback would
   be non-portable. The selected root must contain `hooks/` with the 6 WIRED discipline hooks (the 3 workspace-only hooks are
   optional and reported); a missing wired hook fails loudly with the list (no partial install).
2. **`<dir>/.claude/settings.json` hook wiring** — render the 14-command / 6-event wiring heddle's own
   `.claude/settings.json` uses today (SessionStart identity+preflight; UserPromptSubmit
   remind-owned-prs; PreToolUse Bash→memtrace deny-recursive-search + enforce-query, Grep|Glob|Read→
   enforce-query, Edit|MultiEdit|Write→delegation-nudge; PostToolUse Bash→memtrace record + pr-sweep
   record, mcp__memtrace__.*→record, mcp__serena__.*→record; Stop→memtrace stop + pr-sweep
   enforce-stop; SubagentStop→memtrace stop — the table is asserted against heddle's live file by a
   test so it can never drift), every entry in the
   loud-fail-open form (`if [ -f "<canonical>/hooks/<h>" ]; then python3 … ; else echo "… MISSING at
   the canonical — running WITHOUT it" >&2; exit 1; fi`). MERGE into an existing settings.json:
   preserve unrelated keys and any non-discipline hooks; replace only entries whose command targets a
   discipline hook — matched on the `/hooks/<name>` PATH SEGMENT, never a bare filename substring —
   and replace them IN PLACE inside their existing matcher group (a group mixing user hooks and
   discipline hooks keeps its user hooks and its position; the rebuilt discipline block takes the
   first removed discipline entry's position. Same-matcher groups separated by another matcher stay
   separate: only the first receives the discipline block, and later groups retain only their user
   hooks. Misplaced discipline entries are removed and reported; the table is the only placement.
   Absolute paths are rendered from the resolved canonical (links, not
   copies — "no byte-copied drift").
3. **Rules stubs** — `<dir>/.claude/rules/{pr-review-sweep,pr-ownership,worktree-discipline}.md`
   as short stubs that REFERENCE the canonical rule by absolute path (same stub→canonical pattern
   the first consumer project uses for its style guides). Skip if present.
4. **`.mcp.json`** — ensure `memtrace` and `serena` server entries exist (merge; never drop others).
   Entry shapes copied from heddle's own `.mcp.json` if present; otherwise the step is reported
   `skip(no template)` until heddle ships its own `.mcp.json` — never a placeholder stub that could
   shadow a working config.
5. **`.memtraceignore`** — ensure `.worktrees/` and `.memdb*/` lines exist (append-only).
6. **Per-repo `/heddle-gate` command** — `<dir>/.claude/commands/heddle-gate.md` from heddle's own
   copy if absent.
7. **Registry** — upsert `~/.heddle/projects.json` (`src/projects.ts` schema v1): `name` (default
   basename), `workspaceRoots` += resolved `<dir>`, `agentIds`/`linearTeam`/`defaultRoom`/`launcher`
   from flags (required on first registration, preserved on re-run). Registry is TRUTH (docs/PROJECTS.md). The upsert is VALIDATED BEFORE WRITE by round-tripping the
   candidate through the in-memory `validateRegistry` checks also used by `loadProjectRegistry` (non-empty fields, absolute roots, non-empty
   agentIds, no agent claimed by two projects); empty strings / empty agent lists are rejected as
   missing. A registry that would not load back is never written. Existing space/tab indentation is
   retained, so standard formatted registries do not reformat unrelated project objects or unknown keys.
8. **memtrace opt-in marker + enforcement flag** — ALWAYS write `<dir>` into
   `~/.heddle/memtrace-enforce.json` as `{ "<canonicalized root>": <bool> }`: `true` with
   `--enforce-memtrace` (hard gate), else the prior value, or `false` on first registration
   (record-only). PRESENCE in this file is what opts a root into the memtrace-first hook's registry
   layer (see "Hook parameterization") — a root merely listed in `projects.json` is NOT
   memtrace-managed. Default `false` for a freshly-initialized repo;
   flipping to `true` is operator's call (per-root ENFORCEMENT design). The root is resolved from its
   existing parent at plan time, making the key stable when the target directory is first created;
   any existing aliases of that same canonical root are folded into one key. Other roots are preserved.
9. **Verify** — print what was installed, what was skipped and why, and a human-steps checklist:
   register the memtrace watch (`watch_directory` is an MCP call — the installer prints the exact
   call, it cannot make it), confirm index freshness, Linear team/labels (HED-299 ws3 owns automating).

### Hook parameterization (the canonical `require-memtrace-first.py`)

Today the hook hardcodes `APP_MONOREPO` / `HEDDLE_REPOS` / `ENFORCEMENT_ROOTS`. v1 adds an OPT-IN
registry layer WITHOUT removing the hardcoded lists, consulted only after they all miss:

- A root participates ONLY if it is PRESENT as a key in `~/.heddle/memtrace-enforce.json` (the
  installer's marker) — merely appearing in `projects.json` `workspaceRoots` does nothing. This is
  what keeps the change behaviour-neutral: the documented example registry lists the first consumer project
  WORKSPACE root, and without the opt-in every workspace-level cwd would have flipped from
  "unindexed" to "indexed repo" (review ledger 514, H1).
- Matching: longest opted-in root, path-SEGMENT boundaries (`/a/foo` never matches `/a/foobar`);
  roots and the cwd are canonicalized the SAME way (realpath when it exists, else lexical resolve)
  and the enforce file's keys are canonicalized before comparison (`/tmp` vs `/private/tmp`).
  A root of `/` or a user's home is refused (never opted in).
- `repo_id` for an opted-in root = its basename, and that id is ADDED to the hook's accepted-id set so
  the hook's own deny message ("query memtrace with repo_id X") is satisfiable (ledger 514, H2).
  Basename collisions across projects are a documented v1 limitation.
- Gate: the enforce file's value (`true` = hard gate) for opted-in roots; hardcoded
  `ENFORCEMENT_ROOTS` keep priority; absent → `ENFORCEMENT_ENABLED` (record-only today).
- Robustness: both JSON reads are fail-soft PER ENTRY (a bad entry is skipped, the rest apply — never
  "one typo disables every override"), capped at 1 MiB and regular files only, never raise.
  Case-insensitive filesystems: matching is byte-exact on the canonical spelling (known limitation).

## Non-goals (v1)

Relocating the canonical into heddle (`HED-96`), `heddle.toml` constant extraction + Linear
bootstrap (`HED-299` ws1/ws3), `--force` overwrite, copying consumer-project-specific assets (style
guides, vault, ABC reviewer fleet) — those stay project-local by design.

## Acceptance (the HED-96 demo's first half)

A toy repo: `heddle init-project /tmp/newthing --canonical /path/to/canonical --name newthing --team NEW --agents Z --room '#newthing'
--launcher resume-new.sh` → `.claude/settings.json` wired to the canonical (loud-fail-open), rules
stubs + `.memtraceignore` + `/heddle-gate` present, `.mcp.json` reported `skip(no template)` until
heddle ships its own `.mcp.json`, project in `~/.heddle/projects.json`,
`heddle projects` lists it; a second run reports all `ok`, changes nothing (byte-identical files);
`--dry-run` on a fresh dir writes nothing and reports every `would-create`.

Generated settings, MCP, ignore, registry, and enforcement files are written through a same-directory
temporary file and rename, preserving an existing destination's mode. The registry records its planned
bytes and refuses to overwrite it if another invocation changes it before apply; re-run the command in
that case. Install targets may not be `/`, the user's home directory, or an ancestor of a registered root.
