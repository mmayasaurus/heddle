# Phase 1 — Orchestration mechanisms (build this FIRST)

> Goal: turn the consumer project's fleet of Claude sessions into **orchestrators** that
> decompose their claimed Linear issues and dispatch sub-tasks to best-fit models — usable for
> real work in the first consumer project while the dashboard is built in parallel. Nothing here requires the GUI.
> Decisions locked 2026-08-03.

## What an orchestrator does (the loop we're enabling)

1. Claims ABC issue via existing `lin.sh` (unchanged — Commandment protocol intact).
2. Decomposes it into sub-tasks and classifies each (task class → routing table).
3. Dispatches each sub-task to the right model with the right skill pack.
4. Integrates results, verifies, and drives the PR to green using existing `pr-own`/`pr-sweep`.
5. Records every dispatch to the ledger; asks operator via the needs-attention queue when blocked.

## Build list

### 1. `heddle` CLI (the dispatcher)
- `heddle dispatch --class <task-class> --task "<prompt>" [--files …] [--account <n>]`
  → consults `routing/routing.v0.yaml`, materializes the skill pack, calls the adapter, records
  to the ledger, returns structured result (+ resume handle for follow-ups).
- `heddle workers` — what's in flight for this orchestrator (name, model, task, elapsed, usage).
- `heddle resume <worker> "<message>"` — continue a worker with its provider-native resume handle.
- `heddle ledger [--issue ABC-123]` — dispatch history; feeds dashboard + savings stats later.
- Exit codes + JSON output so both agents and the future GUI consume the same surface.

### 2. Heddle MCP server (how orchestrators actually call it)
Exposes the CLI as tools so any MCP-capable CLI (Claude, Codex, Cursor, agy) can orchestrate:
`dispatch_worker`, `check_workers`, `resume_worker`, `worker_result`,
plus chat tools (§4): `chat_post`, `chat_read`, `chat_broadcast`, `chat_dm`.
Registered per-project in `.mcp.json`; deferred-loading friendly (tool schemas on demand).

### 3. Skill packs (`skills/` in this repo)
Portable instruction bundles composed per dispatch, materialized into the worker's cwd/agent def:
- Claude workers → agent-definition frontmatter (`skills:`, `mcpServers:`, `permissionMode`).
- Codex / agy workers → `AGENTS.md` written into the worktree (both auto-load it).
- Cursor workers → `AGENTS.md` (+ `.cursor/rules` if needed; it also reads `CLAUDE.md`).
Packs start small and consumer-project-specific: `sleek-style`, `social-style`, `db-supabase-dev`,
`testing-vitest`, `pr-sweep-etiquette`, `worktree-discipline`, `memtrace-first`.
**Lean by default** — measured overhead is real (≈22k input tokens/invocation on a fully-loaded
global Codex config, ≈18k on agy). Packs attach only what the task needs.

### 4. Chatroom (fleet comms) — PULL model, per operator 2026-08-03
- **Not push-injected into context.** Agents **check the room when they want** to know what the
  fleet is doing. This keeps token cost near-zero when quiet.
- **`@all` broadcast is the guaranteed-delivery exception**: an `@all` (or a direct `@AgentB`
  mention) fires a notification the target agent will see — via its Monitor subscription — so
  important messages don't wait for a poll.
- **Culture: conservative by design.** The room is for: needing another opinion, answering
  someone else's question, announcements affecting multiple agents, and open questions where the
  right responder is unknown. Not chatter, not narration.
- **Subagents may post, but sparingly** — e.g. a worker stuck on something asking for an assist.
- **Subagent↔subagent and subagent↔host DMs** are first-class, not only room posts. operator can DM
  any agent or subagent.
- Implementation: broker thread + a small TUI client → **works in plain iTerm tabs before any
  GUI exists**.

### 5. Ledger + hooks
- SQLite: dispatches (orchestrator, worker, provider, model, skills, task class, ABC issue, PR,
  usage, duration, outcome), chat messages, needs-attention items, session registry.
- Worker-scoped hook configs (never edits operator's global CLI configs) append activity events —
  all four CLIs have JSON-on-stdin hook systems.

### 6. Docs / rules integration
- `.claude/rules/` stub in the consumer project repo pointing at the orchestration protocol (load-on-
  demand, consistent with the lean-session pattern).
- Update `CLAUDE.md` / `AGENTS.md` minimally: how to orchestrate, when NOT to (trivial tasks stay
  in-session), and that Linear/PR protocols are unchanged.
- `/orchestrate` slash command: decompose-and-dispatch helper for the current claimed issue.

## Thinking visibility — VERIFIED 2026-08-03 (affects what the UI can ever show)

| Worker | Thinking content in stream? | Evidence |
|---|---|---|
| **Cursor** | **YES — full text**, streamed | `{"type":"thinking","subtype":"delta","text":"Analyzing the riddle…"}` events observed live |
| **Claude** | **YES** — thinking blocks in stream-json / transcript when enabled | documented; in-session subagents surface it |
| **Codex** | **NO** — only `agent_message` items; reasoning is token-counted (`reasoning_output_tokens`) but content is not emitted | live test at medium effort produced zero reasoning items |
| **agy / Gemini** | **NO** — `step_update` events give step type + response `text_delta`; thinking is counted (`thinking_tokens`) but content withheld | live test observed steps `user_input`/`agent_response`/`checkpoint` only |

⇒ "Show thinking" is a real feature for Cursor and Claude workers; for Codex and Gemini the UI
shows step/progress + reasoning-token counts and must say so rather than implying it has more.

## Build order within Phase 1

1. Ledger + `heddle dispatch` CLI (adapters already exist and are verified).
2. Skill-pack materializer + first 3 packs.
3. Heddle MCP server + `/orchestrate` command + rules stub.
4. Chatroom broker + TUI client (`@all`, `@agent`, DMs, pull-by-default).
5. **Pilot on one real ABC issue** with an existing consumer-project fleet agent; measure tokens/outcome vs an
   all-Claude baseline; tune the routing table from ledger data.
6. Roll out to the rest of the consumer project's fleet.

Then Phase 2+: terminal substrate (tmux) → Electron shell → Linear/GH pane → stats screen.
