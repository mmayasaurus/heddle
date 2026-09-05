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
server, skill-pack materialization, and adversarial review. Phase 2 (comms broker) is built in its
core — durable append-only log, trust tiers, delivery, the `heddle-comms` channel server, and fleet
pause/quiesce (`docs/COMMS.md`); its needs-human queue, room governance, non-Claude transport
bridges, and dashboard WebSocket push remain (`docs/COMMS.md` → Roadmap). Phase 3 is the
**dashboard**, which lives in its own repo
(`heddle-dashboard`, a Tauri fork of VelaTerm) and consumes heddle's ledger + comms. The test
suite is behavioral vitest (`npm test`). See `docs/ARCHITECTURE.md` and, first, `docs/SPEC.md`.

**Read first: `docs/SPEC.md`** (the single source of truth). Detail: `docs/ORCHESTRATION.md`
(Phase-1 mechanics) · `docs/MODELS.md` (routing/task-class narrative + cap-aware/Fable budget) ·
`docs/ARCHITECTURE.md` (layers) · `docs/COMMS.md` (broker) · `docs/DASHBOARD.md` (the
`heddle-dashboard` product) · `docs/LANDMINES.md` (live-verified per-CLI contracts — read before
touching an adapter) · `docs/CI.md` (CI, scanners, review-sweep).

First consumer: the Spinventory rebuild fleet. Heddle itself is project-agnostic — the consumer
supplies its own routing table, Linear team, and ownership systems.

## Install as a Claude Code plugin

Heddle ships as a Claude Code plugin (`.claude-plugin/`), bundling the `heddle` (dispatch surface)
and `heddle-comms` (inter-agent messaging) MCP servers so any Claude Code session can drive the fleet.

**From a built checkout** (works today):

```shell
git clone https://github.com/OWNER/heddle.git && cd heddle   # OWNER = the repo owner
npm install && npm run build           # produce dist/ (the two MCP servers)
PLUGIN_DIR="$(pwd)"                     # remember the plugin's location, then…
cd /path/to/your/project               # …launch from YOUR project — NOT the heddle checkout
claude --plugin-dir "$PLUGIN_DIR"      # so dispatched workers target your project, not heddle's source
```

Once loaded, the `plugin:heddle:heddle` and `plugin:heddle:heddle-comms` MCP tools are available. The
plugin resolves every path from `${CLAUDE_PLUGIN_ROOT}`, so it works from wherever the checkout lives
— no machine-specific paths. Verify a checkout with `claude plugin validate .`.

The `heddle-comms` tools need a per-session agent identity (`HEDDLE_AGENT`); without one, comms
operations fail with `no bound comms identity`. Establishing accounts and identity is the onboarding
wizard's job (a follow-up slice) — until then, set `HEDDLE_AGENT=<name>` in the session yourself.

