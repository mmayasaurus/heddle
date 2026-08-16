# Memtrace first + Serena — heddle (core)

**repo_id:** `heddle` — pass explicitly on every memtrace call in this repo or its worktrees.

## Memtrace-first (code discovery)

Before `Grep`, `Glob`, or `Read` on source, query memtrace:

1. **`find_symbol`** / **`find_code`** — you know the name vs only the meaning.
2. **`get_symbol_context`** / **`get_impact`** before edits or deletes.
3. **Zero results ≠ absent.** Diagnose scope (`list_indexed_repositories`, `repo_id`, worktree overlay), broaden the query, or re-index — never silently fall back to grep.

The memtrace-first hook gates raw file discovery only; approved memtrace and Serena symbol tools are not bypasses.

## Worktree overlays (mandatory)

Every **new** worktree must be registered **immediately**:

```text
watch_directory(path="<worktree path>", repo_id="heddle")
```

Immediately after `git worktree remove <dir>`:

```text
unwatch_directory(path="<worktree path>")
```

The canonical graph is indexed once from `main`; each worktree is a diff-only overlay. Query your scope with `find_code(..., worktree="<id>")`.

## Serena (symbol-precise edits)

Serena complements memtrace. Call **`initial_instructions`** first; then **`find_symbol` → `replace_symbol_body`** (or `find_referencing_symbols`). **`get_impact`** before symbol changes. Full manual: `/Users/mayatobi/Developer/Spinventory-Rebuild-App/.claude/rules/serena.md`
