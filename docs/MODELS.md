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
| `adversarial-review` | cursor **grok-4.6-high** (or the first `reviewer_pool` entry that is not the author's provider) | gemini **3.1-pro-high** | Pre-PR review by a DIFFERENT model family, read-only + find-only, test-quality lens; `author_provider` required; the ledger scores each author→reviewer pair (HED-3, section below). |
| `gemini-analysis` | gemini **3.1-pro-high** | composer-2.5 | Long-context reading, doc/log analysis, cross-checking, and **web-grounded research** (agy has Google Search). Gemini is still **piloting** (adapter timeouts + model-echo checks). |

Race-and-merge (hard/high-value only): fan one task across **diverse families**
(e.g. Opus + sol + gemini-pro + grok), then Fable synthesizes. N× cost.

## Family strengths / weaknesses

**Claude (Anthropic sub, headless `claude -p` workers by default — HED-78;
in-session subagents on `in_session: true`).** Best judgment; headless workers
rotate onto the registry account with the most 5h headroom; the in-session
protocol keeps native `skills`/`mcpServers`/`permissionMode`, visible thinking
and the orchestrator's shared cache. Weakness: burning Opus/Sonnet on
mechanical or prose work wastes the flat pool.

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

## Adversarial review (BUILT — HED-3, 2026-08-15; Maya: "super important")

Pre-PR, before the human looks: a **different model family** is dropped into the
author's worktree **read-only** with a **find-only** mandate; the author fixes;
the ledger scores each author→reviewer pair by accepted-finding rate.

- **Class** `adversarial-review` (routing YAML): primary `cursor/cursor-grok-4.6-high`,
  fallback `gemini/gemini-3.1-pro-high`, `reviewer_pool` `[cursor/grok, gemini/pro,
  codex/sol, claude/opus]`, packs `[worker-role, adversarial-review]`, `read_only:
  true`, `auto_assess: true`. Call it with `author_provider` (**required** — the
  provider that wrote the change; an orchestrator reviewing its own edits passes
  `claude`), optional `author_model` / `author_dispatch_id` (lineage) and
  `diff_base` (a git ref — heddle prepends "review `git diff <ref>...HEAD`").
- **Different family, enforced on the effective route:** if the class primary is
  the author's provider, the first differing `reviewer_pool` entry is used
  (`route_reason: … reviewer pool:2 (author is cursor)`); a fallback in the
  author's family is dropped; naming the author's own provider explicitly, or a
  cap-aware route-away landing there, is refused (`same-provider-review`,
  ledgered). Provider names are normalized (`Cursor ` = cursor).
- **Read-only, enforced where the CLI has a knob and PROVEN everywhere:** codex
  `--sandbox read-only`; claude `--tools Read Grep Glob` (verified live: Write
  reported disabled, no file created) — and every claude worker now runs
  `--strict-mcp-config` with a per-dispatch (possibly empty) MCP file, because a
  live check showed the operator's global MCP servers (Serena can edit code;
  Linear/Supabase act on live systems) leaking into a "read-only" reviewer;
  cursor/agy have no knob. Structurally, heddle hashes the worktree **contents**
  before and after (HEAD + every tracked/untracked non-ignored file + the stash
  list): a changed digest — or an after-snapshot that fails in a repo that worked
  before — is a **MANDATE VIOLATION**: `ok=false`, `review.mandateOk=false`,
  `mandate_ok=0` on the review row, findings still returned, nothing reverted.
  Ignored paths (`.gitignore`) are outside the boundary by design.
- **The mandate pack** (`skills/adversarial-review.md`): find only, never fix;
  adversarial not agreeable; five lenses — correctness, security, **test quality
  (Maya's bar: a test that proves a switch toggles is not a test that proves the
  switch DOES the thing — name every test that would still pass if the feature
  were silently broken)**, docs/messages, unverifiable PR claims; a fixed report
  format ending in `VERDICT: N findings`.