**One-command marketplace install** — `/plugin marketplace add <owner>/heddle` then
`/plugin install heddle@heddle` — resolves against the same-repo marketplace
(`.claude-plugin/marketplace.json`, `source: "./"`), but is **not usable from this source tree**:
build output is kept out of source (`dist/` is gitignored), so a bare clone has no runnable servers.
The install-ready build is a follow-up slice — a standalone CLI-only distribution **regenerated from
this source** and scrubbed for public readiness, shipping a self-contained plugin (built `dist/` plus
the lockfile, so `npm ci` supplies the servers' dependencies with **no user build step**). Until that
lands, use the built-checkout flow above.

> This slice delivers the MCP servers + the plugin/marketplace structure. Still to come as follow-up
> slices of the packaging epic (HED-394): the release-generated distribution build, the orchestrator
> slash commands, the rules-as-data hook engine, and the packaged skill packs.

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
   app** — `heddle-dashboard`, built as a Tauri fork of VelaTerm — that visualizes the fleet and
   hosts in-app terminals; it consumes heddle's ledger and comms, it is not heddle itself.
   (`docs/DASHBOARD.md` holds the product vision — panes, roster, embedded terminals — and supersedes
   the earlier "browser only, no embedded terminals" scope; its 2026-08-03 *Electron* shell decision
   predates the VelaTerm/Tauri choice and is being reconciled — HED-177.)
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
src/dispatcher/          the dispatcher's modules: types · packs · adapters · refusals · override-gate · monoculture · plan · run (src/dispatch.ts keeps dispatch() + re-exports)
src/routing.ts           routing-table loader + resolveRoute
src/capaware.ts          cap-aware routing (HED-67) + Claude account switching (HED-68) + Fable budget (HED-76)
src/ledger.ts            SQLite dispatch/review ledger (node:sqlite; ~/.heddle/ledger.db)
src/cli.ts               the `heddle` CLI (dispatch · route · classes · usage · reviews · ledger · …)
src/mcp-server.ts        the `heddle-mcp` MCP server (dispatch_worker, list_task_classes, plan_dispatch, assess_result, …)
src/types.ts             WorkerAdapter contract (ports-and-adapters)
src/adapters/            codex · cursor · agy (subprocess, verified) · claude (in-session protocol) · parse
src/comms/               comms broker: log · server · channel-server (`heddle-comms`) · seal (trust) · quiesce/nudge · bridge
src/skillpacks.ts        skill-pack materialization (AGENTS.md / --append-system-prompt)
src/review.ts            adversarial-review reviewer selection (HED-3)
src/classify.ts          effort classification + assess
src/identity.ts          orchestrator/worker fleet identity
src/worktree.ts          worktree confinement + destroyed-work detection
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
plan), `agy` (Antigravity/Google). Claude models default to **headless** dispatch — `ClaudeAdapter`
spawns the `claude` CLI as `claude -p …` — so that binary must be installed and logged in too; only
the opt-in `--in-session` / `in_session:true` path spawns nothing (it returns an instruction for
your interactive session's Agent tool instead).

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
// .mcp.json (in your consumer project, or your Claude config). This repo ships its own
// .mcp.json for heddle-comms sessions opened here; this is the separate generic MCP entry.
{
  "mcpServers": {
    "heddle": { "command": "node", "args": ["/abs/path/to/heddle/dist/mcp-server.js"] }
  }
}
```

After `npm run build` the package declares bins: `heddle` (CLI), `heddle-mcp` (MCP server),
`heddle-comms` (comms channel server), `heddle-rotator`, `heddle-hook-dispatch-guidance`. It is a
private, unpublished package, so these are **not** on your `PATH` after `npm install` — run
`npm link` (or a global install) to expose them, or invoke the built files directly (`node
dist/cli.js …`, as the MCP snippet above does).

### Verify harness health

Run `heddle doctor` before onboarding an account or starting a session. It checks the configured
harness binaries, login state, live model catalogs where supported, routing/config parsing, and
provider verification freshness; `--provider` runs only that provider's checks plus global config
checks (including valid API providers such as `groq`), and `--json` returns
the same typed report. Cursor catalog omissions fail; an `agy` catalog omission warns because a new
Gemini model can work before its catalog lists it (see `docs/MODELS.md`). It exits 1 only when a check
fails; exit 0 means no failures (including timed-out, unverified probes, which warn), and exit 2 is a
usage error.

Framework-layer config lives under `~/.heddle/` (it spans projects, never a single repo):
`accounts.json` (Claude accounts), `ledger.db` (dispatch/review ledger), `comms.db` (broker).
Environment overrides:

| var | what |
|-----|------|
| `HEDDLE_AGENT` | this session's orchestrator identity (e.g. `U`); also honors `FLEET_AGENT` or a `.fleet-agent` file |
| `HEDDLE_ROUTING` | routing-table path (default `routing/routing.v0.yaml`) |
| `HEDDLE_LANES` | lanes configuration path (default `routing/lanes.yaml`) |
| `HEDDLE_ACCOUNTS` | Claude accounts registry path (default `~/.heddle/accounts.json`) — cap-aware routing reads it |
| `HEDDLE_PACKS` | extra skill-pack search dirs, `path.delimiter`-separated (`:` on POSIX, `;` on Windows); built-ins always last |
| `HEDDLE_COMMS_DB` | comms broker db (default `~/.heddle/comms.db`) |
| `HEDDLE_LEDGER_DB` | dispatch/review ledger db (default `~/.heddle/ledger.db`) — comms server + rotator read it for lineage |

(`HEDDLE_DISPATCH_ID` / `HEDDLE_PARENT` / `HEDDLE_WORKER` are set by heddle on spawned workers — not
operator config.)

Tests are behavioral (assert what a change DOES, not that a toggle toggles) and never touch the
operator's real ledger — construct `new Ledger(<temp path>)`, see `test/ledger.test.ts`. CI,
scanners, and the review-sweep rules: [`docs/CI.md`](docs/CI.md).
