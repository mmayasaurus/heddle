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

- Two execution modes (HED-78, 2026-08-15): the original **in-session subagents** of the interactive
  orchestrator (shared prompt cache, same account, native per-agent `skills`/`mcpServers`/
  `permissionMode`; `dispatch_worker(in_session: true)`), and the default **headless `claude -p`
  worker** under `CLAUDE_CONFIG_DIR=<account dir>` picked for headroom (src/adapters/claude.ts).
- **Headless contract (live-verified 2026-08-15, Claude Code 2.1.232):** `claude -p <prompt>
  --output-format json` prints ONE JSON object `{type:"result", subtype:"success"|…, is_error,
  result, session_id, duration_ms, num_turns, total_cost_usd, usage:{input_tokens, output_tokens,
  cache_read_input_tokens, cache_creation_input_tokens, output_tokens_details:{thinking_tokens}}}`;
  `--effort low|medium|high|xhigh|max`; `--model fable|opus|sonnet|haiku`; `--resume <session_id>`;
  `--append-system-prompt <text>` (packs, no file writes); `--mcp-config <file> --strict-mcp-config`;
  `--allowedTools <names…>` with `--permission-mode acceptEdits`. Session persistence writes to
  `<CLAUDE_CONFIG_DIR>/projects/<cwd-slug>/<session_id>.jsonl` — the proof that a worker ran under
  the intended account (verified for the default dir and ~/.claude-acct2).
- `--permission-mode auto` ABORTS the whole session after repeated classifier blocks in `-p` mode —
  use explicit allowlists. `bypassPermissions` requires a one-time interactive accept per machine.
  Resume is cwd-scoped and silently drops `--mcp-config`/`--settings`/`--plugin-dir`/`--add-dir` —
  re-pass on every call. (docs)
- **CLAUDE_CONFIG_DIR gotcha (R, 2026-08-15):** for the DEFAULT account leave it UNSET — setting it
  explicitly to `~/.claude` changes resolution and `claude auth status` reports loggedIn=false. heddle
  unsets it (buildWorkerEnv `unset`) for the default registry account and sets it for the others.
