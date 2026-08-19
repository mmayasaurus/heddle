# Heddle

> The heddle is the part of a loom that lifts and separates the warp threads so the shuttle can
> pass — the small piece that coordinates every thread. This is that, for a fleet of AI coding
> agents.

Heddle is a **cross-provider agent orchestration layer** for subscription coding CLIs. Orchestrator
sessions (Claude Code, interactive, in your own terminal tabs) claim issues, split them into
sub-tasks, and dispatch each sub-task to the best-fit model — running on **your existing provider
subscriptions, never per-token API billing** — with task-specific skill packs, real inter-agent
messaging, and a companion dashboard for full visibility.

**Status.** Phase 1 (orchestration) is built and in daily use: the `WorkerAdapter` contract +
verified per-CLI invocation (`src/adapters/`), the routing table + cap-aware routing + Claude
account switching, the dispatcher, the SQLite ledger, the `heddle` CLI, the `heddle-mcp` MCP
server, skill-pack materialization, and adversarial review. Phase 2 (comms broker) is built —
durable append-only log, trust tiers, delivery, the `heddle-comms` channel server, and fleet
pause/quiesce (`docs/COMMS.md`). Phase 3 is the **dashboard**, which lives in its own repo
(`heddle-dashboard`, a Tauri fork of VelaTerm) and consumes heddle's ledger + comms. The test
suite is behavioral vitest (`npm test`). See `docs/ARCHITECTURE.md` and, first, `docs/SPEC.md`.

**Read first: `docs/SPEC.md`** (the single source of truth). Detail: `docs/ORCHESTRATION.md`
(Phase-1 mechanics) · `docs/MODELS.md` (routing/task-class narrative + cap-aware/Fable budget) ·
`docs/ARCHITECTURE.md` (layers) · `docs/COMMS.md` (broker) · `docs/DASHBOARD.md` (the
`heddle-dashboard` product) · `docs/LANDMINES.md` (live-verified per-CLI contracts — read before
touching an adapter) · `docs/CI.md` (CI, scanners, review-sweep).

First consumer: the Spinventory rebuild fleet. Heddle itself is project-agnostic — the consumer
supplies its own routing table, Linear team, and ownership systems.

## The rules that shape everything

1. **Subscriptions only.** Every execution path is a subscription-authenticated CLI: Claude models
   via interactive Claude Code sessions and their in-session subagents; GPT models via `codex exec`
   (ChatGPT plan); Gemini models via `agy` (Antigravity CLI, Google plan); supplemental models
   (Kimi K3, Composer, Grok, GLM, …) via `cursor-agent` (Cursor plan's included pool). No API keys
   in any execution path, ever.
   **Corollary — we drive each vendor's own official binary, never a third-party client wearing
   its credentials.** Google's Antigravity FAQ, for instance, prohibits using third-party software
   with an Antigravity login (suspension/termination grounds) while its own docs demonstrate
   scripting `agy -p --output-format json` in CI. Heddle is squarely the latter: official binaries,
   official auth, no token extraction or credential proxying — for any provider.
2. **Never route a model through a middleman when a direct subscription exists.** Cursor carries
   Claude/GPT/Gemini models in its catalog — Heddle must never select them there; it uses Cursor
   only for models with no direct subscription.
3. **Orchestrators are humans' terminal tabs.** An orchestrator is an interactive Claude Code
   session in a human's own terminal tab; Heddle never owns that terminal. The GUI is a **separate
   app** — `heddle-dashboard`, a Tauri fork of VelaTerm — that visualizes the fleet and hosts
   in-app terminals; it consumes heddle's ledger and comms, it is not heddle itself. (Earlier specs
   said "browser only, no embedded terminals"; Maya's expanded vision, `docs/DASHBOARD.md`,
   supersedes that.)
4. **Ownership is external and canonical.** Issue tracking (Linear) and PR ownership live in the
   consumer project's existing systems; Heddle links its sub-task ledger to them, never replaces
   them.
5. **Route away, never overage.** Metered-pool providers (Cursor "Other Models") get a guard
   threshold; when a pool nears exhaustion, work routes elsewhere rather than incurring on-demand
   charges.

## Layout

