/**
 * Machine-local tool-runtime DAEMON output that churns during any session — memtrace's `.memdb/` and
 * `.memtrace/`, and serena's symbol cache `.serena/cache/` — matched ONLY as a top-level prefix
 * (the daemons write these at the repo root). Excluded from the read-only-review mandate digest and
 * the parent-escape fingerprint, but ONLY when the path is untracked, so a consumer project that
 * doesn't gitignore them doesn't get a false MANDATE VIOLATION / escape warning from daemon churn
 * mid-review (HED-550).
 *
 * Deliberately NARROW — the round-2 blanket segment match was too broad (HED-550 round-3 review):
 *   - a nested `src/.serena/cache/x` or a fake `pkg/.memdb/…` is NOT daemon output; it stays visible
 *     to both guards (matching by prefix, not any-segment);
 *   - `.serena/` is NOT homogeneous: `.serena/project.yml` and `.serena/memories/` are agent/user
 *     -authored (a reviewer can call serena's write_memory), so only `.serena/cache/` is excluded —
 *     a reviewer write to serena config or memories is caught WHERE `.serena/` is not gitignored
 *     (see the enumeration boundary below);
 *   - the trailing slash means a bare file literally named `.serena`/`.memdb`/`.memtrace` is NOT
 *     excluded, and `.memdbextra/…` cannot collide with `.memdb/`.
 * `.memtraceignore` is tracked configuration, never matched here.
 *
 * Enumeration boundary (pre-existing, tracked as HED-569): both guards enumerate the worktree with
 * commands that skip gitignored paths — snapshotWorktree via `git ls-files --others --exclude-standard`
 * (review.ts) and checkoutFingerprint via `git status --porcelain` (worktree.ts). So in a repo that
 * gitignores `.serena/` (heddle itself does), a write under it — including agent-authored
 * `.serena/memories/` / `.serena/project.yml` — never reaches this predicate and is invisible to
 * BOTH guards, like any ignored artifact (node_modules/, dist/, .env). This predicate only NARROWS
 * exclusions among already-enumerated paths; it neither introduces nor closes that ignored-path gap
 * (round-2 code had the identical property). HED-569 tracks whether to enumerate authored
 * tool-runtime paths even when ignored.
 *
 * Known, bounded blind spot (operator-gated, HED-550): an UNTRACKED write directly under one of these
 * three daemon dirs is indistinguishable from daemon churn by path alone, so it is also excluded.
 * Accepted because the alternative — no exclusion — makes the guard false-fire on every consumer
 * review until it is ignored, which is strictly worse; the zone is three tool-owned dirs, a write
 * there cannot enter a merge (untracked) or touch source, and destroyed daemon state is re-derivable.
 */
const TOOL_RUNTIME_PREFIXES = ['.memdb/', '.memtrace/', '.serena/cache/', '.verity/.logs/'] as const;

/**
 * HED-699: Verity's hook runtime state. Its hooks run inside every headless Claude worker (the consumer
 * repo's `.claude/settings.json`) and rewrite hidden files directly under `.verity/`
 * (`.conversation-buffer`, `.last-analysis.<id>`, `.iteration-count`, …) plus `.verity/.logs/`, so a
 * read-only reviewer with NO write tools was quarantined on every run in a Verity repo (ledger 2237).
 * Same narrowness as `.serena/cache/`: only HIDDEN files directly under `.verity/` and `.verity/.logs/`
 * are churn. `.verity/memory/**` (the knowledge graph), `.verity/config.json` and anything nested
 * deeper stay visible to both guards. Operator-gated, like the list above (HED-550).
 */
const VERITY_RUNTIME_FILE = /^\.verity\/\.[^/]+$/;

export const isToolRuntimePath = (rel: string): boolean =>
  TOOL_RUNTIME_PREFIXES.some((prefix) => rel.startsWith(prefix)) || VERITY_RUNTIME_FILE.test(rel);
