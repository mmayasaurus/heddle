# Spinventory → heddle discipline parity (HED-97)

> Audit date 2026-08-16 (Agent S). Source inventory: worker enumeration of the Spinventory
> workspace (`.claude/{hooks,rules,commands,bin}`, settings wiring, root conventions, `_vault/`).
> **Living doc**: as a GAP ticket lands, flip its row to PARITY/BETTER with the receipt.


Bar (Maya, 2026-08-16): heddle must work **as well as or better than** Spinventory's current
system — the rest of Spinventory will be built inside heddle, and nothing may regress at
migration. One row per Spinventory system: heddle equivalent, verdict, receipt. Every **GAP**
row has a ticket. Spinventory keeps running unchanged until every row is PARITY-or-BETTER.

Verdicts: **BETTER** (heddle exceeds it) · **PARITY** (equivalent in effect) ·
**GAP** (missing/weaker — ticketed) · **SKIP** (project-specific, not migration-relevant).

## Hooks (runtime enforcement)

| Spinventory system | heddle equivalent | Verdict | Receipt |
|---|---|---|---|
| agent-identity.py (durable fleet letter at SessionStart) | Same hook, shared: heddle cwds load workspace hooks via each repo's `.claude/settings.json` (workspace commit 11193e8) | **PARITY** | This session's identity primer names Agent S from a heddle cwd |
| require-memtrace-first.py (record-only in Spinventory) | Same hook, **hard gate ON** for heddle roots (`ENFORCEMENT_ROOTS`: heddle=True) | **BETTER** | HED-82; live denial telemetry in ~/.heddle/discipline.jsonl |
| require-pr-sweep.py (3-channel record + enforce-stop) | Same hook + pr-sweep.sh channels **(d) code-scanning alerts, (e) checks** added for heddle | **BETTER** | HED-16; docs/REVIEW-SWEEP.md both repos; sweep output shows (d)/(e) |
| delegation-nudge.py | Same, shared; heddle side adds per-turn dispatch counts + shared-cap % (HED-85 telemetry contract) | **BETTER** | UserPromptSubmit context shows "dispatched N workers / cap %" |
| remind-owned-prs.py + pr-own.sh ownership | Same, shared; works on heddle repos | **PARITY** | pr-sweep.sh prints "Ownership: YOURS (S-ci)" on heddle PRs |
| protect-workspace.py (path guard for _vault/, CONTEXT.md, AGENTS.md…) | Global destructive-command hook covers rm/force-push everywhere, but **no heddle-specific critical-path list** (ROADMAP.md, docs/, .claude/) | **GAP (minor)** | HED-104 |
| require-vault-search.py (knowledge lookup gated before app edits) | No heddle vault → nothing to gate | **GAP** | HED-101 |
| auto-reindex-vault.py | n/a without vault | **GAP** | HED-101 |

## Rules (binding constraints)

