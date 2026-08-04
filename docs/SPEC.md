# Heddle — Master Specification

> **Single source of truth for the whole heddle plan.** Authoritative where it conflicts with
> older docs. Last consolidated 2026-08-04 after the full ecosystem research pass (omp, Paseo,
> Conductor, OpenChamber, Superset, Happy Coder). Companion docs carry the detail:
> `ARCHITECTURE.md` (layers), `ORCHESTRATION.md` (Phase-1 mechanics), `DASHBOARD.md` (UI vision —
> its tmux references are SUPERSEDED here), `LANDMINES.md` (verified per-CLI contracts — the
> ground truth for anyone touching an adapter). Session-durable research detail lives in the
> `project-agent-orchestration-lane` memory.

---

## 0. What heddle is

A **cross-provider agent orchestration layer** for subscription coding CLIs. Claude (Fable 5)
orchestrator sessions — the operator's own interactive terminal tabs — claim Linear SPI issues,
decompose them, and dispatch sub-tasks to the best-fit model per task, each worker loaded with only
the skills/tools it needs. Agents converse across sessions and providers, everything is observable
on a localhost dashboard, and work follows the existing Linear→PR ownership discipline to
completion. Project-agnostic; Spinventory is the first consumer.

**Two prime directives:** reduce usage of the expensive models (route work down/sideways when a
cheaper or better-suited model wins) and improve outcomes (right model + right skills per task).

Repo: `github.com/mmayasaurus/heddle` (private). Runtime: Node 22 + TypeScript, zero-native-dep
(uses built-in `node:sqlite`).

---

## 1. Hard constraints & the trilemma

1. **Subscriptions only — never per-token API billing.** Enforced in code (`src/env.ts` strips
   every API-key/base-URL/cloud-provider env var from worker processes and refuses them as
   overrides — because each vendor treats an API key as a silent switch off the subscription, with
   no prompt in headless mode).
2. **Official vendor CLIs as subprocesses only.** We drive each vendor's own sanctioned binary. We
   REJECTED the omp/OpenChamber approach (a third-party client reimplementing provider OAuth) on
   ToS/ban-risk grounds — it's the pattern that got the Gemini OAuth plugin's users banned, and
   Anthropic actively announced-then-paused a policy targeting even the official-SDK third-party
   path (2026-05-13→06-15). Official CLI = sanctioned + subscription.
3. **Never route a model through a middleman when a direct subscription exists.** Cursor carries
   Claude/GPT/Gemini in its catalog; heddle refuses them there (`CursorAdapter` guard) so a routing
   typo can't spend the wrong pool. Cursor is for supplemental models only (Grok, Composer, Kimi).

**The trilemma (the framing that governs every "can we get X efficiency" question):** you can have
at most two of { own the model's inner loop · use the subscription not the API · stay
vendor-sanctioned }. Official-CLI-subprocess = subscription + sanctioned, but the CLI is a black
box (we can't inject compaction/edit/thinking tricks into it). That's the deliberate trade. It
means most of omp's marquee efficiency tricks (pixel-font compaction, hash-editing, mid-stream
rules) are OFF the table; the harness-independent wins (a tiny background model, per-dispatch effort
choice, MCP tool-gating) are IN.

---

## 2. Providers & billing map

| Provider | Auth | How heddle drives it | Models | Effort knob |
|---|---|---|---|---|
| **Claude** | Anthropic subscription | In-session subagents of the interactive orchestrator (NOT a spawned `claude -p`) — shares the orchestrator's prompt cache, flat pool | fable/opus/sonnet/haiku | `--effort` / thinking |
| **Codex** | ChatGPT subscription | `codex exec --json` subprocess | gpt-5.6-sol/terra/luna | `-c model_reasoning_effort` (minimal…xhigh) |
| **Gemini** | Google subscription | Antigravity `agy -p --output-format stream-json` subprocess | gemini-3.6-flash / 3.5-flash / 3.1-pro (low/med/high) | `--effort` (low/med/high) |
| **Cursor (supplemental only)** | Cursor subscription (browser login — NOT an API key) | `cursor-agent -p --output-format json` subprocess | kimi-k3, composer-2.5, cursor-grok-4.5 | effort baked into model id (`-low/-medium/-high`) |
| ~~Ollama Cloud~~ | — | EXCLUDED (reserved for the PR-reviewer fleet; account-scoped limits must not contend) | — | — |