- **The permission layer is NOT a worker boundary — only `--tools` is** (live probe, 2026-08-15,
  PR #15 sweep): a worker launched with `--tools Read Grep Glob Bash` + a git-only `--allowedTools`
  list ("Bash(git status:*)" …) still appended to a tracked file and created a new one via plain
  Bash redirection — the OPERATOR's global settings.json permission allow-rules apply inside `-p`
  workers, the same leak class as global MCP servers before `--strict-mcp-config` (and there is no
  settings analog of that flag). Enforcement is therefore tool-SET restriction (`--tools`, verified
  to hold: Write reported disabled, no file created) or an OS sandbox (codex); `--allowedTools` is
  pre-approval convenience, never a fence. Claude read-only reviewers run `--tools Read Grep Glob`
  and get their diff EMBEDDED in the prompt (`embeddedDiff`, size-capped) since they cannot run git.
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
  **DIRECT REPRODUCTION ATTEMPT ON 1.1.9 — PASSED, twice (2026-08-01).** Round 1: three genuinely
  long-running neighbors (codex gpt-5.6-terra emitting 21KB, cursor grok-4.5-high 7.6KB,
  composer-2.5 8KB, all concurrent for ~37s) with agy launched 2s into the burst → SUCCESS in
  1.2s. Round 2 (harder): **four** long-running neighbors (2× codex + grok + kimi-k3, ~55s) with
  agy fired at +1s, +8s and +20s → all three SUCCESS, 1.0-1.1s each. This is the reported repro
  shape (agy + 3-4 other heavy CLI agents on long prompts) and it did not reproduce on 1.1.9 —
  9 releases past the 1.1.0 the issue was filed against. **Working conclusion: fixed in practice
  for this machine/version**, even though upstream never acknowledged it. Keep the adapter's
  detection anyway (cheap, and the issue is still formally open).
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

## Capabilities & sandboxes (HED-2, verified 2026-08-15)

- **Codex `workspace-write` keeps outbound network OFF by default** (official sandbox docs: "the default
  workspace-write sandbox mode keeps network access turned off unless you enable it in your
  configuration") — enable per dispatch with `-c sandbox_workspace_write.network_access=true`. Codex
  `web_search` defaults to `"cached"` (OpenAI-maintained index, no external access); `"live"` is
  unrestricted retrieval; `--yolo`/full-access flips the default to live. `--sandbox
  danger-full-access` = no sandbox, no approvals. These three are the ONLY capability flags heddle
  passes (src/capabilities.ts → src/adapters/codex.ts `buildArgs`).
- **cursor-agent has `--sandbox enabled|disabled` and agy has `--sandbox`** (terminal restrictions),
  but neither documents network/filesystem semantics and neither has a network or web-search knob —
  heddle therefore cannot enforce (or deny) `net`/`browse` on them: a grant is refused, and their
  headless workers are NOT network-fenced by heddle today. Verifying what those `--sandbox` flags
  actually restrict is a follow-up before default-enabling them.

## Worker cwd confinement — in-repo worktrees (HED-98, observed live 2026-08-16)

- **The hazard:** Maya's layout puts agent worktrees INSIDE the repo (`<repo>/.worktrees/<agent>`),
  and a linked worktree's `.git` is a FILE pointing at the parent. A worker that resolves "the
  project root" by walking up therefore lands in the CANONICAL checkout. Observed: an agy docs
  worker dispatched with `--cwd <repo>/.worktrees/agentv` wrote its edit into `<repo>/docs/COMMS.md`,
  leaving shared `main` dirty for every other agent.
- **No provider gives a write fence heddle can rely on ACROSS the fleet.** codex's `--sandbox
  workspace-write` is a real one (characterized below), but agy's `--sandbox` documents only "terminal
  restrictions" and heddle has NOT tested whether it confines file writes, so heddle does not pass it
  and does not claim it. cursor/claude have no equivalent knob. Detection (below) is therefore still
  the guarantee, because it needs no provider cooperation and covers the providers that have no fence.
- **codex `workspace-write` write-boundary — VERIFIED (HED-71, live-verified 2026-08-19, codex-cli
  0.147.0, macOS).** Under heddle's exact worker invocation (`--sandbox workspace-write
  --ignore-user-config`, no exclude flags → codex built-in defaults), writes are ALLOWED to the cwd
  subtree, `/tmp`, and `$TMPDIR` (`/var/folders/.../T` on macOS), and BLOCKED (EPERM) for every other
  `$HOME`-rooted path — a *sibling* of the cwd included — and any absolute path outside those roots.
  **One carve-out INSIDE the writable cwd:** codex pins `.git` (and its own `.codex`/`.agents`
  metadata) read-only even though cwd is writable — verified: a write to `.git/*` and `git add` (needs
  `.git/index.lock`) both EPERM. So a codex worker under workspace-write physically CANNOT `git
  add`/commit in its worktree — which is fine, it matches the worker-never-commits rule
  (`worker-role.md`), but a worker that tries will see a git error, not a product bug.
  - The common assumption "workspace-write blocks `$TMPDIR`" is **FALSE**. `std::env::temp_dir()` /
    `tempfile` tests write to `$TMPDIR` and PASS under a worker — so a worker reporting temp-dir tests
    as "sandbox failures" is wrong (this was the mistaken premise of HED-71's own filing). A test that
    fails ONLY inside the sandbox is writing to a `$HOME` path outside cwd/tmp (`~/.cargo` via
    `CARGO_HOME`, `~/.rustup` via `RUSTUP_HOME`, `~/.npm`, `~/.config`, `~/Library/…`), or to `.git`
    (above), or needs the network (off by default, above).
  - Fixing such a worker — but note the split between **what codex-CLI supports** and **what heddle's
    `dispatch_worker` exposes today** (the reason criterion 3 exists):
    - `dispatch_worker` today exposes only `capabilities` (`net`; `exec-privileged` → no sandbox at
      all, `danger-full-access`), `cwd`, and `codex_home`. It does NOT pass arbitrary `env` or `-c`
      to the worker, so **the only heddle-level fix today** for a worker that must write outside
      cwd/tmp is `exec-privileged` (heavyweight, trusted-only), or arranging its cwd so its writes
      land inside it.
    - codex-CLI *itself* also supports env-redirect (`CARGO_HOME=$cwd/.cargo`,
      `XDG_CACHE_HOME=$cwd/.cache` — but NOT `RUSTUP_HOME`, `~/.npm`, or `~/Library`, which need their
      own vars) and `-c 'sandbox_workspace_write.writable_roots=["<exact-dir>"]'` (validated: flips a
      blocked `$HOME` write to OK, even with `--ignore-user-config`; a broad root like `$HOME` is near
      `danger-full-access`, so name the exact dir). These are NOT reachable through `dispatch_worker`
      yet — wiring an env/writable-roots passthrough is criterion 3 (sandbox-widening → held for Maya).
  - This boundary also means that under **default** workspace-write a codex worker whose cwd is a
    *linked* worktree cannot write into the canonical checkout (the worktree's PARENT is outside cwd).
    It is NOT an absolute fence: `exec-privileged` (`danger-full-access`) removes it, and a worker
    dispatched with its cwd set AT the canonical checkout is not fenced from it. agy/cursor/claude have
    no fence at all — which is why the escape DETECTION below (`src/worktree.ts`, provider-independent)
    stays load-bearing.
- **So heddle DETECTS instead** (`src/worktree.ts`), which needs no provider cooperation and is
  exact: a linked worktree has `git rev-parse --git-dir` != `--git-common-dir`, and the canonical
  checkout is `dirname(common-dir)` (verified 2026-08-16). One `git status --porcelain` on the
  parent before and after the run; any change is surfaced as `escape-warning:` on the outcome and
  the ledger row, naming the paths.
- **Warning, not failure, deliberately:** the work product may be fine and destroying it would be
  its own harm; nothing is reverted (the operator decides, as with the read-only mandate). heddle
  also cannot ATTRIBUTE the change — another agent legitimately editing the canonical checkout looks
  identical — so the wording states what was observed, never who did it.
- **Prevention is best-effort:** the worker's prompt names its worktree as the project root and says
  not to walk up. That is a nudge, not a fence — the detection is the guarantee.

## Worker MCP attachment (memtrace) — worktrees

- **memtrace indexes the canonical checkout, not your worktree.** A worker dispatched into a git
  worktree with `mcp: [memtrace]` queries the index of the main clone (`repo_id` = the canonical
  path), so it "sees" main's symbols and misses anything new on the branch — a worker asked to test
  branch-new code will not find it and may conclude it doesn't exist. Verified 2026-08-15 (Agent U,
  HED-1: memtrace deliberately NOT attached to a test-writing worker in `heddle.agentu` for this
  reason). Until worktree overlays are wired (`watch_directory` / `worktree=` overlay on the
  canonical repo_id — tracked as a HED ticket), either omit memtrace for branch-new code or dispatch
  into the canonical checkout.

## Everywhere

- **No CLI exposes proactive quota-remaining.** Account usage from per-run structured output; catch
  429/rate-limit reactively; surface both on the dashboard.
- Output schemas are all different — one parser per adapter, no shared "result JSON" assumption.
- All model IDs in this repo are snapshots. Adapters must tolerate unknown-model errors and fall
  back per the routing table.
