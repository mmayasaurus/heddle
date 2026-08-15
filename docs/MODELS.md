# MODELS.md — which model for which job

> Drafted 2026-08-14 by a heddle-dispatched worker (cursor/grok-4.6-high, ledger #30) from
> `routing/routing.v0.yaml` + `skills/` + `docs/SPEC.md` + `docs/LANDMINES.md`; Maya-approved 2026-08-15.

Orchestrators: pick a **task class**, not a favorite model. The routing table
(`routing/routing.v0.yaml`) is the live map; this doc is the **why**. Every
dispatch is ledgered — tune classes from outcomes, not hunches.

Subscriptions only. Never per-token API keys. Never route Claude/GPT/Gemini
through Cursor (`never_via_cursor`). Ollama Cloud is reserved for PR-review
bots — do not dispatch workers there.

## Task class → model

| Class | Primary | Fallback | Use when / why |
|---|---|---|---|
| `orchestration` | claude **fable** | — | Decompose, integrate, judge, land. In-session; shares the orchestrator prompt cache. Do not dispatch this class to a subprocess. |
| `deep-implementation` | claude **opus** + memtrace | codex **gpt-5.6-sol** | Gnarly features, cross-cutting refactors, subtle bugs. Opus: strongest coding judgment + native skills/MCP. Sol: independent family if Opus is spent or you want a second coding lineage. |
| `implementation` | claude **sonnet** + memtrace | codex **gpt-5.6-terra** | Well-scoped feature with a clear spec. Sonnet is the default coding workhorse; Terra is the Codex equivalent. Do not spend Opus here. |
| `scaffold` | cursor **composer-2.5** | codex **gpt-5.6-luna** | Fast structural drafts (files, stubs, wiring). Composer is Cursor-native, cache-warm, ~1.8s on a trivial prompt — coding-tuned, not a reasoner. |
| `bulk-mechanical` | codex **gpt-5.6-luna** `effort=low` | cursor **composer-2.5-fast** | Renames, sweeps, codemods, boilerplate, test scaffolds. Luna+low is cheap volume. Fallback `-fast` bills ~2× on Cursor — prefer Luna. |
| `second-opinion` | cursor **grok-4.6-high** | gemini **3.1-pro-high** | Independent diagnosis/review of a diff or plan. Diversity of *family* is the point. Grok sits on the Cursor-Models pool (does not starve PR review). |
| `second-opinion-hard` | cursor **kimi-k3-high** | — | **Opt-in only.** ~74s even on a trivial prompt. Burns the metered "Other Models" pool that Cursor PR review draws on. Ask Maya first. |
| `quick-alt-take` | cursor **grok-4.6-medium** | — | Cheap second draft to compare against a primary. Same family as second-opinion, lower effort. |
| `research-summarize` | claude **haiku** | luna | Doc reading, log triage, summarization. Haiku is the cheap Claude; do not use Sonnet/Opus to read logs. |
| `documentation` | gemini **3.6-flash-low** | luna | READMEs, comments, changelogs, docstrings. Flash: cheap, fast (~3s), fine for prose over known facts. Not for designing architecture. (3.7-flash verified 8-14 — in catalog; class default pending a quota check.) |
| `gemini-analysis` | gemini **3.1-pro-high** | composer-2.5 | Long-context reading, doc/log analysis, cross-checking, and **web-grounded research** (agy has Google Search). Gemini is still **piloting** (adapter timeouts + model-echo checks). |

Race-and-merge (hard/high-value only): fan one task across **diverse families**
(e.g. Opus + sol + gemini-pro + grok), then Fable synthesizes. N× cost.

## Family strengths / weaknesses

**Claude (Anthropic sub, in-session subagents).** Best judgment, native
`skills`/`mcpServers`/`permissionMode`, thinking visible, shared cache with
the orchestrator. Weakness: burning Opus/Sonnet on mechanical or prose work
wastes the flat pool; workers are subagents, not `claude -p`.

**Codex (ChatGPT sub, `codex exec`).** Effort knob (`minimal`…`xhigh`); Luna
wins on volume; Sol/Terra are capable coding fallbacks. Lean by default
(`--ignore-user-config`) — a loaded `~/.codex` costs ~22k input tokens before
the task starts. Weakness: reasoning is counted, not streamed.

**Cursor (Max plan, supplemental models only).** Two pools, **not
interchangeable** — see Cost. Composer = fast scaffold; Grok 4.6 = default
second opinion (prefer over 4.5). Weakness: catalog churns; `-fast` costs
more; Kimi is slow and metered. Cursor adapter **refuses** Claude/GPT/Gemini ids.

**Gemini (agy, Google sub, piloting).** Flash for cheap prose; Pro for long
context + web-grounded research. Weakness: no thinking text; ~18k auto-load
overhead from global skills; adapter is defensive (timeout, status check,
model-echo). Do not treat as trusted until piloting lifts.

## Skill packs × worker type

Packs are lean-by-default. Attach only what the task needs — each class's
default list lives in the routing YAML (`skills:`; see "Dispatch-time
surfacing" below for the omit/replace/union rules). `worker-role` is the
exception: **every** delegated worker gets it (blocks Linear/PR ownership and
scope creep) — the dispatcher unions it in unconditionally.

| Pack | Pair with | Why |
|---|---|---|
| `worker-role` | all classes | Worker is not a lettered agent. No `lin.sh`, no PR-own, no drive-by fixes. |
| `code-discovery` | `implementation`, `deep-implementation` (any worker with memtrace attached) | Graph/symbol first; a zero-hit is not "code absent". Blind grep is the failure mode these classes exist to avoid. |
| `quality-gate` | any class that **edits code** | Forces `npm run gate` / honest verification. Skip on research/docs/second-opinion. |
| `spinventory-core` | Spinventory UI/product edits | Non-negotiable product rules (scroll, tokens, FormSheet, no copy changes). Irrelevant to heddle-internal or pure-docs tasks. |
| `worktree-discipline` | shared-worktree workers; **required** for race-and-merge | Lane discipline + "report don't fix". Keeps parallel workers from colliding. |
| `supabase-dev` | DB / migration / edge-function tasks only | Prod is forbidden; schema is frozen without Maya. Do not attach "just in case". |

Claude workers get packs via agent-definition frontmatter; Codex/agy/Cursor
get a temporary `AGENTS.md` block (restored after dispatch).

## Cost / quota

1. **Subscriptions first, always.** No API keys, no base-URL overrides, no
   on-demand Cursor overage. `subscriptions_only: true` is a hard rule.
   (OpenRouter-for-workers considered and REJECTED, Maya 2026-08-15.)
2. **Cursor has two pools.** "Cursor Models" (Grok + Composer) = generous
   plan allowance — **prefer these**. "Other Models" (Kimi / GPT / Claude /
   Gemini in Cursor's catalog) = metered dollars **shared with Maya's Cursor
   PR-review usage**. Spending it here starves review. `kimi-k3-high` is
   `requires_explicit_opt_in`.
3. **Route away at 90%** of the Cursor Other-Models pool (`metered_pool_guard`).
   Never click through to overage.
4. **Direct sub beats Cursor middleman.** Claude/GPT/Gemini have their own
   CLIs; routing them via Cursor is both policy-illegal and the wrong pool.
5. **Match spend to difficulty.** Haiku/Luna/Flash/Composer for cheap work;
   Sonnet/Terra for scoped features; Opus/Sol for hard; Kimi only when asked.
   Latency snapshots: Composer ~1.8s · Grok-4.5-low ~2.8s · Flash-low ~3s ·
   3.7-flash-low ~5.6s · Kimi-high ~74s.

## Adding a new model

1. Confirm it in the **vendor CLI catalog** (`cursor-agent models`, `agy
   models`, Codex list) — but know catalogs LAG: Gemini 3.7 Flash worked via
   `-m` a day before `agy models` listed it. Never hardcode from memory.
2. **Live round-trip** a trivial prompt through the adapter (headless, same
   flags heddle uses). Record e2e latency, usage fields, resume handle, and
   whether the model id is echoed.
3. Check **pool / policy**: Cursor Models vs Other Models; not in
   `never_via_cursor`; not Ollama Cloud; official binary only.
4. Add the id under `providers.<name>.models` in `routing.v0.yaml`, then a
   task class or fallback. Note effort encoding (Codex `-c
   model_reasoning_effort`, Cursor baked into the id, agy `--effort`).
5. Log the latency snapshot in the YAML comment (existing ✅ style) and any
   LANDMINES gotcha.

Authoritative contracts: `docs/LANDMINES.md`. Authoritative map: the YAML.

## Dispatch-time surfacing (BUILT — HED-1, 2026-08-15)

The tiny SessionStart primer stays tiny; the guidance lives at the moment of
choosing a worker instead:

- **`list_task_classes` / `heddle classes`** return, per class: `why` (one
  line), `skills` (the packs a dispatch gets when you omit `skills`), `mcp`,
  `effort`, `execution` (`in-session-subagent` = use your own Agent tool),
  `edits_code`, fallback and opt-in. Source: `why:` / `skills:` / `edits_code:`
  fields on each class in `routing/routing.v0.yaml`; this doc stays the
  narrative.
- **Skill-pack semantics (decided 2026-08-15, Maya via Agent R):** the YAML
  `skills:` list **is the dispatch default** — omit `skills` and you get it. A
  caller's explicit list **replaces** that default. `worker-role` is
  **mandatory** and is unioned into every dispatch by the dispatcher
  (`withMandatoryPacks`, both the task-class and the direct provider/model
  path) — an explicit list adds to policy, it never removes worker-role. The
  ledger's `skills` column records what was actually materialized, so it is
  auditable.
- **Dispatch-guidance hook** (`dist/hook-dispatch-guidance.js`, a Claude Code
  PreToolUse hook on `mcp__heddle__dispatch_worker`): warns — never blocks —
  when (1) a code-editing class (`edits_code: true`) is dispatched with no
  task-fit packs beyond the mandatory `worker-role` (explicit `skills: []`, or
  the class lists no defaults), naming the recommended packs; (2) a
  `requires_explicit_opt_in` class (today `second-opinion-hard`) is called
  without `opt_in: true` — the dispatcher will refuse it; the hook explains the
  cost first. Output goes to the orchestrator's context
  (`additionalContext`) plus a one-line `systemMessage`; it sets no
  `permissionDecision`, so the normal permission flow is untouched. Fails open
  (any error → exit 0, no output). Register in `~/.claude/settings.json`
  (user scope — orchestrators run in many repos):

  ```json
  "PreToolUse": [{ "matcher": "mcp__heddle__dispatch_worker", "hooks": [{
    "type": "command", "timeout": 10,
    "command": "node --no-warnings=ExperimentalWarning /Users/<you>/Developer/heddle/dist/hook-dispatch-guidance.js" }] }]
  ```
  Same node + `dist/` path pattern as the heddle MCP entry in `~/.claude.json`;
  honors `HEDDLE_ROUTING` like the server. Not registered by heddle itself —
  the operator (or a future plugin install) wires it.
