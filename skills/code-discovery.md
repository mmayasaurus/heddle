Discovering and navigating code in this repo — use the graph/symbol tools, not blind grep.

This repo is indexed by **Memtrace** (and Claude/Codex sessions also have **Serena** LSP symbol
tools). When these are attached to your session, prefer them for discovery, impact analysis, and
tracing — they are faster and more accurate than reading files blindly:

- You know the symbol's NAME (function/class/type) → `find_symbol` / `find_referencing_symbols`,
  and symbol-level edits. (Serena reads the live working tree; Memtrace also has `find_symbol`.)
- You only know the MEANING ("where is X handled?") → Memtrace `find_code` (semantic search),
  `get_symbol_context`, and decision/history recall.
- About to CHANGE a symbol → Memtrace `get_impact` FIRST to see the blast radius, then edit.
- A zero-result query is NOT proof the code is absent — broaden the query or check scope. It is
  never a reason to fall back to grepping the whole tree.
- Do NOT full-reindex a worktree; saved edits are picked up incrementally.

If these tools are NOT attached to your session, say so plainly in your result and use ordinary
search as a fallback — never claim to have queried a graph you could not actually reach.
