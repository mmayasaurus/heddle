# Heddle

Heddle is a multi-agent harness for subscription coding CLIs. It gives you a guided machine setup, a reproducible project initializer, policy-driven worker dispatch, safety rules and hooks, skill packs, a durable ledger, and verification tools. You keep control of your project, provider accounts, and issue/PR systems; heddle supplies the coordination and guardrails around delegated work.

## Install and build

Heddle requires Node.js `>=22.12.0`.

```shell
git clone https://github.com/<owner>/heddle.git
cd heddle
npm install
npm run build
node dist/cli.js classes --json
```

The built CLI is `node dist/cli.js` (or `heddle` when installed as a bin). Provider-backed operations also require the relevant provider CLI to be installed and logged in.

## Machine setup

Run the wizard on a new machine or re-run individual steps as your configuration changes:

```shell
heddle setup
heddle setup --only accounts,meters
heddle setup --skip pr-automation
```

The wizard runs these eight steps in order: `accounts`, `model-economy`, `spread`, `meters`, `rules`, `permissions`, `pr-automation`, and `doctor`. A failed step does not prevent later steps from reporting their outcome; `heddle setup` exits 1 when any selected step fails.

| Option | Meaning |
| --- | --- |
| `--only <ids>` | Run only comma-separated step IDs. Cannot be used with `--skip`. |
| `--skip <ids>` | Skip comma-separated step IDs. |
| `--dry-run` | Preview every write step without prompting, logging in, writing, or running the final doctor check. |
| `--answers <file>` | Read a JSON-array answer script for non-interactive runs. |
| `--home <dir>` | Use `<dir>/.heddle` instead of your normal home for wizard-owned configuration. |
| `--target <dir>` | Target repository for the PR-automation step. |
| `--json` | Return the step results as JSON. |

For a safe preview in a disposable home:

```shell
heddle setup --home /tmp/heddle-home --dry-run --json
```

### What each setup step writes

`accounts` guides native logins for Claude, Codex, and Cursor, or environment-repointed/local runtimes. It writes `<home>/.heddle/accounts.json`, an account registry with this top-level shape:

```json
{
  "schemaVersion": 2,
  "accounts": [
    {
      "id": "codex-work",
      "provider": "codex",
      "harness": "codex-cli",
      "credentialRef": "codex:<config-path>",
      "billingClass": "subscription-quota",
      "tier": "T1",
      "codexHome": "<config-path>",
      "loggedIn": true,
      "lastVerified": "<ISO-8601 timestamp>"
    }
  ]
}
```

Account rows may additionally record fences, an overage posture, an environment-repoint endpoint and environment-variable reference, region, or provider-specific credential location. The registry stores references and metadata, not a secret value.

`model-economy` asks for a default model and reasoning effort, an optional premium model/agent set, and whether to pin models per agent. It writes `<home>/.heddle/policy/model-economy.json`:

```json
{
  "version": 1,
  "default": { "model": "<model>", "effort": "<effort>" },
  "premium": { "agents": ["A"], "model": "<model>", "effort": "<effort>" },
  "modelPins": true
}
```

`spread` asks which registered Claude accounts participate, expected concurrent sessions, a per-account cap, and whether to save. It writes `<home>/.heddle/policy/spread.json` only when you choose to save:

```json
{ "strategy": "even-spread", "provider": "claude", "accounts": ["account-id"], "capPerAccount": 1 }
```

`meters` asks whether to show the currently supported native-Claude usage meter for each eligible account. It writes `<home>/.heddle/policy/meters.json`:

```json
{ "version": 1, "accounts": { "account-id": { "meters": true } } }
```

`rules` shows each shipped hook rule, previews catalog fixtures when present, asks whether to include it, and asks whether block rules should enforce. It writes `<home>/.heddle/policy/rules.json` with `schemaVersion: 1` and a `rules` array of `{ "id": "…", "enforce": false }` entries.

