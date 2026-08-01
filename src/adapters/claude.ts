/**
 * Claude worker "adapter" — a protocol, not a subprocess.
 *
 * Claude-side workers run as in-session subagents / background agents of the interactive
 * orchestrator session (its native Agent tool), NOT as `claude -p` subprocesses spawned by
 * Heddle. Rationale (verified 2026-08-01):
 *  - shares the orchestrator's prompt cache → materially cheaper;
 *  - draws on the flat subscription pool with zero billing ambiguity;
 *  - per-agent `skills` / `mcpServers` / `permissionMode` / `model` are native subagent
 *    frontmatter — Heddle's skill packs map 1:1 onto agent definitions.
 *
 * What Heddle provides for Claude workers is therefore not a spawner but:
 *  1. generated agent definitions (.claude/agents/*.md) materialized from skill packs +
 *     routing-table entries, and
 *  2. the dispatch ledger entry (task ↔ SPI issue ↔ session), reported by the orchestrator.
 *
 * A `claude -p` subprocess fallback is deliberately NOT implemented yet: if it becomes
 * necessary (e.g. workers outliving orchestrators), see docs/LANDMINES.md first — permission-mode
 * `auto` aborts headless sessions; resume drops --mcp-config/--settings and is cwd-scoped;
 * bypassPermissions needs a one-time interactive accept per machine.
 */

export const CLAUDE_WORKER_PROTOCOL_VERSION = 0;

/** Task classes the routing table sends to Claude, for reference by generators. */
export type ClaudeWorkerModel = 'fable' | 'opus' | 'sonnet' | 'haiku';