**Gemini-CLI is dead for personal subs** (Google cut it off 2026-06-18); Antigravity `agy` is the
sanctioned successor — verified working headless, incl. the #573 concurrency scenario (see LANDMINES).

**Account rotation:** multiple subscriptions per provider, selected per dispatch via env override.
Codex = `CODEX_HOME` (verified live with two distinct ChatGPT accounts). Claude = `CLAUDE_CONFIG_DIR`
per account (macOS Keychain-isolation UNVERIFIED — needs a 5-min test when no session is live).
Cursor = `CURSOR_API_KEY` only (no config-dir mechanism; billing-to-plan UNDOCUMENTED — do not mint
keys until verified on an invoice). Rate-limit detection is string-matching per CLI (no proactive
quota API on any of them; the one exception is the undocumented ChatGPT `wham/usage` endpoint that
`claudex-usage` already queries — reuse for route-away-before-exhaustion).

---

## 3. Current state — BUILT & VERIFIED

All live-tested this session unless noted. Commits on `main`.

- **Worker adapters** (`src/adapters/`): `codex`, `cursor`, `agy` — all verified end-to-end
  (dispatch + resume + policy guards + usage parsing). `claude` is a protocol doc, not a
  subprocess (workers are in-session subagents). Each verified invocation contract + gotcha is in
  `LANDMINES.md` (stdin-closed for codex; `--trust`+`--approve-mcps`+`--force` for cursor MCP;
  #573 hang-retry + per-conversation serialization for agy; etc).
- **Routing table** (`routing/routing.v0.yaml`): task-class → provider/model/effort/skills/mcp +
  fallback chains, plus a **direct** path (`--provider`/`--model`) for full dynamic override. Both
  paths policy-fenced. Task classes: orchestration, deep-implementation, implementation,
  second-opinion(-hard), bulk-mechanical, scaffold, research-summarize, documentation,
  quick-alt-take, gemini-analysis.
- **Dispatcher + CLI** (`src/dispatch.ts`, `src/cli.ts`): `heddle dispatch|classes|packs|workers|
  ledger|usage`, all `--json`. Fallback chains verified (bad primary → fallback ran, both recorded).
- **SQLite ledger** (`src/ledger.ts`, `node:sqlite`, `~/.heddle/ledger.db`): records decision +
  outcome (provider/model/skills/issue/tokens/duration/success/fell_back_from) per dispatch.
- **Skill packs** (`skills/`): spinventory-core, quality-gate, worktree-discipline, supabase-dev,
  code-discovery. Materialized per-dispatch into the worker's `AGENTS.md`, restored after (never
  leaves a worktree mutated).
- **Worker MCP attachment** (`src/mcp.ts`): memtrace verified working for BOTH codex and cursor
  workers (returned correct symbol paths live); serena verified callable for codex. Codex fix was
  per-server `default_tools_approval_mode="approve"`; cursor needs `--approve-mcps --force`.
  memtrace + serena also pre-approved globally in `~/.codex/config.toml` (helps all codex sessions).
- **Effort control**: `--effort` mapped per provider; verified codex rejects invalid / accepts valid.
- **Subscription-billing guard** (`src/env.ts`): verified strips API keys, refuses them as overrides.
- **Account rotation**: verified two distinct Codex accounts via `CODEX_HOME`.

---

## 4. Architecture — the layers

```
L0  Foundation (exists, unchanged): Linear + lin.sh claims · pr-own/pr-sweep · fleet-identity
    hooks · worktree discipline · memtrace fleet layer
L1  Worker layer (BUILT): per-CLI adapters · routing table · skill packs · MCP attachment ·
    effort · billing guard · account rotation · worker isolation (worktree — TBD, §5)
L2  Orchestration (partial): heddle MCP server + /orchestrate (next) · roles layer (next) ·
    delegation discipline · dispatch modes incl. race-and-merge
L3  Intelligence & coordination (planned): tiny-model layer (auditor + auto-effort + chores) ·
    comms broker (chatroom + identities + needs-human queue) · enforcement hooks ·
    terminal-activity tracker
L4  Surface (planned): Electron dashboard (own-PTY) · Linear/GitHub panes · usage meters ·
    stats screen · (later) remote/mobile
```

---

## 5. Worker execution & isolation

Adapters implement one contract (`src/types.ts`: `WorkerAdapter.dispatch → WorkerResult`). Each
owns launch-command construction, structured-output parsing, resume handle, and MCP/approval
plumbing. **All verified contracts live in `LANDMINES.md` — read it before touching an adapter.**