`permissions` asks for one of `block`, `ask`, `nudge`, or `off` for every guard category—`file-deletion`, `git-history-rewrite`, `db-destructive`, `disk-level`, `credential-writes`, and `package-removal`—in both `interactive` and `unattended` profiles. An unattended `ask` choice is saved as `block`. It writes `<home>/.heddle/policy/permissions.json`:

```json
{
  "version": 1,
  "activeProfile": "interactive",
  "profiles": {
    "interactive": { "<category>": "ask" },
    "unattended": { "<category>": "block" }
  }
}
```

`pr-automation` applies only when `--target` names a Git repository. It asks you to choose `TS/Node` or `Generic`, detects the default branch, and creates only absent files:

```text
<target>/.github/workflows/deterministic-review.yml
<target>/.github/workflows/gate.yml
<target>/.github/scripts/gitleaks-range-scan.sh
```

The TS/Node gate runs `npm ci`, `npm run typecheck`, `npm test`, and `npm run build`. The Generic gate intentionally contains a failing build-configuration placeholder for you to replace before making that check required. Existing workflow files are left unchanged. The step explains that making checks merge-blocking is a repository ruleset setting, not a file the wizard changes.

`doctor` is the read-only finish gate. It verifies the configured environment after the earlier steps.

## Settings: machine-wide and project-level

Heddle’s home-level state is under `~/.heddle/` (or the alternate `--home` directory used by setup). It is shared by every project on that machine. Important entries include `accounts.json`, `policy/*.json`, `secrets.env`, `projects.json`, `ledger.db`, `comms.db`, and optional `packs/`.

`projects.json` is the registry of project names, workspace roots, agent IDs, team key, room, launcher, and optional repository-aware quality gates. An agent ID may belong to only one registered project; the registry validator rejects duplicates.

Project-level files are generated by `init-project`; they are not imported from a different project. Use an answer script or a preset to reproduce a setup. Cross-machine settings export/import is not implemented. Moving the non-secret parts of `~/.heddle` yourself is the current manual path; do not copy secrets.

## Start a project

Initialize an existing or new directory with a canonical hook set and project registration:

```shell
heddle init-project <your-repo> \
  --canonical <canonical-root> \
  --name <project-name> \
  --team <team-key> \
  --agents A,B \
  --room '#project-room' \
  --launcher <launcher-script>
```

On a first registration, `--team`, `--agents`, `--room`, and `--launcher` are required. `--name` defaults to the target directory basename. `--canonical` can instead come from `HEDDLE_CANONICAL` or `~/.heddle/canonical.json`; one of those sources is required. The canonical root must contain a `hooks/` directory with all six discipline hooks: `agent-identity.py`, `agent-preflight.py`, `remind-owned-prs.py`, `require-memtrace-first.py`, `delegation-nudge.py`, and `require-pr-sweep.py`.

| Option | Meaning |
| --- | --- |
| `--canonical <path>` | Canonical hook root; required unless the environment variable or canonical config supplies it. |
| `--name <name>` | Registry project name. |
| `--team <key>` | Project team key for the first registration. |
| `--agents A,B,…` | Comma-separated agent IDs for the first registration. |
| `--room <room>` | Default room for the first registration. |
| `--launcher <script>` | Launcher recorded for the first registration. |
| `--preset minimal\|standard\|strict` | Select a shipped hook-rule set. |
| `--hook-rules a,b` | Select named rules rather than a preset. |
| `--enforce a,b` | Mark selected block rules as enforced. |
| `--answers <file>` | JSON-array answer script for rule selection. |
| `--enforce-memtrace` | Set this repository’s memtrace marker to enforced. |
| `--dry-run` | Produce an installation plan without writes. |
| `--json` | Return the installation report as JSON. |
| `--show-content` | Include home-level planned content in the report instead of redacting it. |

The preset rule sets are exact:

