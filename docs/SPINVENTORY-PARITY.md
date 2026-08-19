# Spinventory → heddle discipline parity (HED-97)

> Audit date 2026-08-16 (Agent S). Source inventory: worker enumeration of the Spinventory
> workspace (`.claude/{hooks,rules,commands,bin}`, settings wiring, root conventions, `_vault/`).
> **Living doc**: a GAP row changes to PARITY/BETTER only after its fix is implemented and the
> receipt is independently verifiable — filing or merging a ticket alone changes nothing.

Bar (Maya, 2026-08-16): heddle must work **as well as or better than** Spinventory's current
system — the rest of Spinventory will be built inside heddle, and nothing may regress at
migration. One row per Spinventory system: heddle equivalent, verdict, receipt. Cross-cutting
rows (Spinventory column `—`) are allowed for properties the audit surfaced that belong to no
single Spinventory system, and they count in the gate like any other row. Every **GAP** row
has a ticket. Spinventory keeps running unchanged until every **non-SKIP** row is PARITY or
BETTER; SKIP rows are excluded from the migration gate and each carries its scope
justification in its Notes/receipt cell.

Verdict column uses exactly one of: **BETTER** (heddle exceeds it) · **PARITY** (equivalent
in effect) · **GAP** (missing/weaker — ticketed) · **SKIP** (explicitly out of migration
scope — either project-specific to Spinventory or already global to every project, so nothing
migrates; the justification is stated per row). Qualifiers (priority, maturity, follow-ups)
live in the Notes & receipt column.

## Hooks (runtime enforcement)

