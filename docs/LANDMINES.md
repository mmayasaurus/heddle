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
- **Never** use the reverse-engineered OpenCode↔Antigravity OAuth plugins: the flagship plugin is
  archived with an explicit ToS-violation + real-account-ban warning in its own README, corroborated
  by ban threads on Google's official forum. Not with a primary Google account, not ever here.

## Everywhere

- **No CLI exposes proactive quota-remaining.** Account usage from per-run structured output; catch
  429/rate-limit reactively; surface both on the dashboard.
- Output schemas are all different — one parser per adapter, no shared "result JSON" assumption.
- All model IDs in this repo are snapshots. Adapters must tolerate unknown-model errors and fall
  back per the routing table.