| Preset | Installed rules |
| --- | --- |
| `minimal` | `no-rm-recursive-force` |
| `standard` | `no-rm-recursive-force`, `no-git-history-rewrite`, `no-git-worktree-discard`, `pr-flow-reminder` |
| `strict` | Standard plus `no-destructive-sql` |

The installer plans and applies these artifacts:

- `<your-repo>/.claude/settings.json`: merged discipline-hook wiring.
- `<your-repo>/.claude/rules/pr-review-sweep.md`, `pr-ownership.md`, and `worktree-discipline.md`: canonical rule bridges, seeded only if absent.
- `<your-repo>/rules/<rule-id>.yaml` and available `rules/tests/<rule-id>.jsonl`: selected hook rules and their fixtures, seeded only if absent.
- `<your-repo>/.mcp.json`: merged MCP-server entries when the bundled template is available.
- `<your-repo>/.memtraceignore`: appended `.worktrees/` and `.memdb*/` entries.
- `<your-repo>/.claude/commands/`: `heddle-gate.md`, `startup.md`, `closeout.md`, `handoff.md`, and `heddle-usage.md`, seeded only if absent.
- `~/.heddle/projects.json`: merged project registration.
- `~/.heddle/memtrace-enforce.json`: per-repository memtrace marker; `--enforce-memtrace` sets it to `true`, otherwise a new marker starts at `false`.

It is deliberately re-runnable. Merged files preserve unrelated configuration; seeded files are not overwritten; an unchanged rerun plans no change. If an input changes between planning and writing, the installer aborts rather than overwrite the newer content—rerun it to make a fresh plan.

To inspect a new-project plan without modifying your normal home:

```shell
heddle init-project /tmp/example-repo \
  --canonical /tmp/canonical \
  --name example-repo --team EXAMPLE --agents A --room '#example' \
  --launcher launch.sh --preset standard --dry-run --json
```

## Safety rules and discipline hooks

The rule catalog contains these rules. All catalog defaults have `enforce: false`; a matching rule reports its action unless you enable enforcement for a block rule.

| Rule | Default mode | Guard |
| --- | --- | --- |
| `no-rm-recursive-force` | block, not enforced | Recursive forced file removal. |
| `no-git-history-rewrite` | block, not enforced | Hard resets, force-pushes, and forced branch deletion. |
| `no-git-worktree-discard` | block, not enforced | Commands that discard uncommitted worktree state. |
| `no-destructive-sql` | block, not enforced | Destructive database DDL and truncation. |
| `pr-flow-reminder` | nudge | Opening a pull request. |

The wired hooks establish identity and preflight checks at session start; remind about owned pull requests on prompt submission; require and record code-discovery activity before relevant reads, searches, commands, or stopping; nudge before edits; and record/enforce the pull-request sweep at the appropriate tool and stop events. Hook-rule evaluation uses the selected project `rules/` catalog through the generated settings wiring.

After initialization, add or change project rules with `heddle rule list`, `heddle rule propose`, `heddle rule ratify`, and `heddle rule test`, or re-run `init-project` with `--hook-rules` and `--enforce`. The installer does not overwrite an existing seeded project rule.

## Skill packs

A skill pack is a Markdown instruction bundle attached to a dispatched worker. Heddle searches `HEDDLE_PACKS`, then `~/.heddle/packs`, then the built-in `skills/` directory; an earlier pack with the same name shadows a later one.

`worker-role` and `worker-hygiene` are mandatory for every delegated worker. The dispatcher also attaches the provider-family pack automatically when available: `family-claude`, `family-codex`, `family-cursor`, or `family-gemini`. A task class supplies task-fit packs; an explicit `--skills` list replaces those defaults but never removes mandatory packs.

The shipped generic packs include `worker-role` (delegated-worker scope), `worker-hygiene` (safe working-tree and verification habits), the four family packs (provider-specific execution guidance), `code-discovery` (repository navigation), and `quality-gate` (repository quality checks). `heddle packs` lists the packs reachable in your current environment.

