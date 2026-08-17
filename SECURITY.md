# Security Policy

## Supported versions

heddle is pre-1.0 and moves forward commit by commit on `main`. Only `main` receives security
fixes; a fix lands there rather than as a patch to an older checkout. If you are running an older
build, updating is the first step.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Use GitHub's private vulnerability reporting: go to the
[Security tab](https://github.com/mmayasaurus/heddle/security) of this repository and choose
*Report a vulnerability*. The report stays private between you and the maintainers until a fix is
published.

A useful report includes the affected commit, your platform and provider CLI versions, what an
attacker gains, and the shortest sequence of steps that reproduces the problem. A proof of concept
helps but is not required.

This repository is the orchestration layer. The desktop dashboard lives in
[heddle-dashboard](https://github.com/mmayasaurus/heddle-dashboard) and has its own policy; that
project is a fork of [VelaTerm](https://github.com/vlinx-io/VelaTerm), so a vulnerability inherited
from upstream — one that reproduces on unmodified VelaTerm — should go to upstream as well.

## What to expect

heddle is maintained by one person alongside other work, so replies here are best effort rather
than a schedule — expect a first response in days rather than hours. If a week passes with no reply,
please add a note to the report rather than assuming it was ignored; that is far more likely to be a
missed notification than a decision. When I do reply I will say whether it is considered a
vulnerability and why, and keep you posted while a fix is prepared. Once a fix ships, the commit or
release notes describe the issue, and I am happy to credit you by the name or handle you prefer.

## Areas worth a closer look

heddle's job is to take instructions from a model and turn them into subprocesses on a developer's
machine, so most of its trust boundaries are in that path:

- **Worker dispatch and subprocess spawning** (`src/dispatch.ts`, `src/adapters/`) — the prompt,
  working directory, model, effort and skill-pack selection all arrive from an orchestrator model
  and end up shaping a provider CLI invocation. Argument construction, quoting, and anything that
  could turn a crafted prompt into an unintended command or an unintended `cwd` are in scope.
- **Environment and credential handling** (`src/env.ts`, the adapters) — provider CLIs authenticate
  through their own config directories (for example `CODEX_HOME` account selection). Anything that
  leaks those credentials into logs, ledger rows, worker output, or another account's session is in
  scope.
- **The MCP server surface** (`src/mcp-server.ts`, `src/mcp.ts`) — every tool is callable by any
  model connected to the server. Missing validation, path traversal through tool arguments, or a
  tool that can be induced to read or write outside its intended scope are in scope.
- **The ledger and usage records** (`src/ledger.ts`, `src/ledger-ps.ts`, `src/usage.ts`) — these are
  written to the developer's home directory and read back by the dashboard. Path handling, and
  anything that lets untrusted worker output corrupt or forge ledger rows, are in scope.
- **Skill packs and the routing table** (`src/skillpacks.ts`, `src/routing.ts`) — these are loaded
  from disk and injected into worker prompts. Loading a pack from an unexpected location, or
  content that escapes its intended role in the prompt, are in scope.
- **Inter-agent messaging** (`src/comms/`) — message bodies cross session boundaries and are
  rendered into other agents' context. Anything that lets one agent forge another's identity or
  tier is in scope.

## Out of scope

A model instructing heddle to do something the developer would not want, when the developer gave
that model the authority to do it, is not a vulnerability in itself — heddle runs the work its
operator asks for. Reports that assume an attacker who already has local access to an unlocked
machine, or who already controls the operator's provider subscriptions, are likewise generally not
treated as vulnerabilities. What *is* in scope is heddle exceeding the authority it was given:
crossing from a prompt into commands, credentials, or files outside the requested sub-task.
