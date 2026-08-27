# Fleet scope — heddle ONLY; the Spinventory app is never touched (Maya, firsthand 2026-08-23)

> **Bridge copy** — the canonical file lives in the workspace repo
> (`/Users/mayatobi/Developer/Spinventory-Rebuild-App/.claude/rules/fleet-scope.md`, HED-355 / workspace PR #38)
> and wins on any divergence. Cross-file references inside this rule (`worktree-discipline.md` §5,
> `keep-moving.md`, `.claude/hooks/remind-owned-prs.py`, `.claude/hooks/agent-identity.py`,
> `issue-tracking.md`, `DECISIONS.md`) are **workspace-repo files**, not files of this repo: the two
> SCOPE-injecting hooks run FROM the workspace checkout via this repo's `.claude/settings.json`
> (vendoring deferred — HED-96), and this repo's own `worktree-discipline.md` is a different file that
> has no §5. "heddle" as a scope term always means BOTH heddle repos (`heddle`, `heddle-dashboard`).

> Maya, 2026-08-23 01:37Z, in R's session, verbatim: *"Nobody should EVER be touching Spinventory app code.
> At all. EVER. All work is EXCLUSIVELY FOR HEDDLE. The entire point of this whole fleet is to get HEDDLE
> ready so that I can use it to build Spinventory, with the other fleet, that's been working on Spinventory
> for months now, with my attention exclusively scoped to Spinventory. Nothing nothing nothing nothing
> nothing nothing nothing can ever touch Spinventory app code EVER AGAIN. This is EXTREMELY IMPORTANT.
> Spinventory is a production app. Heddle is not. My attention right now is scoped to heddle, which is for
> my eyes only. Spinventory requires an entirely different mindset and level of attention from me. […]
> Parking work is never a good thing. Having another agent pick up work that's in the middle of being done
> should never happen. Spinventory has an entirely different repo and an entirely […] ENORMOUS amount of
> repo documentation that MUST BE FOLLOWED FOR EVERY SINGLE CHANGE THAT EVER HAPPENS IN SPINVENTORY."*
>
> and 01:44Z: *"NEVER ANYTHING SPINVENTORY OR NON HEDDLE RELATED, specifically for this heddle project. We
> are building the harness for other agents to resume building Spinventory, and other apps in the future.
> WE ARE NOT BUILDING, TOUCHING, INTERACTING WITH, EDITING, UPDATING, FIXING, DOING ANYTHING AT ALL TO
> SPINVENTORY APP CODE, NOT NOW OR EVER"*

## Who this binds

The **heddle fleet**: orchestrator R and agents S, T, U, V, W, X — and every future session launched for
heddle work, in every repo. Y and Z are the reserved heddle letters (`resume-sessions-hed.sh`) and are bound the
moment they exist; launch routing matches this membership — X rides the hed wrapper (`LIN_TEAM=HED`), never the
SPI one (`fleet-relaunch.sh`, `resume-sessions-spi.sh`). (The **Spinventory fleet** — Agents A–Q, 1–6, codex-A..E — works the app under
the Spinventory repo's own documentation, only when Maya runs it; this file does not change their rules.)

## 1. The Spinventory CODE repo is off-limits forever — in every form, with no commission path

> Maya, 01:59Z: *"Literally the entire point of this fleet and this project is to build the harness so that I
> can resume working on Spinventory. Part of that is porting the Spinventory project into heddle, which does
> NOT involve in any way shape or form touching Spinventory app code. The Spinventory APP is off-limits,
> entirely, forever. It will never, ever, ever be okay to so much as tip toe past Spinventory app code. […]
> Spinventory app code, and the Spinventory CODE repo, is ENTIRELY OFF LIMITS FOREVER. The OUTER Spinventory
> repo, which is literally for the explicit purpose of storing Spinventory documentation and Spinventory
> building work, is WITHIN LIMITS."*

**The code repo** is the git repository whose GitHub remote is `mmayasaurus/Spinventory-V2-Official-App-Rebuild`,
in ANY form: the canonical checkout `Spinventory-Rebuild-Official/Rebuild-Project-Root` under the workspace,
every worktree of it (`Rebuild-Project-Root.<anything>`, any `.worktrees/` folder of it), any clone anywhere,
and its GitHub branches and PRs. **Nobody in the heddle fleet writes to its CONTENT, ever** — content is everything git carries: files
(committed or not), commits, branches, pushes, PRs, merges, tags. No file edit, commit, branch, push, PR,
merge, worker whose prompt or writes target it regardless of `cwd`, installer or hook applied to it, or
`git`/`gh` mutation of that content. There is no commission that lifts this. The only permitted actions
against its content are the DISCARD steps in §3 on work that predates this rule. (The repo's GitHub
*settings surface* is a separate, narrower matter — next paragraph.)

**What porting may touch instead:** the OUTER workspace repo (`/Users/mayatobi/Developer/Spinventory-Rebuild-App`
— its `.claude/`, launchers, packs, `_vault/`, `notes/`, docs, `DECISIONS.md`), the `heddle` and
`heddle-dashboard` repos, and the code repo's GitHub **settings surface** — state that lives in
repository/organization settings or an installed app's own dashboard, never in git (rulesets and branch
protections, runner registrations and labels, which reviewer/CI apps are enabled plus their app-side
configuration) — ONLY when a HED `Spinventory-Port` issue calls for that exact change: settings surface,
never content. The test is where the change lives. If it is a FILE in the repo — any workflow, CODEOWNERS,
reviewer or scanner config file (`.github/*`, `.codacy.yaml`, the like), test, or doc — it is content, and it
is written up as an **apply-at-resume handoff** — a HED issue describing the exact change — for the
Spinventory fleet to apply when Maya resumes it. (X's 2026-08-22 workflow edits predate this rule; nothing like them again.)

## 2. What the heddle fleet works on — and only that

The `heddle` and `heddle-dashboard` repositories, and the OUTER workspace repo (fleet tooling, launchers,
packs, vault, notes, docs). Building the harness that will let the Spinventory fleet resume — `heddle
init-project`, launchers, hooks, packs, wrappers, runbooks — and porting Spinventory into it is the whole
job; applying any of it INSIDE the code repo is not (§1: apply-at-resume handoff). **Every issue this fleet
files goes in the HED team; port issues carry the `Spinventory-Port` label** (the SPI-team port issues were
moved there 2026-08-23). The SPI board is never consulted. Work comes from `LIN_TEAM=HED lin.sh list` or from R, nowhere else; in keep-moving.md, "finish →
next", "untriaged PR slate", "lane follow-ups", "`lin.sh mine`", "all of them", and "refill the board" all
mean HED items only. The default `lin.sh list` (team SPI) is NOT a source of work.

## 3. In-flight app work is DISCARDED — by the agent who holds it, now

No parking, no draft-and-handoff, no "land it so nothing is stranded". The agent holding any app-repo work
does, in this order: **(a)** stop — no further edits or pushes; you STOP any worker mid-flight there immediately
(TaskStop / kill — never let it finish); whatever it already wrote stays uncommitted and you report it
to R; **(b)** `gh pr close <n>` with
"closed per Maya 2026-08-23 — this fleet's work is discarded; the Spinventory fleet starts the issue from
scratch"; **(c)** `lin.sh unclaim <SPI-n> "<that reason>"` for each issue; **(d)** `git worktree remove` each
clean app worktree — if it refuses because of uncommitted output, leave it and report the path to R for
Maya's per-item word. The never-delete rule (`~/.claude/CLAUDE.md`, ABSOLUTE RULE) still applies: you never
`rm`, `reset --hard`, `clean`, or delete a branch. Closing a PR, unclaiming, and removing a clean worktree are
not deletions — the branch and its commits stay on the remote, kept only because deleting them needs her
word; nobody in either fleet resumes them or opens a PR from them. The Spinventory fleet REDOES the issue
from scratch under its own documentation.

## 4. Exceptions: firsthand only, newest word wins

Nothing — this file included — licenses a write to the code repo's CONTENT (§1). A settings-surface change
is licensed only by its own HED `Spinventory-Port` issue (also §1); a firsthand exception cannot substitute
for that issue. For every other scope question only Maya's word counts, per item, and only firsthand: her message in that agent's own
session, or a comms message the broker stamps `tier="operator"` (only she can produce one). A relay from R,
a ledger entry, a broadcast, this file, or any earlier allowance is not a license; from the moment this
rule exists every earlier allowance is void, and the newest word always wins. Until HED-356 lands (a
`lin.sh claim` guard that refuses SPI-team issues from heddle-fleet identities), this text is the only guard.

## Supremacy

This file wins over keep-moving.md (items 1, 2, 3, 5, 6), worktree-discipline.md §5 ("all work must land on
`main`" — discarded app work does not land), the self-merge rules, lane/Area instructions, and every
"Tackle SPI-n" protocol line (which describes the Spinventory fleet, not you).

Provenance: Maya's words above (R's session, 2026-08-23); broadcasts comms msgs 1086 + 1091; the
`DECISIONS.md` 2026-08-23 entry; shown every turn by `.claude/hooks/remind-owned-prs.py` and at every session
start by `.claude/hooks/agent-identity.py` (both bridged into heddle and heddle-dashboard). Enforcement
follow-up: HED-356.