For Codex, Gemini, and Cursor workers, materialized packs are temporarily added to the target worktree’s `AGENTS.md` and restored after the dispatch. Claude receives its skills through the orchestrator’s agent-definition mechanism.

## Dispatch, routes, reviews, and the ledger

Dispatch chooses a route from `routing/routing.v0.yaml`, materializes the applicable packs, invokes the provider adapter, and writes the outcome to the SQLite ledger. Preview a choice without a worker or ledger row:

```shell
heddle route --class implementation --json
heddle dispatch --class implementation --task "Implement the bounded change" --cwd <your-repo>
```

You can route by class or name a provider/model directly. A direct route without a class requires `--override-reason`. Dispatch supports the flags shown by `heddle dispatch --help`, including skill/MCP overrides, effort, resume, timeout, fallback control, capability grants, account selection, and review lineage.

Task classes encode the purpose and default provider/model policy. Their current roles are:

| Class | When to use it |
| --- | --- |
| `orchestration` | Your own in-session decomposition and integration; it is not dispatchable. |
| `deep-implementation` | Cross-cutting or subtle implementation work. |
| `implementation` | Well-scoped feature work with a clear specification. |
| `second-opinion` | Independent diagnosis or review of a plan or diff. |
| `second-opinion-hard` | An opt-in, harder independent review. |
| `escalate-judgment` | A genuinely hard, bounded judgment task. |
| `bulk-mechanical` | Renames, codemods, boilerplate, and similar volume work. |
| `scaffold` | Fast structural drafts such as files, stubs, and wiring. |
| `research-summarize` | Reading, log triage, and summarization. |
| `documentation` | Documentation and prose based on known facts. |
| `quick-alt-take` | A lower-cost alternate draft or small-diff review. |
| `adversarial-review` | Read-only, pre-PR review with a test-quality lens. |
| `gemini-analysis` | Long-context analysis, cross-checking, and grounded research. |
| `web-research` | Live research that must begin with a grounded search. |

Use `heddle classes --json` for the exact current provider/model, fallback, skill, and editability data. Explicit provider/model routing is supported, but policy can refuse a request—for example, a missing opt-in, an unavailable capability fence, a non-dispatchable class, an invalid direct override, or a worker attempting to dispatch another worker. Refusals are returned with a code and recorded as finished ledger rows rather than silently disappearing.

`adversarial-review` is read-only. Supply `--author-provider` (and optionally `--author-dispatch` and `--diff-base`); the review route selects a different provider family from the author. The author applies any accepted fixes. The ledger retains dispatches, refusals, output, review lineage, and review-pair outcomes. Inspect it with `heddle ledger`, `heddle ledger show <id>`, `heddle workers`, `heddle reviews`, and `heddle review-outcome`.

The MCP server exposes the same core actions to an MCP client, including worker dispatch, dispatch planning, class listing, pack listing, effort classification, result assessment, route resolution, ledger access, account/usage checks, and review recording.

## Verification and health

Run:

```shell
heddle doctor
heddle doctor --provider codex --json
```

Doctor checks configured harness binaries, login state, live catalogs where supported, routing and lane configuration, project and Claude-account registries, comms readiness, installed-artifact drift, and provider-verification freshness. `--provider <name>` runs that provider’s checks plus the global configuration checks. Exit 0 means no failures (warnings and skipped checks may still be present); exit 1 means at least one failure; CLI usage errors exit 2.

The project’s CI gate is behavioral: tests assert observable results rather than merely a toggle changing. The standard commands are:

```shell
npm run typecheck
npm test
npm run build
```

The PR-automation wizard scaffolds deterministic `gate`, Semgrep, and Gitleaks workflows. Their check contexts can be required in a repository ruleset after you have configured the repository’s build job appropriately.

## Remaining CLI commands

Run `heddle --help` for the authoritative syntax. The remaining commands are:

| Command | Purpose |
| --- | --- |
| `classify-effort` | Classify task difficulty for a routing class. |
| `assess` | Assess a worker result as done, needing rework, or needing a human. |
| `projects` | List registered projects and fleets. |
| `accounts list` | List registered Claude, Codex, and Cursor accounts. |
| `accounts verify` | Verify local credential paths and recorded Claude login state. |
| `accounts add` | Add native-login or environment-repoint accounts interactively. |
| `comms init` | Initialize comms storage, operator token, and registered project rooms. |
| `fleet install-hooks`, `fleet hooks-diff` | Install or compare vendored fleet hooks. |
| `fleet install-launchers`, `fleet launchers-diff` | Install or compare vendored fleet launcher wrappers. |
| `fleet install-bin`, `fleet bin-diff` | Install or compare vendored fleet bin tools. |
| `upgrade` | Migrate configuration schemas and restore missing fleet assets without overwriting modified files. |
| `uninstall` | Remove only installed fleet assets still byte-identical to the shipped version; it preserves modified assets. |
| `mode [desktop\|mobile\|away]` | Read or set the local operator mode. |
| `whoami` | Show the bound identity and worker context. |
| `workers` | List in-flight dispatches, optionally limited to old orphans. |
| `ledger`, `ledger show`, `ledger finish`, `ledger sweep`, `ledger report-in-session` | Inspect, close, sweep, or administratively report ledger records. |
| `usage`, `usage --remaining`, `usage poll-claude`, `usage install-poll-launchd` | View totals/headroom, collect Claude usage, or install its local polling job. |
| `top` | Print one disk-only dashboard snapshot. |
| `account pick`, `account seat-weights sync` | Select a healthy Claude account or refresh seat-weight data. |
| `pr own`, `pr sweep`, `pr watch` | Coordinate PR ownership, sweep review channels, or poll PR review/CI state. |
| `rule list\|propose\|ratify\|test` | Manage hook rules. |
| `reviews`, `review-outcome` | Inspect the adversarial-review scoreboard or record accepted findings. |
| `release --standalone <outDir>` | Build a standalone CLI snapshot; it requires a clean checkout at the main-head commit. |

## Documentation index

- [Specification](docs/SPEC.md) — product and behavioral specification.
- [Architecture](docs/ARCHITECTURE.md) — system layers and boundaries.
- [Orchestration](docs/ORCHESTRATION.md) — dispatch mechanics.
- [Models](docs/MODELS.md) — routing, capability, and provider behavior.
- [Provider matrix](docs/PROVIDER-MATRIX.md) — supported provider configuration.
- [Accounts](docs/ACCOUNTS.md) — account registry and account operations.
- [Projects](docs/PROJECTS.md) — project registry and repository-aware gates.
- [Project initialization](docs/INIT-PROJECT.md) — installer contract and generated files.
- [Rules](docs/RULES.md) — hook-rule lifecycle and schema.
- [Comms](docs/COMMS.md) — messaging broker behavior.
- [CI](docs/CI.md) — CI, scanners, and review-sweep behavior.
- [Review sweep](docs/REVIEW-SWEEP.md) — PR review sweep operation.
- [Testing bar](docs/TESTING-BAR.md) — behavioral testing expectations.
- [Usage polling](docs/USAGE-POLL.md) — usage-poll setup and operation.
- [Memtrace freshness](docs/MEMTRACE-FRESHNESS.md) — code-index freshness checks.
- [Fleet hooks](docs/FLEET-HOOKS.md), [fleet launchers](docs/FLEET-LAUNCHERS.md), and [fleet bin tools](docs/FLEET-BIN.md) — installed fleet assets.
- [Landmines](docs/LANDMINES.md) — verified adapter and CLI constraints.
- [Fleet overview](docs/fleet/README.md) and [dashboard](docs/fleet/DASHBOARD.md) — fleet-facing documentation.
