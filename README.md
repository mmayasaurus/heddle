# Heddle

> The heddle is the part of a loom that lifts and separates the warp threads so the shuttle can
> pass — the small piece that coordinates every thread. This is that, for a fleet of AI coding
> agents.

Heddle is a **cross-provider agent orchestration layer** for subscription coding CLIs. Orchestrator
sessions (Claude Code, interactive, in your own terminal tabs) claim issues, split them into
sub-tasks, and dispatch each sub-task to the best-fit model — running on **your existing provider
subscriptions, never per-token API billing** — with task-specific skill packs, real inter-agent
messaging, and a localhost dashboard for full visibility.

**Status: Phase 1 (orchestration) — adapters verified, dispatcher next.** Verified invocation contracts for Codex and
Cursor are encoded in `src/adapters/`; the routing table schema is drafted; the comms broker
(Phase 2) and dashboard (Phase 3) are designed but not yet built. See `docs/ARCHITECTURE.md`.

Docs: `docs/ORCHESTRATION.md` (Phase 1 — what's being built now) · `docs/DASHBOARD.md`
(the product vision) · `docs/ARCHITECTURE.md` (layers) · `docs/LANDMINES.md` (verified CLI gotchas).

First consumer: the Spinventory rebuild fleet (architecture record:
`Spinventory-Rebuild-App/_vault/architecture/agent-orchestration-plan.md`). Heddle itself is
project-agnostic.

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
3. **Orchestrators are humans' terminal tabs.** Heddle never owns the terminal experience — no
   Electron shell, no embedded PTYs in v1. The dashboard is additive, in a browser.
4. **Ownership is external and canonical.** Issue tracking (Linear) and PR ownership live in the
   consumer project's existing systems; Heddle links its sub-task ledger to them, never replaces
   them.
5. **Route away, never overage.** Metered-pool providers (Cursor "Other Models") get a guard
   threshold; when a pool nears exhaustion, work routes elsewhere rather than incurring on-demand
   charges.

## Layout

```
docs/ARCHITECTURE.md   five-layer design: workers · routing · broker · ownership · dashboard
docs/LANDMINES.md      live-verified per-CLI gotchas (read before touching adapters)
routing/routing.v0.yaml routing table draft: task-class → provider/model/effort/skills
src/types.ts           WorkerAdapter contract (ports-and-adapters)
src/adapters/          codex · cursor (subprocess, verified) · claude (in-session protocol)
src/smoke.ts           `npm run build && node dist/smoke.js <adapter> "<prompt>"`
```

## Dev

```bash
npm install
npm run build          # tsc
node dist/smoke.js cursor "Reply with exactly: OK"   # requires cursor-agent login
node dist/smoke.js codex  "Reply with exactly: OK"   # requires codex login
```
