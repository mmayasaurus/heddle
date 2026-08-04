# Heddle Dashboard — product spec (Maya's vision, captured 2026-08-03)

> Source of truth for what the dashboard IS. Maya described this in full on 2026-08-03; this doc
> is that description structured, with feasibility notes marked ⚙️ and open decisions marked ❓.
> Supersedes the earlier "visibility-only localhost viewer, no embedded terminals" scope from
> 2026-08-01 — Maya's expanded vision explicitly includes in-app terminals.

## Shell layout

Three panes + bottom bar. Maya works primarily *in terminals* — the dashboard makes sense of them.

```
┌──────────────┬──────────────────────────────────┬──────────────┐
│ LEFT         │ CENTER (app-level tabs)          │ RIGHT        │
│ Orchestrator │ ┌─tab─┬─tab─┬─tab─┬─chat─┐       │ [Linear|PRs] │
│ roster       │ │ terminal workspace       │     │ live lists   │
│ (vertical)   │ │ (one orchestrator/tab)   │     │              │
├──────────────┴─┴──────────────────────────┴─────┴──────────────┤
│ BOTTOM: per-provider usage meters (Claude·Codex·Gemini·Cursor) │
└────────────────────────────────────────────────────────────────┘
```

## Left pane — orchestrator roster

- Vertical list of every orchestrator: fleet letter/name + what it's currently working on +
  status glyph (working / needs-Maya / idle / blocked / chatting).
- **Single click** expands the row: claimed Linear issues, owned PRs, subagents in flight
  (name, model, current task, usage), recent activity — the high-level overview.
- **Double click** opens/focuses that orchestrator's terminal tab in the center.
- Subagent names everywhere are clickable → jump to that subagent's inner terminal tab.

## Center — terminal workspace

- **App-level tabs, one terminal window per tab** (one per orchestrator), plus the Chatroom tab.
- Within each orchestrator's tab, the terminal has **inner tabs**: the orchestrator session
  itself, plus one tab per active subagent. Each subagent tab is selectable and supports
  **direct 1:1 communication with that subagent**.