- **Ledger:** `reviews` table (dispatch_id → author_provider/model/dispatch,
  reviewer_provider/model, mandate_ok, findings_total/accepted, notes); the
  reviewer's output also runs through `assess_result` (`assessment` on the
  outcome). **Follow-up:** after triage the author records
  `record_review_outcome(dispatch_id, findings_total, findings_accepted, notes)`
  (MCP) / `heddle review-outcome <id> --total N --accepted M`; `review_stats` /
  `heddle reviews` show per-pair reviews, scored, findings, accepted,
  acceptance rate, mandate violations — the scoreboard that picks the reviewer
  family for a given author family.
- **First live review (2026-08-15, ledger #67):** this very diff, author claude →
  reviewer cursor/grok-4.6-high, 429 s, mandate held, `assessment:
  needs-rework`, 6 findings (3 high, 3 med) + the test-quality lens — all six
  accepted (6/6 recorded via `heddle review-outcome`), each changed code or docs
  before this PR opened. The `claude→cursor` pair now scores 1.0.

## Cap-aware routing (BUILT — HED-67, 2026-08-15)

Ground truth that forced it: six Fable orchestrators burned a full Claude 5h
window in ~50 min while codex sat at 8%/2% weekly and gemini at 6%. The router
now consults live caps at every dispatch (`src/usage.ts` → `src/capaware.ts`)
and records why it chose what it chose (`route_reason` in the ledger).

- **Sources** (never a vendor call from heddle-core): `~/.heddle/usage/limits.json`
  — the dashboard's mirror of its `heddle_provider_limits` result
  (`{writtenAt, limits: ProviderLimit[]}`, contract in heddle-dashboard
  `docs/USAGE_TAP.md`, pinned by its `limits.golden.json`; written every poll
  while the app runs) — then the raw Claude statusline tap
  `~/.heddle/usage/claude.json` + per-account `claude-<acctId>.json` (written on
  every statusline render, app or no app) as the Claude fallback. **Stale is
  unknown** (limits.json > 15 min old, tap > 10 min old, or a snapshot flagged
  `stale` upstream): unknown never routes away and never refuses. A window whose
  `resetsAt` has passed counts as 0 until the next capture.
- **route-away** (`policy.cap_aware_routing.route_away_at_pct`, default 90):
  if the primary provider's binding window (5h; 7d when there is no 5h; for
  cursor, the pool its model draws from) is at/over the threshold and the class
  declares a fallback whose own window is under it → the fallback runs, ledgered
  with `fell_back_from` + `route_reason: cap:route-away …`. Both over → the
  primary runs (soft cap, `cap:both-over`). No fallback → primary (`cap:over`).
  Applies to Claude-primary classes too: `implementation` at Claude 5h ≥ 90 %
  runs its declared `codex/gpt-5.6-terra` fallback as a subprocess instead of a
  headless claude worker (below the threshold you get the claude worker on the
  best account; with `in_session: true`, the structured refusal + advice).