| Spinventory system | heddle equivalent | Verdict | Notes & receipt |
|---|---|---|---|
| agent-identity.py (durable fleet letter at SessionStart) | Same hook, shared: heddle cwds load workspace hooks via each repo's `.claude/settings.json` (workspace commit 11193e8) | **PARITY** | Verify: open a session with cwd in either heddle repo — the SessionStart primer names your agent letter. Portability caveat → HED-107 row below |
| require-memtrace-first.py (record-only in Spinventory) | Same hook, **hard gate ON** for heddle roots (`ENFORCEMENT_ROOTS`: heddle=True) | **BETTER** | HED-82; denial telemetry lines in `~/.heddle/discipline.jsonl` |
| require-pr-sweep.py (3-channel record + enforce-stop) | Same hook + pr-sweep.sh channels **(d) code-scanning alerts, (e) checks** added for heddle | **BETTER** | HED-16; `docs/REVIEW-SWEEP.md` (both repos) documents (d)/(e); any sweep output shows the sections |
| delegation-nudge.py | Same, shared; heddle side adds per-turn dispatch counts + shared-cap % (HED-85 telemetry contract) | **BETTER** | UserPromptSubmit context in heddle sessions shows "dispatched N workers / cap %" |
| remind-owned-prs.py + pr-own.sh ownership | Same, shared; works on heddle repos | **PARITY** | pr-sweep.sh prints "Ownership: YOURS (<worktree>)" on heddle PRs (e.g. heddle#18/#19 sweeps 2026-08-16) |
| protect-workspace.py (path guard for _vault/, CONTEXT.md, AGENTS.md…) | Global destructive-command hook covers rm/force-push everywhere; **no heddle-specific critical-path list** (docs/, .claude/, .github/workflows) | **GAP** | Minor. HED-104 |
| require-vault-search.py (knowledge lookup gated before app edits) | No heddle vault → nothing to gate | **GAP** | HED-101 |
| auto-reindex-vault.py | n/a without vault | **GAP** | HED-101 |
| — (cross-cutting, surfaced by this audit) | Hook DISTRIBUTION: the SILENT file-existence guards are gone — every hook now runs behind a loud-fail-open guard (absent → stderr banner + skip, never a silent vanish). All 5 hooks still resolve to the Spinventory canonical (behavior-neutral); vendoring / self-containment is deferred to HED-96, where the canonical is relocated to `~/.heddle` and its pre-existing findings fixed first (vendoring canonical code as-is imports its scanner findings — see HED-107 sweep) | **PARTIAL** | HED-107 (loud-fail-open bridge — done) → HED-96 (canonical → ~/.heddle, hook vendoring, deliberate enforce-flip). Caught by codex review on heddle#22 |

## Rules (binding constraints)

| Spinventory | heddle | Verdict | Notes & receipt |
|---|---|---|---|
| pr-review-sweep.md (Commandment #3) | docs/REVIEW-SWEEP.md in BOTH repos + channels d/e + two-sweeps-15-min codified | **BETTER** | HED-16; merged via heddle#10 + dashboard#13 |
| pr-ownership.md | Shared pr-own.sh + pr-discipline.md references; ownership markers work cross-repo | **PARITY** | PR-OWNER marker comments visible on heddle#18/#19/#22, dashboard#22/#24 |
| issue-tracking.md (SPI) | Per-repo issue-tracking.md, LIN_TEAM=HED, exclusive Area labels | **PARITY** | `.claude/rules/issue-tracking.md` in both repos |
| worktree-discipline.md (sibling-dir era) | Per-repo worktree-discipline.md: **in-repo .worktrees/, recycle-don't-mint, standing removal auth** (Maya 2026-08-15) | **BETTER** | `.claude/rules/worktree-discipline.md` in both repos |
| heddle-self-merge.md | heddle-native (written for HED). Currency = **not CONFLICTING** (`gh pr view --json mergeable`), so a merely-behind branch merges as-is — the same practice Spinventory follows, adopted 2026-08-17 after heddle's stricter "up to date with main" rule failed to converge under six agents. The 2026-08-16 config-text exception is **superseded** by that general rule and kept only for provenance | **PARITY** | Rule: `.claude/rules/pr-discipline.md` condition 5 (authority: workspace `heddle-self-merge.md` @ ce6f2da, Maya-ratified). Verify the enforcement basis live: `gh api repos/mmayasaurus/heddle/rulesets/20912747` shows `strict: false`, i.e. GitHub never required currency. Downgraded from BETTER on 2026-08-17: heddle had grown a stricter rule than its parent and removing it is parity, not an improvement |
| serena.md | Per-repo memtrace-serena.md (memtrace-first + Serena complement + worktree overlays) | **PARITY** | `.claude/rules/memtrace-serena.md` in both repos |
| No-squash / merge-commit-only (AGENTS.md Commandment 1) | **Server-enforced**: protect-main rulesets — PR-only, merge-commit-only, thread resolution required, no force-push, no bypass actors | **BETTER** | Verify live: `gh api repos/mmayasaurus/heddle/rulesets/20912747` and `gh api repos/mmayasaurus/heddle-dashboard/rulesets/20912748` (applied 2026-08-16, HED-13) |
| sleek/social style guides (stub→command pattern) | No heddle UI style guide yet; dashboard UI work is growing | **SKIP** | Scope: content is Spinventory-UI-specific. The stub→on-demand-command PATTERN is stealable when a dashboard style guide is written (no ticket until then) |
| argent.md stub | Global rule loads everywhere already | **SKIP** | Scope: device tooling, loads from `~/.claude/rules/argent.md` in every project |

## Commands (workflows)

| Spinventory | heddle | Verdict | Notes & receipt |
|---|---|---|---|
| /startup (daily briefing ritual) | `/startup` in both repos' `.claude/commands/` — orient from LIVE sources (git + Linear + GitHub API), no hand-maintained state doc | **PARITY** | `.claude/commands/startup.md`, landed HED-100. Deliberately reads live state only: the audit found Spinventory's `_vault/decisions/`, `_vault/sessions/` and `.session/` all empty in practice |
| /closeout (handoff, commit+push-everything, state.md) | `/closeout` in both repos' `.claude/commands/` — nothing uncommitted/stashed/unpushed, truthful PR state, Linear reflects reality, handoff into durable places | **PARITY** | `.claude/commands/closeout.md`, landed HED-100. Handoff goes to Linear comments + pushed branches + PR state, NOT a local file that rots |
| /orchestrate | Workspace command, heddle-aware | **PARITY** | Heddle sessions' SessionStart primer says "Full protocol: run /orchestrate" |
| /quality-gate (local gate run) | /heddle-gate in BOTH heddle repos' `.claude/commands/` | **PARITY** | `.claude/commands/heddle-gate.md` in both repos |
| /research-article | Spinventory content workflow | **SKIP** | Scope: Supabase research-encyclopedia authoring, no heddle analog needed |

## Fleet tooling (bin)

| Spinventory | heddle | Verdict | Notes & receipt |
|---|---|---|---|
| lin.sh | LIN_TEAM=HED support; used daily | **PARITY** | HED-86/HED-88 claims + resolutions 2026-08-16 are attributed "Agent S" via lin.sh |
| pr-sweep.sh | Same script + channels d/e (heddle contribution, benefits both repos' sweeps) | **BETTER** | Channels (d)/(e) sections in any heddle sweep output; documented in docs/REVIEW-SWEEP.md |
| pr-own.sh | Works cross-repo | **PARITY** | PR-OWNER markers on heddle#22 / dashboard#24 (2026-08-16) |
| pr-linear-sync.sh | SYNC_REPO_DIR multi-repo namespace (added 2026-08-15 for HED) | **PARITY** | PR-399/PR-400/PR-401/PR-403 mirror rows moved by the sync on 2026-08-16 |
| runner-scale.sh (paid Fly runner pool) | Public repos → free hosted runners; nothing to scale | **BETTER** | By architecture; docs/CI.md records the free-runner decision |
| import-tester-issues.py + poll (tester sheet → Linear) | No heddle testers yet | **SKIP** | Scope: no external bug-report channel exists. Intake→Linear pattern noted in HED-105 for when one appears |
| heddle-account-share.sh | heddle-native already | **PARITY** | Lives in the workspace `.claude/bin/`, written for heddle account switching |

## Knowledge & session layer (root conventions)

| Spinventory | heddle | Verdict | Notes & receipt |
|---|---|---|---|
| CONTEXT.md entry-point ritual ("Current State", where-things-live) | `/startup` is the session-start read ritual now — but it reads live state rather than a maintained "Current State" doc, on purpose (a status file rots) | **PARITY** | `.claude/commands/startup.md`, landed HED-100. The where-things-live half is CLAUDE.md's rule-loader pointers; the current-state half is deliberately live-sourced, not a doc |
| AGENTS.md Ten Commandments (single reference) | Individual rules cover the commandments — several with harder enforcement (rulesets, hard gates) — but the system is defined as a SINGLE reference doc and heddle has no entry point | **GAP** | HED-100 (consolidation). Enforcement is already ≥ Spinventory per the rows above; the missing piece is the single reference, so the row stays GAP until it exists rather than letting the gate read a known difference as complete |
| _vault/ (37 files: features 26, architecture 10, guides 1) + vault-search.py (semantic+BM25) + auto-reindex + edit-gate | No heddle vault; memtrace search_docs/ask_docs index repo docs/, but no decision archive + no semantic search over decisions; decision archaeology sprawls across Linear/ROADMAP/PR bodies | **GAP** | HED-101. Honest note: even Spinventory's `_vault/decisions/` and `_vault/sessions/` are **empty** — the populated value is features/architecture; steal the working parts, don't cargo-cult the empty ones |
| TESTING.md → _vault/architecture/testing-strategy.md | docs/TESTING-BAR.md in both repos | **PARITY** | `docs/TESTING-BAR.md` present in both repos |
| "Bug fix ⇒ regression test named for it" (forward-only) | **Already implemented**: `skills/quality-gate.md` ("A bug fix REQUIRES a regression test named for it: `describe('regression PR#NNNN — <symptom>')`, forward-only, when vitest-reachable"), attached to every code-editing task class via `routing/routing.v0.yaml` skill packs; docs/TESTING-BAR.md requires naming the regression each test catches | **PARITY** | skills/quality-gate.md:10; routing/routing.v0.yaml (quality-gate in code-editing classes); HED-102 closed as already-satisfied — initially misfiled as a GAP by this audit, caught by codex review on heddle#22 |
| .session/state.md compaction protocol | **Deliberately not ported as a file** — `/closeout` writes the same handoff into Linear + pushed branches + PR state instead. Spinventory's `.session/` is empty in practice, so a state file would have been documentation-ware | **PARITY** | `.claude/commands/closeout.md`, landed HED-100. This is the audit's own "steal the working parts, not the empty dirs" rule applied to itself |
| agent-learnings/ (verify-before-acting learning files) | **Empty in Spinventory — never deployed.** heddle's working equivalents: memtrace recall_decision / fleet_record_episode / fleet episodes + auto-memory | **BETTER** | Worker inventory 2026-08-16: 0 files in Spinventory's agent-learnings/; memtrace fleet/episode tooling is live |
| Reviewer-fleet PATTERNS (canonical freshness "Reviewed <sha>" vs HEAD, per-lens assignment, completeness guards, vetting-runbook bench) | Completeness guards shipped and stronger (HED-88 scanned-volume lower bound + evil-merge red, merged heddle#19 + dashboard#24). Canonical freshness: pr-sweep.sh DR-canonical logic present. Lens assignment + vetting bench: not yet applied to HED-3 adversarial reviews | **GAP** | HED-103 (remaining patterns → HED-3). DR fleet itself stays locked out (Maya 2026-08-15) — patterns only |
| Triage-label depth (Tester Report / Possible Duplicate) | HED Area labels (exclusive) exist; triage depth not needed at current scale | **GAP** | Backlog priority. HED-105 — activate as heddle gains external users |