```
routing/routing.v0.yaml  routing table: task-class → provider/model/effort/skills (+why, edits_code)
src/dispatch.ts          the dispatcher: task class → routed worker → recorded outcome (+refusals)
src/routing.ts           routing-table loader + resolveRoute
src/capaware.ts          cap-aware routing (HED-67) + Claude account switching (HED-68) + Fable budget (HED-76)
src/ledger.ts            SQLite dispatch/review ledger (node:sqlite; ~/.heddle/ledger.db)
src/cli.ts               the `heddle` CLI (dispatch · route · classes · usage · reviews · ledger · …)
src/mcp-server.ts        the `heddle-mcp` MCP server (dispatch_worker, list_task_classes, plan_dispatch, assess_result, …)
src/types.ts             WorkerAdapter contract (ports-and-adapters)
src/adapters/            codex · cursor · agy (subprocess, verified) · claude (in-session protocol) · parse
src/comms/               comms broker: log · server · channel-server (`heddle-comms`) · seal (trust) · quiesce/nudge · bridge
src/skillpacks.ts        skill-pack materialization (AGENTS.md / --append-system-prompt)
src/review.ts            adversarial-review reviewer selection (HED-3); src/classify.ts  effort classification + assess
src/identity.ts          orchestrator/worker fleet identity; src/worktree.ts  worktree confinement + destroyed-work detection
src/rotate/              fleet rotator (account rotation)
src/guidance.ts + src/hook-dispatch-guidance.ts   dispatch-time guidance rules + the PreToolUse hook
src/smoke.ts             `node dist/smoke.js <adapter> "<prompt>"` — one-shot adapter round-trip
docs/                    SPEC · ORCHESTRATION · ARCHITECTURE · MODELS · COMMS · DASHBOARD · LANDMINES · CI · …
test/                    vitest behavioral suites (`npm test`)
```

Dispatch-time guidance (HED-1): `list_task_classes` / `heddle classes` return each class's `why`,
default `skills`, `edits_code`, `execution`; the PreToolUse hook `dist/hook-dispatch-guidance.js`
nudges on no-task-fit-packs / missing opt-in (never blocks). Semantics + registration snippet:
`docs/MODELS.md` → "Dispatch-time surfacing".

## Install & register

Prerequisites: **Node ≥ 22.12** (`node:sqlite` needs 22.5+; vitest 4's vite/rolldown declare
`>=22.12.0`, and `package.json` `engines` pins it so older 22.x fail fast at install). Plus a
logged-in CLI for each provider you dispatch to — `codex` (ChatGPT plan), `cursor-agent` (Cursor
plan), `agy` (Antigravity/Google). Claude models run in your interactive Claude Code session, not a
spawned binary, so they need no separate CLI.

```bash
npm install
npm run build          # tsc → dist/
npm run typecheck      # tsc --noEmit over src/ AND test/ (tsconfig.test.json)
npm test               # vitest run — behavioral suites under test/**/*.test.ts (no build needed)
node dist/smoke.js cursor "Reply with exactly: OK"   # requires cursor-agent login
node dist/smoke.js codex  "Reply with exactly: OK"   # requires codex login
```

Register the MCP server with your MCP client (Claude Code, etc.) — point it at the built entry:

```jsonc
// .mcp.json (in your consumer project, or your Claude config) — no .mcp.json ships in this repo
{
  "mcpServers": {
    "heddle": { "command": "node", "args": ["/abs/path/to/heddle/dist/mcp-server.js"] }
  }
}
```

After `npm run build` the package also exposes bins: `heddle` (CLI), `heddle-mcp` (MCP server),
`heddle-comms` (comms channel server), `heddle-rotator`, `heddle-hook-dispatch-guidance`.

Framework-layer config lives under `~/.heddle/` (it spans projects, never a single repo):
`accounts.json` (Claude accounts), `ledger.db` (dispatch/review ledger), `comms.db` (broker).
Environment overrides:

| var | what |
|-----|------|
| `HEDDLE_AGENT` / `FLEET_AGENT` / a `.fleet-agent` file | this session's orchestrator identity (e.g. `U`) |
| `HEDDLE_ROUTING` | routing-table path (default `routing/routing.v0.yaml`) |
| `HEDDLE_PACKS` | extra skill-pack search dirs (colon-separated; built-ins always last) |
| `HEDDLE_COMMS_DB` | comms broker db (default `~/.heddle/comms.db`) |

(`HEDDLE_DISPATCH_ID` / `HEDDLE_PARENT` / `HEDDLE_WORKER` are set by heddle on spawned workers — not
operator config.)

Tests are behavioral (assert what a change DOES, not that a toggle toggles) and never touch the
operator's real ledger — construct `new Ledger(<temp path>)`, see `test/ledger.test.ts`. CI,
scanners, and the review-sweep rules: [`docs/CI.md`](docs/CI.md).
