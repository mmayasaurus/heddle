# Native platform support

Use Heddle's Node entry points on macOS, Linux, or native Windows. WSL uses the Linux path. Node 22.12
or newer and Git are required; install and sign in to each selected provider CLI separately. Heddle
does not copy a login from another operating system or bypass a client's workspace trust controls.

```text
npm ci
npm run build
node dist/cli.js init-client /path/to/agent-worktree --clients codex,cursor,opencode,gemini --agent YOUR_ASSIGNED_ID
```

On Windows, supply a Windows path such as `C:\Users\you\project`. Each simultaneous fleet agent needs
its own assigned identity and worktree. Restart the selected CLI in that worktree and approve the
generated Heddle MCP servers/hooks using that client's trust controls. Verify `comms_whoami`,
`check_workers`, and `check_inbox` before working. The explicit launcher also binds the worktree:

```text
node dist/cli.js launch codex --dir /path/to/agent-worktree --agent YOUR_ASSIGNED_ID
node dist/cli.js launch cursor --dir /path/to/agent-worktree --agent YOUR_ASSIGNED_ID
node dist/cli.js launch opencode --dir /path/to/agent-worktree --agent YOUR_ASSIGNED_ID
node dist/cli.js launch gemini --dir /path/to/agent-worktree --agent YOUR_ASSIGNED_ID
```

Append `--resume latest` to use the client's native continuation mode. See
[native CLI verification](CLI-CLIENTS-VERIFICATION.md) for client-specific setup and limitations.
The older `fleet/launchers/resume-sessions-v2.sh` opens iTerm/Apple Terminal through AppleScript and
remains a macOS operator utility. The native launcher above is the cross-platform session path;
it does not require those terminals, Homebrew, or AppleScript. The personal fleet notification and
tester-import scripts are also separate macOS operator utilities, not prerequisites for native CLI
sessions, worker dispatch, rules, or MCP communication.

## Windows filesystem and commands

Windows PowerShell 5.1 and a local NTFS volume are required for credential storage. Heddle uses the
Windows SID and ACL APIs to create private files/directories and validate existing ones. POSIX
`chmod` is not used as evidence of Windows confidentiality. SYSTEM and Administrators are trusted
OS principals; other identities cannot access credential files or mutate their parents. The shared
credential lock algorithm still publishes its PID atomically and refuses a live holder.

New Heddle credential directories have private inheritable ACLs. A pre-existing directory selected
for private storage must already be private, and a pre-existing credential file with a permissive
ACL is refused rather than silently repaired. Windows replacement retains the destination's ACL,
so permissive existing files cannot be safely treated like POSIX replacements. Reparse points,
junctions, alternate data streams, device/UNC paths, and ambiguous path aliases are rejected.
Provider login errors and permission errors remain errors; they never become empty credentials.
If Windows reports a partial replacement failure, the destination can be absent. Heddle retains
the private replacement file and reports its generated recovery filename in the destination
directory. Preserve that file for recovery; do not treat the failed write as a completed update.

Heddle launches npm `.cmd` shims through `cross-spawn`, including paths with spaces and literal
arguments. Timeout cleanup uses Windows `taskkill /T` to include children of a shim. Generated native
hooks use a PowerShell invocation whose encoded arguments work with both cmd.exe and PowerShell
outer shells. Credential contents are never included in a helper's command-line arguments or logs.

## Linux scheduling

The optional [systemd user timer](USAGE-POLL.md) schedules the existing Claude usage poller. A running
user manager is required. The timer does not create provider credentials, enable lingering, or replace
native CLI sign-in. A service exiting successfully does not prove a successful authenticated usage
request: check its journal and sidecars. Windows users can invoke `node dist/cli.js usage poll-claude`
directly; the systemd and launchd installers apply only to their respective operating systems.

## Verification boundary

The platform CI workflow runs real filesystem, subprocess, hook, native session, and communication
tests on Ubuntu 24.04, macOS 15, and Windows Server 2025 runners. The existing Ubuntu gate continues
to run the complete suite. Tests requiring POSIX uid/mode/umask semantics are explicitly POSIX-only;
Windows has separate native ACL and lock-concurrency tests.

An isolated Ubuntu 24.04 ARM64 machine additionally ran the systemd user timer against the actual
built CLI, including repeated scheduled execution and a logged-out canary account. It correctly
reported unknown headroom instead of inventing usage. Baseline validation passed 2,322 tests, with
five environment-specific skips. Native runtime integration passed 77 tests, with one Windows-only
skip. Codex 0.154.0, Cursor 2026.09.10-fd3934a, Gemini 0.60.0, and OpenCode 1.18.31 were installed there.
OpenCode connected to both actual MCP servers; Cursor enumerated the communication server's tools;
Codex loaded its project MCP configuration after project trust was set. Gemini's authenticated MCP
startup requires sign-in; no credentials were transferred into the test machine.

Windows-native CI results and the final reviewed commit are recorded in the implementation PR.
These checks do not claim that an unauthenticated test runner performed authenticated model work,
or that every desktop terminal and enterprise ACL policy has been tested.