- **Statusline** (claude-hud — Maya's existing "command line info bar") renders per inner tab
  exactly as it does today: context %, 5-hour + weekly usage bars, git branch/worktree, model —
  changing dynamically with the selected tab. Extended with a heddle segment showing, for an
  orchestrator tab: its subagent roster (names + per-subagent usage + current task) and its
  claimed SPI issues / owned PRs; for a subagent tab: that subagent's own deeper context/usage.
- ⚙️ Feasibility: iTerm2 itself cannot be embedded inside another app (it's a standalone macOS
  app). The path that preserves BOTH worlds: **tmux as the session substrate**. Every
  orchestrator session lives in a tmux session; iTerm2 attaches via `tmux -CC` (iTerm's native
  tmux integration — Maya keeps real iTerm tabs/windows, native scrollback, her exact current
  experience), while the dashboard attaches the SAME live sessions via embedded terminal panes
  (xterm.js + node-pty running `tmux attach`). One session, two synchronized surfaces — typing in
  either is typing in the same session. The statusline renders inside the session, so it appears
  identically in both. This makes tmux load-bearing (revisits the "tmux ok-but-not-v1" decision).
- ⚙️ Per-subagent live context% has no direct API for in-flight Claude subagents; heddle shows
  exact per-run usage for cross-provider workers (adapters already parse it) and best-effort
  live estimates for Claude subagents from hook events. Exact-after, estimated-during.

## Chatroom (center tab) — PULL model (decided 2026-08-03)

A terminal-style chatroom — one shared room for the whole fleet.

- **Agents check the room when they want** to know what the fleet is doing. Nothing is injected
  into context by default — near-zero token cost when quiet, and no digest machinery needed.
- **`@all` = guaranteed delivery.** Broadcasting with `@all` (or `@AgentB` for one target) fires
  a notification the recipient will actually see, via its Monitor subscription — so
  fleet-critical messages don't wait for someone to poll.
- **Culture: conservative by design.** Use it for: needing another opinion, answering someone's
  question, announcements affecting multiple agents, and open questions where the right responder
  is unknown. Not chatter, not narration. Agents respond to mentions, and chime in unprompted
  only when they can genuinely contribute.
- **Subagents may post, sparingly** — e.g. a worker stuck mid-task asking for an assist.
- **Messages do NOT appear in individual terminal tabs** — the room is its own surface.
- **DMs are first-class**: subagent↔subagent, subagent↔host orchestrator, and Maya↔anyone.
- Implementation: the room is a broker thread; the "terminal chatroom" is a small TUI client
  attached to it — so **the chatroom works from plain iTerm2 tabs before the GUI exists**.

## Per-subagent view (center)

Selecting a subagent from the statusline's subagent list (or the left roster) switches the center
view to **that subagent's own surface**: its live conversation with its host orchestrator, its DMs
with Maya, and — where the provider exposes it — its **thinking**.

**Thinking availability is provider-dependent (verified live 2026-08-03):**

| Worker | Thinking content | What the UI can show |
|---|---|---|
| Cursor | **YES** — streamed `type:"thinking"` deltas | full live thinking |
| Claude | **YES** — thinking blocks in stream-json/transcript | full thinking |
| Codex | **NO** — content withheld; only `reasoning_output_tokens` | step/progress + reasoning-token count |
| agy / Gemini | **NO** — `step_update` steps + response deltas; `thinking_tokens` only | step/progress + thinking-token count |

Thinking display is a per-tab toggle, on by default where available; where it isn't, the UI says
so explicitly rather than implying the pane is empty because the model isn't reasoning.

## Right pane — Linear + GitHub, the real things

- Two tabs: **Linear issues** and **GitHub PRs** — live-synced lists (Linear API + webhooks;
  GitHub API), showing the fleet-relevant view (claimed-by-whom, state, needs-attention).
- Clicking an item opens a **movable popup** (center terminal stays visible) containing the
  **actual Linear issue view / actual GitHub PR page — not a re-rendered knockoff**: fully
  interactive (assign, tag, comment, everything), inherently always in sync because it IS Linear/
  GitHub, logged in as Maya.
- Cross-links both ways: a PR card exposes its linked Linear issue (via the existing `Fixes SPI-n`
  / pr-linear-sync machinery) and vice versa.
- ⚙️ Feasibility: browsers block framing linear.app/github.com (X-Frame-Options/CSP), so a plain
  web app cannot embed them. An **Electron shell** can: BrowserView popups deep-linking to the
  real issue/PR URLs behave like logged-in browser tabs — full native functionality, zero
  reimplementation. This is the argument that decides Electron vs plain-web (❓ confirm Electron).

## Bottom bar — provider usage meters

Per-provider, per-account meters with percentages, covering every limit type the provider has:

| Provider | Meter quality | Source |
|---|---|---|
| Claude (per account) | Real 5-hour + weekly bars | same source claude-hud uses today |
| Codex (per account ×2) | Real 5-hour + weekly bars + reset times | the `wham/usage` endpoint `claudex-usage` already queries (unofficial but working) |
| Gemini/agy | Estimated only — Google publishes no numbers and no API | consumption trend from per-run usage + last-429/cooldown markers |
| Cursor | Estimated only — dashboard-web-only, no API | per-run token/pool accounting from adapter output; Cursor-Models vs Other-Models ("PR-review pool") shown separately |

⚙️ Honest asymmetry: Claude/Codex meters are real percentages; Gemini/Cursor are heddle's own
bookkeeping until those vendors ship usage APIs (none exists today — verified).

## Stats screen (its own app section)

A dedicated screen of everything the orchestration produces — not squeezed into the meters bar:

- **Token usage**: per orchestrator, per subagent, per task class, per provider, per model, over
  time. Cache-hit ratios (already parsed from every adapter's usage block).
- **Provider usage**: consumption trends against each plan's limits; which accounts are hot;
  cooldown/reset timers; Cursor pool split (Cursor-Models vs the metered Other-Models pool that
  PR review shares).
- **Routing / savings**: % of work routed off the Claude pool, dispatches per task class, model
  win-rates (how often a routed worker's output was accepted vs redone), cost-per-issue trend.
  This is the "is orchestration actually working" screen.
- **Subagent stats**: dispatch counts, success/failure/timeouts, mean duration by model+class,
  which skill packs were loaded, retries and fallbacks fired (e.g. agy hang-signature events).
- **Tooling usage**: memtrace and Serena call counts/latency per agent (both expose MCP telemetry
  — Memtrace already ships a posttool telemetry hook), plus MCP server usage generally.
- **Code quality**: gate pass/fail rate, lint/typecheck/test outcomes per dispatch, PR review
  round-trips per issue, regression tests added, reviewer findings by class.

## Data spine (what feeds all of this)

Everything above reads from the Phase-2 broker + ledger, which is why comms gets built first:
- **Broker** (SQLite + WebSocket + MCP tools): chat, mentions, needs-Maya queue, agent presence.
- **Ledger**: dispatch records (who → which model → which task/SPI/PR, usage per run).
- **Hook events**: all four CLIs' hook systems append activity (tool use, session lifecycle).
- **tmux**: session registry = the roster's ground truth for what's alive.
- **Linear/GitHub APIs**: right-pane lists; popups are the real apps and need no sync at all.

## Build order (set by Maya 2026-08-03 — orchestration first, GUI last)

**The point: get lettered agents A–Q orchestrating real Spinventory work ASAP, then build the
dashboard around a system that's already running.**

1. **Phase 1 — orchestration mechanisms** → `docs/ORCHESTRATION.md`. Dispatcher CLI, ledger,
   skill packs, heddle MCP server, `/orchestrate` command, rules/docs. Pilot on a real SPI issue,
   tune routing from ledger data, roll out to the fleet. *No GUI involved.*
2. **Phase 2 — chatroom + terminal experience.** Broker + TUI chat client (works in plain iTerm);
   statusline extension listing subagents with per-subagent context/usage and clickable selection;
   tmux substrate so sessions are attachable from both iTerm2 (`-CC`) and, later, the app.
3. **Phase 3 — Electron shell**: left roster, center terminal tabs (+ inner subagent tabs), chat
   tab, bottom provider meters.
4. **Phase 4 — right pane**: Linear/PR lists + real-app popups + cross-links.
5. **Phase 5 — stats screen** + savings analytics + polish.

## Decisions (locked 2026-08-03)

1. ✅ **Electron shell** — required for real Linear/GitHub popups and embedded terminals.
2. ✅ **tmux substrate** with iTerm2 `-CC` attach — makes one live session visible in both iTerm
   and the app.
3. ✅ **Chat is pull-based**, with `@all`/`@agent` as the guaranteed-delivery exception; culture is
   deliberately conservative. (Replaces the earlier ambient-digest design — simpler and cheaper.)
4. ✅ **Subagents may post** to the room sparingly, and have first-class DMs with each other, their
   host orchestrator, and Maya.
5. ✅ **Thinking shown where the provider exposes it** (Cursor, Claude), with an explicit
   "not exposed by this provider" state for Codex and Gemini.
