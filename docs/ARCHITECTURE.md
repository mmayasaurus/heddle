# Heddle architecture

Five layers. L0 belongs to the consumer project; Heddle builds L1–L4. Phases map 1:1 onto layers.

## L0 · Foundation (consumer-owned, never replaced)

Issue tracking (e.g. Linear), PR ownership conventions, agent identities, worktree discipline,
code-graph tooling. Heddle links into these (ledger references, identity reuse) and must remain
useful without owning any of them.

## L1 · Worker layer (Phase 1 — current)

- **Adapters** (`src/adapters/`): one per CLI, implementing `WorkerAdapter` (`src/types.ts`) —
  launch-command construction, instruction injection, structured-output parsing, resume handles.
  Verified invocation contracts are annotated in each adapter and in `docs/LANDMINES.md`.
  - `codex` — subprocess, `codex exec --json`, stdin closed.
  - `cursor` — subprocess, `cursor-agent -p --output-format json --trust`; supplemental models only.
  - `claude` — NOT a subprocess: in-session subagents of the interactive orchestrator (see
    `src/adapters/claude.ts` for rationale); Heddle generates agent definitions instead of spawning.
- **Routing table** (`routing/*.yaml`): task-class → provider/model/effort/skill-pack/flags with
  fallback chains and pool guards. Consulted by orchestrators at dispatch; every decision logged.
- **Skill packs**: portable instruction bundles (Agent Skills / SKILL.md standard where supported)
  materialized per dispatch into the worker's cwd or agent definition — Claude: agent frontmatter
  `skills:`; Codex: AGENTS.md hierarchy; Cursor: AGENTS.md / `.cursor/rules`.

## L2 · Comms broker (Phase 2)

The industry-gap piece: real cross-session, cross-provider agent conversations.

- **Store**: SQLite append-only message log — `from`, `to`, `thread`, task ref (e.g. ABC issue),
  session, model, type (`chat` | `handoff` | `status` | `needs-human` | `permission-request`),
  body, timestamps.
- **Push**: WebSocket feed; one row = one frame.
- **Agent surface**: an MCP server exposing `send_message` / `await_reply` (server-side long-poll —
  gives ANY MCP-consuming CLI mid-task back-and-forth) / `check_inbox`. Identical tools regardless
  of provider.
- **Delivery**: interactive Claude orchestrators subscribe via a persistent Monitor on the WS feed
  (near-instant event delivery); mid-task workers long-poll; exited workers get queued messages on
  re-invocation via their adapter resume handle.
- **Structure**: declarative allowed-flows graph (who may initiate to whom) and structured handoff
  payloads (required `key_moments` / `decisions` / `artifacts` fields) — both patterns adapted from
  agency-swarm (MIT).
- **The human is a first-class address**: `needs-human` / `permission-request` messages form the
  operator's queue; the operator can read and inject into any thread.

## L3 · Ownership glue (Phase 2–3, thin)

A sub-task ledger tying every dispatch (worker, model, skills, flags) to its parent issue and
branch/PR. The consumer's tracker stays canonical; the ledger exists so no sub-task orphans and the
dashboard can render task division per issue.

## L4 · Dashboard (Phase 3)

Localhost web app, **visibility only** — terminals stay in the operator's own terminal app.
Reads the broker DB + a hook-event log (all supported CLIs ship JSON-on-stdin hook systems; Heddle
installs project/worker-scoped hooks only — never edits user-global CLI configs).

Views: fleet roster (who's alive, model, current task) · task board + division per issue · live
conversation threads · needs-human queue · per-provider usage meters, routing log, and the savings
stat. Savings model: per-run token counts from each adapter's structured output; headline metric is
% of work routed off the primary pool + per-provider consumption trends (flat-rate subscriptions
make "dollars saved" ill-defined; preserved headroom is the honest measure). Optional statusline
integration: a segment command (e.g. for claude-hud `--extra-cmd`) printing the session's active
workers + models into the operator's terminal statusline.

## Policy invariants (enforced in code, not just docs)

1. Subscriptions only — adapters never accept API keys.
2. Never route a model through a middleman when a direct subscription exists (e.g. no Claude/GPT/
   Gemini ids through the Cursor adapter — enforced by an allowlist check).
3. Metered pools get route-away guards; on-demand overage is never triggered.
4. Exit-0-with-empty-output is failure everywhere.
5. Model catalogs are volatile: adapters surface unknown-model errors; routing fallbacks handle them.

## Phase status

- **Phase 0 (verify/provision): done** for Codex + Cursor + Claude (receipts in LANDMINES.md);
  Gemini held pending Antigravity research.
- **Phase 1 (this repo, current)**: adapters ✚ routing v0 scaffolded; next: skill-pack
  materializer, orchestrator dispatch skill, pilot on one real issue with ledger capture.
- **Phase 2**: broker + Monitor wiring + flows/handoff schema.
- **Phase 3**: dashboard MVP.
- **Phase 4**: savings analytics, fleet-wide rollout.
