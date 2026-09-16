# Native fleet client verification

HED-688 / PR #254 added shared MCP configuration. HED-690 adds native launch/resume,
turn-boundary inbox hooks, rule translation, and native Gemini CLI/OpenCode worker dispatch.
Claude's existing launchers, account selection, channel push, and hook scripts are unchanged.
The existing `gemini` worker route still uses Antigravity; `gemini-cli` selects Google's CLI.

## Installed macOS clients — 2026-09-15

| CLI | Evidence |
| --- | --- |
| Codex 0.147.0 | A signed-in model completed a real Heddle MCP identity/inbox/orchestration check and posted the expected reply, verified in the broker. `gpt-5.6-luna` passed a basic generation probe but subsequently reported capacity; the MCP check used `gpt-5.6-sol`. |
| Cursor 2026.09.10-fd3934a | `composer-2.5` completed the real MCP round trip and broker-confirmed reply. Generated session hooks also delivered the fixture inbox context. Headless MCP requires both `--approve-mcps` and `--force`; interactive sessions retain native approval controls. |
| Gemini CLI 0.35.3 | Installed native MCP transport connects/pings both servers. Native process invocation reports no configured authentication method. A signed-in model round trip requires completing Gemini's own Google login; Antigravity credentials are separate. |
| OpenCode 1.14.41 | `opencode/nemotron-3-ultra-free` completed a real model turn, Heddle MCP identity/inbox/orchestration calls, and broker-confirmed reply with the generated native plugin installed. |

The model probes used temporary workspaces and synthetic messages. An initial Cursor probe
exposed that its MCP subprocess did not inherit alternate database paths; generated MCP
configuration now carries explicit Heddle database/project overrides. The corrected run's
reply was verified in the intended isolated broker, rather than inferred from model text.
Codex's `-c` parser treats quoted dotted-key segments literally; generated launch overrides
use bare managed server names and quote only values.

Real delegated workers also completed the identity/message/nested-dispatch probe through
Heddle's dispatcher: Codex `gpt-5.6-terra`, Cursor `composer-2.5`, and OpenCode
`opencode/nemotron-3-ultra-free` each posted the expected marker from its own broker-minted
child address and received a `depth-1` refusal when attempting nested dispatch. The Codex
worker used its normal lean configuration, with explicit MCP definitions and tool approvals.
OpenCode adds schema metadata while loading its config; cleanup preserves those additions
and restores unchanged Heddle MCP entries to the parent identity. Concurrent native workers
that need the same project config are refused until its current worker finishes; separate
worktrees support parallel sessions. Codex workers use per-invocation configuration.

## Automated coverage

The native client tests cover configuration/hook preservation, backups, idempotency,
conflicts, redaction, symlink and write-race checks, and unchanged default Claude initialization.
Real stdio MCP tests cover Claude/native and native/native communication, inbox cursors,
identity binding and worker restrictions. Native hook process tests check per-session inbox
notifications without consuming broker history, rule denials, provider tool-name translation,
and continuation guards. The OpenCode plugin is exercised with a controlled native hook
process, including rejection of tool calls and no continuation after an error or idle event
without normal completion. Launcher tests run an actual child process and check cwd, identity,
exit propagation, resume arguments, and refusal of worker-to-orchestrator escalation.
Sanitized-environment MCP subprocess tests cover all four worker clients, including the
exact shared ledger for nested refusals and no broker creation in uninitialized workspaces.

Native worker adapter tests exercise real synthetic subprocesses: argv, resume, output,
usage normalization, malformed/incomplete/error/truncated output, and environment forwarding.
Routing/billing/review tests retain existing provider policy and treat native Gemini as the
same review family as Antigravity. OpenCode dispatch admits the declared free-model catalog;
a native client login is not permission to bypass Heddle's billing or model-family policy.

## Native controls and delivery boundaries

`heddle launch <client> --dir <worktree> --agent <assigned-id>` installs and launches the
selected native client. `--resume <id|latest>` uses its native continuation mechanism. No
permission-bypass flags are added by the interactive launcher. Codex users review generated
hooks in `/hooks`; each client retains its own MCP/hook trust and login controls.

Hooks use the existing ratified Heddle YAML rule evaluator. They do not translate arbitrary
Claude shell hooks. Inbox notices arrive at supported session/tool/turn boundaries; a normal
turn can continue when a message arrived before it ended. An already idle native terminal is
not forcibly interrupted. Receipts only track hook notifications, separately from Claude's
channel cursor; broker history remains intact, and notification is not proof of reading.
OpenCode's plugin must be enabled (`--pure` disables external plugins).

Cursor CLI's MCP SDK uses a 60-second tool timeout. For longer delegated tasks, use Heddle's
terminal `dispatch` command and collect its result/ledger row before retrying. Codex, Gemini
and OpenCode entries specify a 660-second MCP timeout. Linux scheduler integration is a
separate, nonblocking workstream.

Contracts were checked against the installed executables and official
[Codex hooks](https://developers.openai.com/codex/hooks/),
[Cursor hooks](https://cursor.com/docs/hooks),
[Gemini hook reference](https://geminicli.com/docs/hooks/reference/), and
[OpenCode's versioned plugin API](https://github.com/anomalyco/opencode/blob/v1.14.41/packages/plugin/src/index.ts).
