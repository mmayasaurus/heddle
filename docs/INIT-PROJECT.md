# `heddle init-project` — portable discipline installer (HED-84)

> Slice of the HED-299 `heddle init` epic (workstreams 2–3). Maya-approved design 2026-08-15
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
re-renders only what drifted. Never destructive: existing files that differ are *reported*, never
overwritten, unless `--force` (v1 has no `--force`; report-and-skip is the only behaviour).

### Steps (each reported as `ok | created | updated | skipped(reason) | would-<verb>` under --dry-run)

1. **Canonical root** — resolve `--canonical` (default: `HEDDLE_CANONICAL` env, else the path
   recorded in `~/.heddle/canonical.json`, else the Spinventory workspace `.claude/` — v1 default,
   flipped by HED-96). Must contain `hooks/` with the 9 discipline hooks; otherwise fail loudly
   with the missing list (no partial install).
2. **`<dir>/.claude/settings.json` hook wiring** — render the 12-entry / 4-event wiring heddle's own
   `.claude/settings.json` uses today (SessionStart identity+preflight; UserPromptSubmit
   remind-owned-prs; PreToolUse Bash→memtrace deny-recursive-search + enforce-query, Grep|Glob|Read→
   enforce-query, Edit|MultiEdit|Write→delegation-nudge; PostToolUse Bash→memtrace record + pr-sweep
   record, mcp__memtrace__.*→record, mcp__serena__.*→record; Stop→memtrace stop), every entry in the
   loud-fail-open form (`if [ -f "<canonical>/hooks/<h>" ]; then python3 … ; else echo "… MISSING at
   the canonical — running WITHOUT it" >&2; exit 1; fi`). MERGE into an existing settings.json:
   preserve unrelated keys and any non-discipline hooks; replace only entries whose command targets a
   discipline hook by basename. Absolute paths are rendered from the resolved canonical (links, not
   copies — "no byte-copied drift").
3. **Rules stubs** — `<dir>/.claude/rules/{pr-review-sweep,pr-ownership,worktree-discipline}.md`
   as short stubs that REFERENCE the canonical rule by absolute path (same stub→canonical pattern
   Spinventory uses for its style guides). Skip if present.
4. **`.mcp.json`** — ensure `memtrace` and `serena` server entries exist (merge; never drop others).
   Entry shapes copied from heddle's own `.mcp.json` if present, else a documented default.
5. **`.memtraceignore`** — ensure `.worktrees/` and `.memdb*/` lines exist (append-only).
6. **Per-repo `/heddle-gate` command** — `<dir>/.claude/commands/heddle-gate.md` from heddle's own
   copy if absent.
7. **Registry** — upsert `~/.heddle/projects.json` (`src/projects.ts` schema v1): `name` (default
   basename), `workspaceRoots` += resolved `<dir>`, `agentIds`/`linearTeam`/`defaultRoom`/`launcher`
   from flags (required on first registration, preserved on re-run). Registry is TRUTH (docs/PROJECTS.md).
8. **memtrace-first enforcement flag** — `--enforce-memtrace` writes `<dir>` into
   `~/.heddle/memtrace-enforce.json` as `{ "<root>": true }` (per-root flag the hook reads — see
   "Hook parameterization"). Default OFF (record-only) for a freshly-initialized repo; Maya's call to
   flip (per HED-84's per-root ENFORCEMENT design).
9. **Verify** — print what was installed, what was skipped and why, and a human-steps checklist:
   register the memtrace watch (`watch_directory` is an MCP call — the installer prints the exact
   call, it cannot make it), confirm index freshness, Linear team/labels (HED-299 ws3 owns automating).

### Hook parameterization (the canonical `require-memtrace-first.py`)

Today the hook hardcodes `APP_MONOREPO` / `HEDDLE_REPOS` / `ENFORCEMENT_ROOTS`. v1 adds a
registry-driven layer WITHOUT removing the hardcoded lists (behaviour-neutral for Spinventory and
heddle): `indexed_repo_root_for_path` also consults `~/.heddle/projects.json` `workspaceRoots`
(longest-prefix match, realpath-canonicalized, same rules as `projects.ts`), and
`enforcement_enabled_for` also consults `~/.heddle/memtrace-enforce.json`. Both reads are
fail-soft (absent file → today's behaviour). The `repo_id` for a registry root = the root's
basename (memtrace's `repo_id` convention for `index_directory`), overridable later by a registry
field (not v1).

## Non-goals (v1)

Relocating the canonical into heddle (`HED-96`), `heddle.toml` constant extraction + Linear
bootstrap (`HED-299` ws1/ws3), `--force` overwrite, copying Spinventory-specific assets (style
guides, vault, SPI reviewer fleet) — those stay project-local by design.

## Acceptance (the HED-96 demo's first half)

A toy repo: `heddle init-project /tmp/newthing --name newthing --team NEW --agents Z --room #newthing
--launcher resume-new.sh` → `.claude/settings.json` wired to the canonical (loud-fail-open), rules
stubs + `.mcp.json` + `.memtraceignore` + `/heddle-gate` present, project in `~/.heddle/projects.json`,
`heddle projects` lists it; a second run reports all `ok`, changes nothing (byte-identical files);
`--dry-run` on a fresh dir writes nothing and reports every `would-create`.
