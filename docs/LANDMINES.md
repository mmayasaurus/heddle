# Landmines — verified per-CLI gotchas

Live-verified on 2026-08-01 unless marked (docs). Re-verify dates matter: model catalogs and CLI
flags churn monthly.

## Codex CLI (`codex exec`)

- **Spawn with stdin closed** (`stdio: ['ignore', …]` / `< /dev/null`). With stdin left open (the
  default when spawned from another process), `codex exec` blocks forever on
  `"Reading additional input from stdin..."` before doing anything. **Live-verified both ways.**
- Upstream regression report openai/codex#19945 (silent exit-0 with empty stdout when TTY-detached
  with long prompts) did NOT reproduce on v0.144.1 — but adapters must still treat
  `exit 0 && stdout empty` as failure, not success.
- `--full-auto` is deprecated and no longer unattended (sandbox-only). True unattended is
  `--dangerously-bypass-approvals-and-sandbox` (`--yolo`); softer modes can hang headless waiting
  for an approval prompt no TTY will show. (docs)
- `--json` output is NDJSON events, not one object: `thread.started` (resume handle),
  `turn.completed` (usage: input/cached_input/output/reasoning tokens), `item.completed` (agent
  message lives in items). No dollar-cost field exists.
- Per-invocation context overhead is real: a trivial prompt under a fully-configured `~/.codex`
  cost ~22k input tokens (skills + AGENTS.md auto-load). `--ignore-user-config` / `--ephemeral`
  are the slim-context knobs for cheap tasks; `--ephemeral` also disables resume.
- `notify` key must precede any `[table]` in a generated `config.toml`, or it silently fails. (docs)
- GPT-5.4 / 5.4-mini retire from ChatGPT-auth Codex 2026-08-31. (docs)

## Cursor CLI (`cursor-agent`)

- Headless is `cursor-agent -p --output-format json` — returns ONE JSON object:
  `{type:"result", is_error, result, session_id, request_id, duration_ms}`. **Live-verified**,
  including on `kimi-k3-high`.
- **`-p --resume <session_id>` works with real context continuity** (undocumented combination —
  live-verified: a resumed session recalled prior-turn content).
- `--trust` (or `--force`) is required in any workspace the CLI hasn't seen, or headless runs
  hard-fail. Pass it when spawning into fresh worktrees.
- Effort is baked into model IDs (`kimi-k3-high`, `cursor-grok-4.5-{low,medium,high}`); `-fast`
  variants bill ~2×. `cursor-agent models` is the live catalog (server-refreshed ~10min) — never
  hardcode.
- **The result JSON DOES carry usage** (undocumented at research time; live-verified 2026-08-01):
  `usage: {inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}`. The adapter parses it.
- No usage/quota API — the "Other Models" dollar pool is only visible on cursor.com's dashboard.
  Track spend per-run client-side and enforce the route-away guard.
- Latency varies enormously by model on identical trivial prompts (live-verified): composer-2.5
  1.8s · cursor-grok-4.5-low 2.8s · kimi-k3-high 74s. Route latency-sensitive work accordingly.
- `agent create-chat` pre-allocates a session id before first dispatch (useful for registries). (docs)
- `--format json` (on `status`/`about`) vs `--output-format json` (on runs) — different flag names. (docs)

## Claude Code (workers)

- Default execution is **in-session subagents** of the interactive orchestrator (shared prompt
  cache, flat subscription pool, native per-agent `skills`/`mcpServers`/`permissionMode`) — not
  `claude -p` subprocesses.
- If headless IS used: `--permission-mode auto` ABORTS the whole session after repeated classifier
  blocks in `-p` mode — use explicit allowlists. `bypassPermissions` requires a one-time
  interactive accept per machine. Resume is cwd-scoped and silently drops
  `--mcp-config`/`--settings`/`--plugin-dir`/`--add-dir` — re-pass on every call. (docs)
- Transcript JSONL under `~/.claude/projects` is explicitly format-unstable — consume
  `--output-format stream-json` and hooks, never parse transcripts. (docs)
- Billing: subscription flat pool covers Claude Code usage; "usage credits" are optional opt-in
  overage — official costs docs show no separate mandatory headless metering (verified 2026-08-01).

## Gemini

