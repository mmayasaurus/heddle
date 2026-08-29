# Rules engine

The `heddle-hook` command evaluates YAML rules as data for Claude Code hook events. It is fail-open: a bad rule, unreadable directory, malformed hook payload, or internal hook error produces `{}` on stdout and exits zero. A broken rules engine therefore cannot halt a hook host.

## Rule schema

| Field | Meaning |
| --- | --- |
| `id` | Required kebab-case identifier. It must equal the YAML filename stem. |
| `event` | `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, or `SubagentStop`. |
| `match` | Optional matchers; an empty object matches every payload for the event. |
| `action` | `nudge`, `inject`, or `block`. |
| `enforce` | Defaults to `false`. Only an enforced block can deny a tool action. |
| `subagent_aware` | Defaults to `false`; such rules skip subagent contexts. |
| `message` | Context text, supporting `{{tool_name}}`, `{{cwd}}`, `{{agent}}`, and `{{rule}}`. |
| `fail_open` | Required literal `true`; a rule cannot request fail-closed behavior. |
| `since` | Optional ISO date. |
| `provenance` | Optional source or rationale. |

## Matchers

`match.tool` is an exact `tool_name` string or list. `match.input` maps tool-input keys to JavaScript regex strings; every regex must match the string form of its input. `match.cwd` is an absolute path prefix or list, compared on path-segment boundaries. `match.agent_role` is `orchestrator`, `worker`, or `any` (the default). All supplied matchers are combined with AND.

## Rendering

Context rules render the production hook shape: `hookSpecificOutput.hookEventName`, `additionalContext`, and a `systemMessage` naming matching rule IDs. Context messages join with newlines. A non-enforced `block` is context only, prefixed `(would block) `.

An `action: block` rule is permitted only for `PreToolUse` in v1, and only `enforce: true` renders `permissionDecision: "deny"`. It never emits an allow decision. Other events are deferred pending a doc-verified stdout contract; this includes `SessionStart`, which cannot block.

## Proposed rules stay inert

The loader reads only direct `*.yaml` files in its rules directory and deliberately does not recurse. In particular, `rules/proposed/` is ignored: an un-ratified proposed rule can never be evaluated.

## Lifecycle (heddle rule …) — TODO PR2