**Worker isolation (OPEN DECISION, surfaced by Conductor/Superset):** heddle has no worktree story
for workers yet. Options: (a) workers share the orchestrator's issue-worktree — MVP-simple, fine
for sequential/non-overlapping sub-tasks; (b) one git worktree per PARALLEL worker — required for
race-and-merge and any concurrent same-repo edits, with reference-counted cleanup. **Plan:** ship
(a) for the headless-orchestration MVP; add (b) with a declarative per-repo lifecycle
(`onWorktreeCreate/Destroy`, gitignored-file copy-in à la Conductor's `.worktreeinclude`,
per-worker port range to avoid dev-server collisions) when race-mode / parallel workers land.
Steal Conductor's "spotlight testing" (one-way sync of one worktree's changes back to root) for
Docker/fixed-port stacks that can't be duplicated N ways. Spinventory already has
`worktree-discipline.md` for the human fleet — productize the same rules for workers.

---

## 6. Routing & dispatch modes

- **Task-class path** (default): orchestrator picks a class; the table maps to model/effort/skills/
  mcp/fallback — this is where policy lives, tunable in one YAML without a rebuild.
- **Direct path**: orchestrator names provider+model itself — full dynamic choice, still guarded.
- **Race-and-merge ("fusion") mode** (CONFIRMED wanted, for hard / highest-quality tasks): fan ONE
  task out to a DIVERSE cross-provider set (e.g. Opus + gpt-5.6-sol + gemini-3.1-pro + kimi-k3 +
  grok — diversity of *approach*, not variants of one family), each in its own worktree (§5b), then
  an orchestrator-led **synthesis/judge** step grafts the best parts / picks the winner. N× cost →
  reserved for hard/high-value only. Fits existing primitives: parallel dispatch + isolation +
  Fable synthesis (Fable's strength).

Model-catalog reality: never hardcode; re-verify against each CLI's live catalog. Diff heddle's
model/effort/flag choices against Superset's maintained headless-flag crib-sheet
(`packages/shared/src/builtin-terminal-agents.ts`) as a free correctness check.

---

## 7. Orchestration & delegation discipline

Orchestrators are the operator's interactive Claude Code tabs (fable by default; `--model opus` or
the `claudex` GPT-5.6 launcher when limits hit). They claim SPI issues exactly as today (L0), then
**delegate most execution** — Fable writes specs/step-by-step instructions and dispatches the
coding/labor to cheaper best-fit workers, doing high-level judgment + integration itself and
stepping in only where context/judgment demand. This is the intended model, not an aspiration.