- `google-gemini/gemini-cli` cannot authenticate personal Google accounts (free/AI Pro/Ultra) since
  ~2026-06-18 — **live-verified dead** on 2026-08-01. Never route Gemini via Cursor
  (subscription-boundary rule).
- **Antigravity CLI (`agy`) — PILOTING as of 2026-08-01** (agy 1.1.9, personal-subscription OAuth,
  quota-billed, no BYOK). Live-verified on the fleet box: solo headless clean (valid JSON, status
  SUCCESS); **the #573 concurrency hang did NOT reproduce** — 3 agy + codex + cursor
  simultaneously from a non-TTY shell all completed in 11s; `--model` honored AND echoed in
  stream-json events (adapter verifies echo, detecting the #710 silent-Flash-fallback class);
  `--conversation` resume carries real continuity and is cache-warm. Caveats that keep this
  "piloting" not "trusted": upstream #573 was filed against 1.1.0 with *long-running* neighbor
  processes (our test used short-lived workers); #689/#702/#710 remain open upstream. The adapter
  therefore always: hard-timeouts, requires `status==="SUCCESS"` + non-empty response + model
  echo match, and never trusts exit code alone. ~18.2k input-token overhead per invocation
  observed (likely the global `~/.agents/skills` pool auto-loading — slim-context knob TBD).
  Envelope (`--output-format json`) has NO model field — use stream-json when model verification
  matters.
- **#573 characterized precisely** (fetched from the issue, 2026-08-01): filed against **agy 1.1.0**
  on macOS Apple Silicon; trigger is **one `agy -p` alongside 3+ OTHER long-running CLI agent
  processes** (codex-cli + opencode + grok in the repro) — the neighbors complete, agy hangs
  forever with no output. Staggered 5s starts do NOT help; not tied to any one neighbor's flags;
  reporter's read is **contention during startup/handshake**, not unconditional TTY detection.
  Solo reliability reported "100%". Still OPEN, no maintainer response, no PTY workaround
  mentioned; reporter's workaround is sequencing agy outside other CLI bursts.
  **The reporter's own eliminations refine the envelope sharply** (all from the issue body):
  3 parallel *agy-only* runs finish in single-run time (8s) — so it is NOT agy-vs-agy; every
  *pairwise* combination (agy + one other CLI) passes 100%; the failure needs **3+ OTHER heavy
  CLI processes running longer prompts**. `--log-file` emits nothing during the hang — it dies
  before its own logging initializes, i.e. in process bootstrap, not the request path.
  **Correction to our earlier read:** our clean pass (3 agy + codex + cursor, short-lived) had only
  **two** other CLI *types* — inside the empirically safe envelope, so it never actually exercised
  the bug. Do not read it as a refutation.
  **Operating rule for the routing/scheduler layer: keep ≤2 other heavy CLI agent processes running
  alongside any agy dispatch**, or serialize agy against other-provider workers. Note that Maya's
  real topology (several long-running interactive orchestrator tabs) can exceed this on its own.
  Mitigation shipped in the adapter: distinguish timeout-with-no-output (#573 signature → one
  capped 120s retry probe, then an explicit fail-over error) from timeout-with-partial-output (a
  merely slow task → no retry, raise `timeoutMs`). Nine releases of notes (1.1.1→1.1.9) never
  mention concurrency and the issue has zero maintainer comments — treat as unfixed.
- **Same-conversation concurrency is a SEPARATE documented hang**: overlapping calls against one
  `conversation_id` hit a session lock inside agy (reported by the tphakala/agy-mcp maintainer).
  The adapter serializes per-conversation dispatches (different conversations still run in
  parallel) — verified live: 3 concurrent resumes of one conversation returned "LOOM 1/2/3"
  correctly in 6.5s instead of deadlocking.
- Headless/one-shot runs still **block on MCP-server loading at startup by design** (1.1.9 notes;
  interactive sessions got backgrounded loading, headless didn't) — every MCP server attached to
  an agy worker is paid for in startup latency on every dispatch. Attach per-task, never globally.
- PTY wrappers (e.g. agy-headless-bridge) target #76, which upstream fixed in 1.1.1 — and a Google
  engineer's root-cause (swallowed server errors + inherited-stdin blocking) contradicts the
  isatty-gate theory those wrappers assume. Low marginal value now; keep in reserve only.
- **Never** use the reverse-engineered OpenCode↔Antigravity OAuth plugins: the flagship plugin is
  archived with an explicit ToS-violation + real-account-ban warning in its own README, corroborated
  by ban threads on Google's official forum. Not with a primary Google account, not ever here.

## Account rotation (multiple subscriptions per provider)

- **The billing trap is the whole ballgame.** Every vendor treats an API-key env var as an
  override that silently moves billing OFF the subscription, and headless mode gives no prompt —
  Anthropic's docs: *"In non-interactive mode (-p), the key is always used when present"*;
  OpenAI's: *"When you sign in with an API key, Codex uses standard API pricing instead of
  included ChatGPT plan credits."* A stray export in a shell rc, a `.env`, or an inherited CI var
  would bill per-token invisibly. `src/env.ts` strips all of them from every worker env and
  refuses them as overrides — verified live.
- **Codex — cleanest lever, and proven:** `CODEX_HOME` selects the account (its own `auth.json`,
  config, and session history). Live-verified: the same dispatch pointed at two different
  `CODEX_HOME` values reached two different accounts. `--profile` does NOT carry auth (one
  CODEX_HOME = one identity; the `[profiles.*]` syntax was removed in 0.134.0+).
  ⚠️ **Never run two concurrent workers under the same `CODEX_HOME`** — openai/codex#35619
  documents catastrophic rollout-history loss (934 of 942 threads) from exactly that.
- **Claude — `CLAUDE_CONFIG_DIR` per account** relocates config, sessions, and (on Linux/Windows)
  credentials. **Open gap on macOS**: credentials live in the Keychain (`Claude Code-credentials`)
  and no Anthropic doc states whether a second config dir gets its own Keychain item. Verify
  before relying on it. For a future `claude -p` subprocess path, the docs-recommended
  subscription-preserving credential is `claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN`
  (one per account). **Never `--bare`** — it cannot use subscription auth at all (OAuth and
  keychain are never read), so it silently forces API-key billing.
- **Cursor — thinnest lever, and billing semantics are UNDOCUMENTED.** No config-dir mechanism
  exists; `CURSOR_API_KEY` (env var only — `--api-key` on argv leaks via `ps`) is the sole account
  selector, minted at cursor.com/dashboard/api. **Directly checked 2026-08-01: the CLI auth page,
  the pricing page, and account/api-keys (404) say NOTHING about how API-key-authenticated usage
  is billed** — plan quota vs. separate metered API billing is simply not stated anywhere in the
  docs. The only claim either way is a Cursor staff forum reply saying it draws on that account's
  own plan. **Do not mint keys for rotation until that's empirically confirmed** (mint one, run a
  small job, check whether it lands on the plan dashboard) — an unverified guess here risks
  exactly the per-token billing this project forbids. Browser login (`cursor-agent login`) is the
  known-safe path; account switching that way is manual + global (`logout`/`login`).
  Mitigating factor: Grok 4.5 and Composer 2.5 are **Cursor Models** (generous plan allowance),
  not the metered "Other Models" pool — so routing supplemental work to those two may make Cursor
  rotation unnecessary. The stream-json `system/init` event carries `apiKeySource`
  (`env`/`flag`/`login`) to confirm which credential a run actually used.
- **Rate-limit detection is string-matching everywhere** (no CLI has a machine-readable quota
  signal). Claude: `"hit your session limit"` / `"...weekly limit"` / `"...Opus limit"`, each
  followed by `· resets <time>` — three independently-clocked limits per account, so track three
  timers. Codex: `"You've hit your usage limit"` and `"exceeded retry limit, last status: 429"`.
  Cursor: match a stable substring like `"hit your usage limit"` case-insensitively — multiple
  phrasings exist, and at least one third-party tool shipped a false positive by matching the bare
  word "error".
- **Proactive alternative for Codex only:** `~/.local/bin/claudex-usage` already queries an
  undocumented ChatGPT usage endpoint with an account's own token and gets back real
  used-percentage + reset times. Unofficial and could break, but it's the only proactive quota
  signal available anywhere in this stack — reuse it for route-away-before-exhaustion.

## Everywhere

- **No CLI exposes proactive quota-remaining.** Account usage from per-run structured output; catch
  429/rate-limit reactively; surface both on the dashboard.
- Output schemas are all different — one parser per adapter, no shared "result JSON" assumption.
- All model IDs in this repo are snapshots. Adapters must tolerate unknown-model errors and fall
  back per the routing table.