- **Cursor pools** (Maya-corrected model, W's fields): `included-total` gates
  Cursor's own models (`cursor-grok-*`, `composer-*`, `auto`) — soft
  route-away; `included-api` gates NAMED third-party models (kimi-k3, …) — at
  ≥ 100 % (or noteCode `cursor.includedApiExhausted`) they would bill
  on-demand, so heddle **refuses** them (`metered-pool-exhausted`, ledgered);
  `cursor.onDemandLimitReached` → everything on that Cursor account is refused.
  The account heddle's dispatches bill is the `cursor-agent-keychain` row when
  the dashboard reports it (the IDE row is informational).
- **Explicit routes** (`provider`+`model` named by the caller) are never routed
  away — naming it is the choice — but the metered-pool refusals still apply.
- **Dry run:** `heddle route --class <c> [--provider p --model m] [--opt-in]` and
  the `plan_dispatch` MCP tool print the decision, the checks, the remaining
  fallback and the account advice — no ledger row, no worker.

## Claude workers & automatic account switching (BUILT — HED-78, 2026-08-15)

Maya: "Yes let's def build the auto account switching!" — so Claude classes now
run as **out-of-process `claude -p` workers** on the registry account with the
most 5h headroom (src/adapters/claude.ts + `pickClaudeAccount()` in
src/capaware.ts), which ends the manual log-out/log-in juggling:

- **Registry** `~/.heddle/accounts.json` (`claude[]: {id, configDir|null,
  email, note}`; `configDir: null` = the default login — heddle UNSETS
  `CLAUDE_CONFIG_DIR` for it: setting it explicitly to `~/.claude` changes
  resolution and `claude auth status` reports logged-out, verified by R).
  Per-account caps come from the tap's `~/.heddle/usage/claude-<acctId>.json`
  (or the dashboard's `limits.json` account rows), plus the window-keeper's
  anchor `claude-<acctId>.keeper.json` (`{account, startedAt, resets_at, used:
  null, source:"keeper-ping"}` — written when the keeper starts a 5h window with
  a headless ping the tap cannot see): while its `resets_at` is in the future it
  counts as a fresh capture at ~0 % (`noteCode claude.keeperAnchor`); the
  freshest of tap vs keeper wins. Without it, accounts that only ever get keeper
  pings would stay unknown and never be picked.
- **Selection**: the account with the lowest 5h used% among those with a
  FRESH capture; `account_pin` / `--account <id>` overrides; nothing fresh → the
  default login. The ledger `account` column records the account actually
  used and `route_reason` carries `account:<id> (5h x%, most headroom of N
  fresh)` / `pinned` / `default (no fresh per-account caps)`.
- **Contract** (`claude -p <prompt> --output-format json --model <m>
  [--effort e] [--resume id] --append-system-prompt <packs> [--mcp-config
  <tmp> --strict-mcp-config] --permission-mode acceptEdits --allowedTools …`;
  stdin closed; exit 0 + empty stdout = failure; never `--bare`): skill packs
  travel on the command line (nothing written into the worktree — no AGENTS.md
  race for Claude workers), MCP via a per-dispatch temp file. Posture =
  `acceptEdits` + an explicit tool allowlist (`DEFAULT_CLAUDE_ALLOWED_TOOLS`:
  read/edit the workspace, run the repo's own scripts, inspect git —
  LANDMINES: `--permission-mode auto` aborts headless); `browse` adds
  WebFetch/WebSearch, `exec-privileged` (two keys) → `--dangerously-skip-permissions`,
  `net` unenforceable → refused. Billing = the subscription OAuth of the
  config dir; `buildWorkerEnv` strips every API-key/base-URL var.
- **In-session stays available**: `dispatch_worker(in_session: true)` /
  `heddle dispatch --in-session` returns the structured `claude-in-session`
  instruction (run it as your own Agent-tool subagent: shared prompt cache,
  same account) plus the account advice line.
- **Route-away stays on**: at Claude 5h ≥ `route_away_at_pct` (90) a Claude
  class runs its declared fallback (codex/…) instead — Maya's default (lower
  the knob if Claude should hold).
- **Live-verified 2026-08-15**: two haiku workers, `heddle dispatch --class
  research-summarize` → ledger `account=acct1` (default, session persisted
  under `~/.claude/projects/…`) and `--account acct2` → `account=acct2`
  (session persisted under `~/.claude-acct2/projects/…`), both `OK`.
- Codex workers record `account` = `basename(CODEX_HOME)` when the caller
  selects one.

## Structural caps (BUILT — HED-2, 2026-08-15; Scape-derived, clean-room)

Enforced in `src/dispatch.ts`, not in prompts. Every refusal is a **finished
ledger row** (`refusal` column = the code below, `error` = the reason) and a
structured `{ok:false, refusal:{code, reason, instruction}}` result — never a
silent no-op, never left in flight.

| Cap | Rule | Refusal code |
|---|---|---|
| **depth-1** | A heddle **worker** cannot dispatch workers. Structurally: workers are never given the dispatch surface (the heddle MCP is not attachable to workers; only memtrace/serena are). Defense in depth: every worker subprocess is stamped `HEDDLE_WORKER=1`, `HEDDLE_DISPATCH_ID=<ledger id>`, `HEDDLE_PARENT=<orchestrator>` and the orchestrator's own `HEDDLE_AGENT`/`FLEET_AGENT` are stripped from its env; a heddle MCP server or CLI started inside that env refuses every dispatch (ledgered as `depth-1`, attributed to the parent with `identity_source=worker-parent`). Honest limit: env stamps stop accidental nesting and make attempts auditable; a worker that deliberately scrubs its env and locates the CLI is not stopped by them (the codex sandbox does not restrict process execution) — the machine is the trust boundary. In-session Claude subagents share the orchestrator's MCP process, shell and identity, so they cannot be told apart at all: the dispatch-guidance hook nudges (`subagent-dispatch`) when the MCP payload carries `agent_id`; the CLI path is open by SPEC design (Claude subagents ARE the orchestrator's own workers). | `depth-1` |
| **max-children** | One orchestrator may have at most `policy.structural_caps.max_children_per_orchestrator` (default **8**) workers in flight; the count and the new row are written in ONE `BEGIN IMMEDIATE` transaction, so concurrent dispatches — even from different heddle processes — can't both slip under the cap. The bucket key is the ledger `orchestrator` — the process-bound identity when bound, otherwise the caller-supplied `agent` string (an unbound orchestrator could name several strings and get several buckets; bind identity — `HEDDLE_AGENT` in the launcher — for a real cap). Rows older than `in_flight_stale_after_ms` (default 3 h) are orphans and don't hold a slot (a worker genuinely running past 3 h also stops counting — the default worker timeout is 10 min); close orphans with `heddle workers --stale <h>` + `heddle ledger finish <id> --error "…"` (atomic; only in-flight rows can be closed, a worker's own real outcome is never overwritten). | `max-children` |
| **capabilities** | Default-deny. `dispatch_worker.capabilities` / `--capabilities` grants from the allowlist `net`, `browse`, `exec-privileged`; grants are ledgered (`capabilities` column — a refusal row records what was asked) and passed **only** to a CLI that can enforce them. Unknown token, or a grant the provider can't enforce → refused, never pretended. `exec-privileged` needs **two keys**: the operator flips `policy.capabilities.allow_exec_privileged: true` in the routing YAML AND the call passes `opt_in: true` — a model-controlled tool argument alone can never widen the sandbox. | `capability-denied` |
| **identity** | Who a dispatch is attributed to is bound ONCE per process from ITS OWN cwd/env (`HEDDLE_AGENT` → `FLEET_AGENT` → `.fleet-agent` file → unbound) — never from the worker's target `--cwd`, never chosen by the model; the tool's `agent` arg is used only when unbound and the ledger records `identity_source` (`bound` / `caller` / `worker-parent`). Prefer the env binding: a `.fleet-agent` file is a convenience for pinned worktrees, and env beats file. `dispatches.id`/`orchestrator` are immutable (DB trigger). `heddle whoami` shows the binding. | — |

Capability enforcement matrix (verified against each CLI's own docs/help,
2026-08-15 — `docs/LANDMINES.md`):

| Provider | `net` | `browse` | `exec-privileged` |
|---|---|---|---|
| codex | `-c sandbox_workspace_write.network_access=true` (workspace-write keeps network **off** by default) | `-c web_search="live"` (default `cached` = OpenAI index, no external access) | `--sandbox danger-full-access` |
| cursor | — | — | — |
| gemini (agy) | — | — | — |
| claude | no knob (headless has no sandbox) → `net` is refused upstream | `--allowedTools` +WebFetch,WebSearch | `--dangerously-skip-permissions` |

Cursor/agy have no per-capability flags heddle can pass, so a grant there is
refused; note that their headless workers are also **not** network-fenced by
heddle today (documented gap — their `--sandbox` flags exist but their
network/fs semantics are unverified), and that attaching MCP to a cursor
worker adds `--approve-mcps --force` (auto-approve tool calls — approval
bypass, not a filesystem/network widening; same category as codex's
`approval_policy="never"`). Class + explicit route (`task_class` +
`provider`/`model`) is the way to move a capability-needing task onto codex
under the class's policy.

What is and isn't a ledgered refusal: the **structural/policy refusals** above
(`depth-1`, `max-children`, `capability-denied`, `claude-in-session`) are always
finished rows. **Caller/config errors** — unknown class, missing opt-in for a
gated class, provider without model, unknown skill pack or MCP server, unknown
provider — throw before any row exists (HED-19: fail fast, no orphan, no
mutated worktree).

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
  caller's explicit list **replaces** those task-fit defaults (it does not
  merge with them). Separately, `worker-role` is **mandatory**: the dispatcher
  unions it into whichever list applies (`withMandatoryPacks`, task-class and
  direct paths alike), so an explicit list can add packs but can never drop
  worker-role. A class's fallback route inherits the class `skills`/`mcp`
  unless the fallback node sets its own (effort is per-provider, not
  inherited). The ledger's `skills` column records what was actually
  materialized, so it is auditable.
- **Class + explicit route:** `dispatch_worker` accepts `task_class` **and**
  `provider`+`model` together — the class supplies the policy (default packs,
  MCP, opt-in gate, ledger `task_class`), the named provider/model replaces the
  route, no fallback (naming it is the choice). This is how the
  `adversarial-review` class (HED-3, below) runs on "any provider except the
  author's". `provider` and `model` must be given together (a lone half is
  rejected).
- **Claude-primary classes** (implementation, deep-implementation,
  research-summarize) run as **headless `claude -p` workers by default**
  (HED-78, `execution: headless`) on the best registry account. Passing
  `in_session: true` opts into the HED-18 protocol instead: a structured
  refusal `{ok:false, refusal:{code:"claude-in-session", reason, instruction},
  execution: in-session-subagent}`, ledgered (`refusal` column), whose
  `instruction` names the model, the class packs/MCP to give your own
  Agent-tool subagent, and the declared fallback you can name as
  `provider`+`model` to run it as a subprocess. No auto-fallback there.
  `orchestration` is `dispatchable: false` — it is the orchestrator's OWN work;
  a dispatch of it is refused on EVERY path (class, class + explicit route,
  whatever the named provider) with code `not-dispatchable`, "continue
  yourself", and no mandatory worker pack is added (a caller-supplied `skills`
  list is echoed as given); `list_task_classes` exposes `dispatchable` and
  lists no mandatory pack for it. Refusal rows are excluded from `heddle usage`
  dispatch/success counts (reported as a separate `refusals` column).
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
  { "hooks": { "PreToolUse": [ { "matcher": "mcp__heddle__dispatch_worker", "hooks": [ {
      "type": "command", "timeout": 10,
      "command": "node --disable-warning=ExperimentalWarning /Users/<you>/Developer/heddle/dist/hook-dispatch-guidance.js"
  } ] } ] } }
  ```
  (merge into your existing `hooks` object — `PreToolUse` must be nested under `"hooks"`, not at the
  settings root).
  Point it at the SAME checkout's `dist/` that your `~/.claude.json` heddle
  MCP entry uses (the canonical clone, not a transient worktree); honors
  `HEDDLE_ROUTING` like the server. Not registered by heddle itself — the
  operator (or a future plugin install) wires it. Verified end-to-end on
  Claude Code 2.1.232 (`additionalContext` reached the model verbatim).

## Known routing pitfalls (2026-08-15)

Learned from Agent V's HED-4/5 dispatches (ledger #35–41); policy until the linked tickets
land.

- **No `mcp` on gemini-routed classes** (`documentation`, `gemini-analysis`, and the
  `second-opinion` fallback): worker MCP attachment for agy/gemini is not implemented, and the
  throw happens after `ledger.start()` outside the try/finally — the ledger row is orphaned
  in-flight and skill restores are skipped (HED-63). Dispatch gemini classes without `mcp`.
- **`second-opinion` (grok-4.6-high) with memtrace attached is unreliable on long read-and-review
  prompts** — a design-review dispatch timed out at 600 s with no result JSON. Prefer no `mcp` and
  paste the relevant code/design into the prompt.
- **`documentation` output must be fact-checked against the code** — it drafts structure and
  schema/API sections well but fabricated roadmap items (invented "WebSocket push, queues,
  dispatch handles" for a ticket that says nothing of the kind). `assess_result` caught it
  (`needs-rework`); a human/orchestrator read is still required.