**Delegation discipline (so orchestrators don't absorb the work):**
- A **PreToolUse hook** on orchestrators that nudges when they start heavy direct execution (a burst
  of Edit/Write, a large multi-file change): "this looks like execution — delegate via heddle unless
  it needs your context." A nudge, not a hard block.
- A **delegation-ratio metric** in the ledger + dashboard (% delegated vs done directly, per
  orchestrator) — visible and correctable.
- Encoded as an explicit principle in the orchestration skill: delegate when a different model is
  better-suited or parallelism helps; otherwise do it yourself. Trivial work stays in-session.

Agents ARE allowed to do work themselves — delegation is a tool, not a mandate.

---

## 8. Tiny-model layer (background intelligence)

A small local model (transformers.js / ONNX in-process, à la omp's `providers.tinyModel`; q4, CPU
default; models like lfm2-350m / qwen3-0.6b / gemma-3-1b) running as a heddle side-service —
harness-independent, needs no CLI-loop control. Jobs:

- **Session-goals auditor loop** (STANDOUT steal from OpenChamber): audit each worker turn against
  the objective → `keep-going | done | stuck`; mark a worker **blocked (→ needs-human) only after
  3 consecutive "stuck"**; hard-stop via token-budget + continuation caps; the human's stop always
  wins. This single mechanism fuses our planned progress-monitor + needs-human trigger + auto-stop.
- **Auto-effort classification**: classify an incoming sub-task's difficulty → pick the effort flag
  per dispatch (coarser than omp's per-turn, but external and free).
- **Background chores**: dispatch titling, memory extraction/consolidation, summarization,
  tool-output truncation-on-relay.

Deliberately NOT rebuilt: omp's mnemopi memory (Memtrace subsumes it + adds the code graph);
omp's LSP (Serena covers it). DAP live-debugging IS a real gap → add as a standalone MCP (Phase 2+;
check for an existing debugpy/js-debug/lldb MCP first — never-reinvent).

---

## 9. Comms broker, chatroom & identities

The flagship build; nothing adoptable exists (every tool surveyed confines comms to one process
tree). Design: **SQLite append-only message log + WebSocket push + an MCP server** exposing
`send_message` / `await_reply` (long-poll) / `check_inbox` — identical tools for every provider, so
any MCP-capable CLI gets real mid-task back-and-forth. Claude orchestrators subscribe via a
persistent Monitor (near-instant delivery); exited workers get queued + re-invoked with their resume
handle. The operator is a first-class address.

- **Chatroom = PULL model** (Maya's decision): agents check the room when they want; `@all`/`@agent`
  is the guaranteed-delivery exception (fires a notification). Culture is deliberately conservative
  (opinions / answers / multi-agent announcements / open questions only). Subagents may post
  sparingly and have first-class DMs (subagent↔subagent, ↔host, ↔operator). Chat stays OFF the
  individual work terminals. Schema validated against Paseo's `ChatMessage{authorAgentId, body,
  mentionAgentIds, replyToMessageId}` — re-derive independently.
- **Subagent identities** (genuinely new ground — no surveyed tool gives subagents first-class
  identity): each subagent is an addressable identity on the broker (e.g. `K.1`, `K.2`) so it can
  converse with peers, its host, the operator, and the room. The broker mints/tracks these; cascade
  their archive with the parent (Paseo's "fleets don't outlive their orchestrator").
- **Ownership glue:** Linear stays canonical; a sub-task ledger links each dispatch → SPI issue →
  PR so nothing orphans.

---

## 10. Needs-human queue

`needs-human` / `permission-request` are message types → the operator's dashboard queue. Design
lessons taken directly from Happy Coder's live production postmortem:

- **FAIL-OPEN:** a redundant ping is a dismissable buzz; a missed one leaves an agent blocked with
  nobody watching. Every uncertain case surfaces.
- **Never treat a worker's own connection as proof the human is present** (the exact 2-month silent
  bug Happy hit). Suppress only on positive proof of an active operator surface.
- **Log a TYPED outcome** (sent/suppressed/no_tokens/partial/failed), never a boolean — the boolean
  is why Happy's outage stayed invisible.
- **Scope per-provider:** "needs approval" is only as real as the CLI's own pause capability —
  `agy --print` is one-shot with NO in-flight approval surface, so its needs-human is idle/goal-based
  only, not permission-based. Don't promise a uniform experience across black-box CLIs.

Triggers: goal-auditor "stuck×3" (§8), idle>Ns (harness-independent timer), explicit permission
prompts (harness-dependent), plus a manual escape-hatch verb any process can call.

---

## 11. Hooks — enforcement & safeguards

Hooks are both safeguards and behavior enforcement, for orchestrators AND workers (Maya's
directive). Worker-scoped hook configs are materialized per-dispatch (never edit the operator's
global CLI configs). All four agentic CLIs ship JSON-on-stdin hook systems (Claude 25 events,
Cursor ~18, Codex ~11, agy 9).

- **Safeguard set** (every worker): no-delete-without-permission, no-secrets, memtrace-first for
  discovery, stay-in-lane (no unrelated edits).
- **Enforcement**: delegation-discipline nudge (§7); the goal-auditor stop (§8).
- **Capability model** (steal from happy2 + OpenChamber's control-tool allowlist): "the grant IS the
  tool surface" — a worker can't discover capabilities by trying and failing; it simply has none
  beyond what was granted. Fleet-management tools (heddle MCP) sit behind a hard allowlist (can
  spawn/list, cannot delete sessions/worktrees or run arbitrary shell). Secrets attached-not-pasted
  (never in prompt text).
- **omp's hook return-contract shape** is the clean API to mirror: `{block, reason}` to refuse a
  call (reason surfaces to the model), `{content, isError}` to mutate a result, chainable handlers.

---

## 12. Terminal-activity tracker (running / idle / needs-input)

How the dashboard knows a worker is working, idle, or waiting — and the source of the needs-human
signal. Design = Superset's **two-tier** model (read their `session-protocol/state.ts` +
`host-service/terminal-agents/store.ts` first, clean-room):

- **Rich tier** where a CLI exposes structured status: Cursor via ACP (`agent acp` — verified the
  only native-ACP CLI in our stack), Codex via its JSON event stream / `app-server`, agy via
  stream-json, Claude via hooks/harness. Unify each behind one common status interface.
- **Shallow tier** elsewhere: last-event-type + staleness from the CLI's hooks.
- **Optimistic-clear + self-correct:** an interrupt fires no Stop hook, so a worker can look wedged
  forever — mark it idle optimistically; a live worker re-asserts within seconds via its next event.
  Persist bindings + liveness-join against real session state so dead bindings are unrepresentable.

ACP note: only Cursor speaks it natively here (verified); `@agentclientprotocol/sdk` v1.3.0 is on
npm. ACP is one input pipe, not the universal channel — the rich-status *feature* comes from each
CLI's best available structured channel.

---

## 13. Dashboard (Electron, own-PTY)

Localhost Electron app (Electron is required for the real-Linear/GitHub popups — browsers block
framing those; and for embedded terminals). **tmux is SCRAPPED** — the dashboard owns the terminal
directly (Paseo/Superset own-PTY model), since the operator works inside heddle and doesn't need the
session mirrored in a separate terminal app.

- **Own-PTY layer:** a standalone PTY-owning daemon (study Superset's `packages/pty-daemon`:
  Unix-socket, fd-handoff so terminals survive a dashboard restart, in-memory ring buffer,
  multi-subscriber fan-out; pin node-pty ≥1.2.0-beta.14 — 1.1.0 leaks fds on macOS; run the daemon
  under Node, node-pty breaks under Bun). Keep the PTY layer dumb; logic lives above.
- **Layout** (from `DASHBOARD.md`, minus tmux): left orchestrator roster (expand → issues/PRs/
  subagents; double-click → terminal); center app-tabs = one terminal per orchestrator with inner
  subagent tabs + a chatroom tab; right Linear/GitHub panes (movable popups to the REAL apps via
  BrowserView, always in sync); bottom per-provider usage meters.
- **Protocol** (study Paseo): one WebSocket, JSON control frames + a binary sub-protocol for
  terminal I/O; capability-flag versioning so daemon/clients ship out of lockstep.
- **Statusline:** the operator's claude-hud experience, extended with per-subagent usage + current
  task (a heddle segment).
- **Steal:** Conductor's unified pre-merge "Checks" pane (git+CI+deploy+review-threads+todos —
  mechanizes what pr-sweep.sh does); diff-viewer inline-comment → re-dispatch loop; OpenChamber's
  Preview element-inspector (feed a selected UI element back into a worker's context).

---

## 14. Usage meters & stats

- **Provider meters** (bottom bar): Claude + Codex get REAL percentage bars (Codex via the
  `wham/usage` endpoint claudex-usage already queries, both accounts); Gemini + Cursor are heddle's
  own bookkeeping (no vendor API — verified). Steal OpenChamber's **quota-WINDOW + PACE indicator**
  ("on track to run out") — window-awareness (not just $) that drives route-away + rotation. Show
  Cursor's two pools separately (Cursor-Models generous vs Other-Models metered = the PR-review pool).
- **Stats screen** (own section): tokens per orchestrator/subagent/task-class/provider/model; routing
  & **savings** (% routed off the Claude pool, model win-rates, cost-per-issue trend, delegation
  ratio); subagent success/failure/timeouts; memtrace/serena tool telemetry; code-quality (gate
  pass/fail, review round-trips, regression tests added). Expose the ledger as a queryable surface
  (`heddle query "SELECT…"`, mirroring Superset/Conductor). **The ledger must record real OUTCOME,
  not just "dispatched"** (both Superset and Happy shipped dispatch-only tracking and regretted it).

---

## 15. Ecosystem — what we steal (and what we already lead)

| Source | License | Steal | heddle already leads on |
|---|---|---|---|
| **omp** | MIT | tiny background model; auto-effort; MCP tool-gating; hook return-contract shape | — (omp rejected as runtime: OAuth ToS) |
| **Paseo** | AGPL (study-only) | daemon/WS+binary protocol; agent-lifecycle FSM + ack-gated cancel + cascade-archive; chatroom schema; terminal-activity pattern; dir-backed-vs-workspace-owned state keying | Linear loop, routing table, SQLite ledger, account rotation, usage meters (all absent in Paseo) |
| **Conductor** | closed | worktree-per-worker lifecycle + `.worktreeinclude`; spotlight-testing sync-to-root; unified Checks pane; diff→re-dispatch loop; ledger-as-query | chatroom, identities, rotation, roles, enforcement hooks, auto-routing, Gemini breadth |
| **OpenChamber** | MIT | ⭐ session-goals auditor (keep-going/done/stuck, block×3); quota-window+pace meters; capability-scoped control-tool allowlist; editable templated prompts; race-and-merge/fusion | chatroom, identities, auto-routing, effort, rotation, Linear-first |
| **Superset** | ELv2 (study) | ⭐ two-tier status model + optimistic-clear; pty-daemon design; headless-flag crib-sheet; MCP tool taxonomy | comms, identities, cost dashboard, auto-routing |
| **Happy Coder** | MIT | ⭐ needs-human fail-open + presence-detection postmortem; per-provider approval boundary; permissionMode pre-auth; happy-wire-vs-Rig session-render poles; Murmur (relay, if off-LAN); grant-is-tool-surface | usage meters, first-class subagent identities, auto-routing |

**Genuine white space nobody has (heddle's differentiated value):** cross-session/cross-provider
inter-agent comms + chatroom, first-class subagent identities, deterministic auto-routing, automatic
multi-account rotation, provider usage meters + savings analytics, and the Linear-claim→work→resolve
agentic loop.

**ACP** appears in Paseo + Superset + Happy — a real open standard (`@agentclientprotocol/sdk`
v1.3.0). In our stack only Cursor speaks it natively (verified); use it as Cursor's rich channel,
not as a universal layer.

---

## 16. Build phases

**Phase 1 — orchestration core (headless-runnable) — IN PROGRESS.** Goal: lettered Claude agents
A–Q orchestrate real Spinventory work autonomously while the platform gets built alongside.
- DONE: adapters, routing, ledger, skill packs, MCP attachment, effort, billing guard, rotation.
- NEXT: heddle MCP server + `/orchestrate` command + rules stub (so orchestrators dispatch as a
  tool, not a shell-out) · roles layer · tiny-model layer (auditor + auto-effort + chores) ·
  delegation-discipline hook · pilot on one real SPI issue, measure vs an all-Claude baseline, tune
  routing from ledger data · roll out to the fleet.

**Phase 2 — comms & coordination.** Broker + chatroom (works in plain iTerm before any GUI) ·
subagent identities · needs-human queue (fail-open) · terminal-activity tracker (two-tier) ·
worker-scoped enforcement hooks · worktree-per-parallel-worker + race-and-merge mode.

**Phase 3 — dashboard.** Own-PTY daemon · Electron shell (roster + embedded terminals + chat tab +
meters) · statusline deep integration.

**Phase 4 — Linear/GitHub panes** (real-app popups + cross-links + Checks pane) · **stats screen** ·
savings analytics.

**Phase 5+** — DAP-as-MCP · optional off-LAN remote (Murmur) · optional mobile.

---

## 17. Open decisions (need Maya)

1. Worker isolation for the MVP: confirm (a) share orchestrator worktree now, (b) worktree-per-
   parallel-worker with race-mode. (§5)
2. Claude multi-account Keychain-isolation test (5 min, when no session is live). (§2)
3. Cursor second account: only via `CURSOR_API_KEY` with undocumented billing — verify on an
   invoice before minting, or stay single-account (Grok/Composer are in the generous pool anyway).
4. Roles layer shape: confirm named roles = role-prompt + default model + default skills, fully
   per-dispatch overridable.

---

## 18. Where everything lives (index)

- **Verified per-CLI contracts & gotchas:** `docs/LANDMINES.md` (READ before touching an adapter).
- **Layer detail:** `docs/ARCHITECTURE.md`. **Phase-1 mechanics:** `docs/ORCHESTRATION.md`.
  **Dashboard UI vision:** `docs/DASHBOARD.md` (tmux parts superseded by §13 here).
- **Routing policy:** `routing/routing.v0.yaml`. **Skill packs:** `skills/`.
- **Code:** `src/{adapters,dispatch,routing,ledger,skillpacks,mcp,env,cli,types}.ts`.
- **Research detail & decision log (session-durable):** memory `project-agent-orchestration-lane`.
- **Spinventory integration:** the L0 systems — `.claude/bin/lin.sh`, `pr-own.sh`, `pr-sweep.sh`,
  `agent-identity.py`, `worktree-discipline.md`; vault doc
  `_vault/architecture/agent-orchestration-plan.md`.
- **Reference architectures to study (clean-room, don't import):** Paseo docs/ (AGPL), Superset
  source (ELv2) — specific files named in §12/§13.
