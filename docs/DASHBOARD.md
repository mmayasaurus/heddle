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

## Chatroom (center tab)

A terminal-style chatroom — one shared room for the whole fleet.

- Participants: all orchestrators + Maya (first-class); subagents can be granted posting rights
  (❓ default-on or opt-in per dispatch?).
- **@mentions**: tagging Agent B notifies B (broker push → Monitor event in B's session); B is
  expected to come respond in the room. Agents also chime in unprompted where they can contribute,
  and use the room for broadcasts.
- **Messages do NOT appear in individual terminal tabs** — the room is its own surface; agents
  read/write it via broker tools, not via their terminal I/O.
- **Ambient context**: chatroom traffic flows into every orchestrator's context — tagged AND
  untagged — so agents passively know what the fleet is doing; each agent prunes what's
  irrelevant to it. ⚙️ Token-cost control: mentions + replies deliver immediately; untagged
  ambient traffic delivers as periodic digests (batched, summarizable, prunable) rather than
  per-message injection — same information, bounded cost. (❓ digest cadence, and whether Maya
  wants a raw-firehose override per agent.)
- Implementation: the room is a broker thread; the "terminal chatroom" is a small TUI client
  attached to it — which means **the chatroom works from plain iTerm2 tabs before the GUI app
  exists at all** (it's just another terminal program).

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

## Data spine (what feeds all of this)

Everything above reads from the Phase-2 broker + ledger, which is why comms gets built first:
- **Broker** (SQLite + WebSocket + MCP tools): chat, mentions, needs-Maya queue, agent presence.
- **Ledger**: dispatch records (who → which model → which task/SPI/PR, usage per run).
- **Hook events**: all four CLIs' hook systems append activity (tool use, session lifecycle).
- **tmux**: session registry = the roster's ground truth for what's alive.
- **Linear/GitHub APIs**: right-pane lists; popups are the real apps and need no sync at all.

## Build order (revised 2026-08-03)

1. **Phase 2 — broker + chatroom TUI** (functional comms BEFORE any GUI: mentions, notifications,
   ambient digests, needs-Maya queue — usable from plain iTerm tabs immediately).
2. **Phase 2.5 — tmux substrate + launcher** (orchestrators start inside tmux; iTerm2 `-CC`
   attach preserves Maya's exact current experience; `heddle start/resume` wraps the existing
   resume scripts).
3. **Phase 3 — Electron shell MVP**: left roster + center tabs with embedded live terminals +
   chatroom tab + bottom meters (Claude/Codex real, Gemini/Cursor estimated).
4. **Phase 4 — right pane**: Linear/PR lists + real-app popups + cross-links.
5. **Phase 5 — statusline deep integration** (per-subagent segments), savings analytics, polish.

## Open decisions (❓ for Maya)

1. Electron shell (required for real-Linear/GH popups + embedded terminals) — confirm.
2. tmux as session substrate with iTerm2 `-CC` attach — confirm (this is what makes "same session
   visible in iTerm AND the dashboard" physically possible).
3. Chat ambient-context delivery: digest cadence / raw-firehose option.
4. Subagent chatroom posting: default-on or per-dispatch opt-in.