| Spinventory | heddle | Verdict | Receipt |
|---|---|---|---|
| pr-review-sweep.md (Commandment #3) | docs/REVIEW-SWEEP.md in BOTH repos + channels d/e + two-sweeps-15-min codified | **BETTER** | HED-16/#10/#13 |
| pr-ownership.md | Shared pr-own.sh + pr-discipline.md references; ownership markers work cross-repo | **PARITY** | Sweep ownership line on heddle PRs |
| issue-tracking.md (SPI) | Per-repo issue-tracking.md, LIN_TEAM=HED, exclusive Area labels | **PARITY** | Both repos' .claude/rules/ |
| worktree-discipline.md (sibling-dir era) | Per-repo worktree-discipline.md: **in-repo .worktrees/, recycle-don't-mint, standing removal auth** (Maya 2026-08-15) | **BETTER** | Both repos' .claude/rules/worktree-discipline.md |
| heddle-self-merge.md | heddle-native (written for HED) + config-text exception with same-breath overlap measurement | **BETTER** | Exercised on #18/#22 merges 2026-08-16 |
| serena.md | Per-repo memtrace-serena.md (memtrace-first + Serena complement + worktree overlays) | **PARITY** | Both repos' .claude/rules/ |
| No-squash / merge-commit-only (AGENTS.md Commandment 1) | **Server-enforced**: protect-main rulesets (heddle 20912747 / dashboard 20912748) — PR-only, merge-commit-only, thread resolution required, no force-push, no bypass | **BETTER** | Rulesets applied 2026-08-16 (HED-13) |
| sleek/social style guides (stub→command pattern) | No heddle UI style guide yet; dashboard UI work is growing | **SKIP now / ADAPT-PATTERN later** | Note only — content is Spinventory-specific; the stub→on-demand-command pattern is the stealable part |
| argent.md stub | Global rule loads everywhere already | **SKIP** | Project-specific |

## Commands (workflows)

| Spinventory | heddle | Verdict | Receipt |
|---|---|---|---|
| /startup (daily briefing ritual) | **None for heddle cwds** (commands are per-project; workspace /startup invisible from heddle repos) | **GAP** | HED-100 |
| /closeout (handoff, commit+push-everything, state.md) | **None** — heddle agents have no session-end discipline | **GAP** | HED-100 |
| /orchestrate | Workspace command, heddle-aware (referenced by heddle session primer) | **PARITY** | SessionStart primer says "Full protocol: run /orchestrate" |
| /quality-gate (local gate run) | /heddle-gate in BOTH heddle repos' .claude/commands/ | **PARITY** | ls receipts 2026-08-16 |
| /research-article | Spinventory content workflow | **SKIP** | — |

## Fleet tooling (bin)

| Spinventory | heddle | Verdict | Receipt |
|---|---|---|---|
| lin.sh | LIN_TEAM=HED support; used daily | **PARITY** | HED-86/88 claims/resolves this session |
| pr-sweep.sh | Same script + channels d/e (heddle contribution, benefits both) | **BETTER** | — |
| pr-own.sh | Works cross-repo | **PARITY** | — |
| pr-linear-sync.sh | SYNC_REPO_DIR multi-repo namespace (added 2026-08-15 for HED) | **PARITY** | PR-400/PR-399 moved to Done this session |
| runner-scale.sh (paid Fly runner pool) | Public repos → free hosted runners; nothing to scale | **BETTER (by architecture)** | docs/CI.md |
| import-tester-issues.py + poll (tester sheet → Linear) | No heddle testers yet | **SKIP now / ADAPT-PATTERN later** | Note the intake→Linear pattern for when heddle has external users |
| heddle-account-share.sh | heddle-native already | **PARITY** | — |

## Knowledge & session layer (root conventions)

| Spinventory | heddle | Verdict | Receipt |
|---|---|---|---|
| CONTEXT.md entry-point ritual ("Current State", where-things-live) | CLAUDE.md (rule loader) + ROADMAP.md exist, but **no living current-state doc + no session-start read ritual** | **GAP** | HED-100 |
| AGENTS.md Ten Commandments (single reference) | Individual rules cover the commandments — several with harder enforcement (rulesets, hard gates) — but no single entry-point | **PARITY in effect** (enforcement ≥; consolidation folded into HED-100) | Rules inventory above |
| _vault/ (37 files: features 26, architecture 10, guides 1) + vault-search.py (semantic+BM25) + auto-reindex + edit-gate | **No heddle vault**; memtrace search_docs/ask_docs index repo docs/, but no decision archive + no semantic search over decisions; decision archaeology sprawls across Linear/ROADMAP/PR bodies (R's observation) | **GAP** | HED-101. Honest note: even Spinventory's `_vault/decisions/` and `_vault/sessions/` are **empty** — the populated value is features/architecture; the decisions layer is aspirational THERE too. Steal the working parts, don't cargo-cult the empty ones |
| TESTING.md → _vault/architecture/testing-strategy.md | docs/TESTING-BAR.md in both repos | **PARITY** | ls receipts |
| "Bug fix ⇒ regression test named for it" (forward-only) | Not in TESTING-BAR yet | **GAP (small)** | HED-102 |
| .session/state.md compaction protocol | Not deployed for heddle. Honest note: Spinventory's .session/ is **empty** — protocol documented globally, artifacts unused | **GAP** | HED-100 |
| agent-learnings/ (verify-before-acting learning files) | **Empty in Spinventory — never deployed.** heddle's working equivalents: memtrace recall_decision / fleet_record_episode / fleet episodes + auto-memory | **BETTER (heddle's is real, Spinventory's is vaporware)** | Worker inventory 2026-08-16: 0 files |
| Reviewer-fleet PATTERNS (canonical freshness "Reviewed <sha>" vs HEAD, per-lens assignment, completeness guards, vetting-runbook bench) | Completeness guards: **shipped and stronger** (HED-88 scanned-volume lower bound + evil-merge red). Canonical freshness: pr-sweep.sh DR-canonical logic present. Lens assignment + vetting bench: not yet applied to HED-3 adversarial reviews | **PARTIAL → GAP (HED-103)** | DR fleet itself stays locked out (Maya 8-15) — patterns only |
| Triage-label depth (Tester Report / Possible Duplicate) | HED Area labels (exclusive) exist; triage depth not needed at current scale | **GAP (backlog-priority)** | HED-105 |
