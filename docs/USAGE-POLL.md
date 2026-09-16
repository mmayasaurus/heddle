# Keeper-less usage polling (`io.heddle.usage-poll-claude`)

## Linux: systemd user timer

From a stable Heddle installation after `npm run build`:

```sh
node dist/usage-poll-systemd-bin.js --dry-run
node dist/usage-poll-systemd-bin.js --start-interval 300
```

The first command previews both unit files and the activation commands without writing anything or
contacting systemd. Preview also works on macOS. The second command is Linux-only: it installs
`io.heddle.usage-poll-claude.service` and `.timer` in `$XDG_CONFIG_HOME/systemd/user` (default
`~/.config/systemd/user`), reloads the user manager, enables and restarts the timer, then checks that
the timer is active. `--json` returns the same plan/result as structured data. This standalone entry
point does not change client configuration, the macOS launcher, or the launchd installer below.

The service reuses `usage poll-claude`; it does not implement another poller. It runs shortly after
timer activation, then 300 seconds after each poll finishes by default. The user timer does not start
another copy while its service is running. The installation needs Node, Heddle's built CLI, and a
running systemd user manager. It does not use sudo, install a system service, or enable user lingering.
On systems where the user manager stops at logout, polling stops with it.

The installer pins the resolved Node and CLI paths, home directory, account-registry path, and usage
output directory. `HEDDLE_ACCOUNTS`, `HEDDLE_USAGE_DIR`, and `XDG_CONFIG_HOME` overrides must be absolute
paths. Credentials are read by the existing poller; no credential values are copied into the units.
Run from a stable installation: activation refuses executables under `.worktrees`, including symlinks
into one. Re-run the installer if the installed Node or Heddle path changes.

Both unit files are validated before writing. Unrelated existing units, symlinked files, units loaded
from another location, and systemd drop-ins are refused. Changed Heddle-managed files are backed up
beside the original before replacement. A configured `io.heddle.window-keeper.service` or `.timer`
also blocks installation. This check cannot discover arbitrary cron jobs or custom schedulers: keep
only one producer for the same usage directory. Preview does not verify runtime prerequisites;
activation failures are reported without claiming the timer is active.

Inspect and stop the timer with:

```sh
systemctl --user status io.heddle.usage-poll-claude.timer
journalctl --user -u io.heddle.usage-poll-claude.service
systemctl --user disable --now io.heddle.usage-poll-claude.timer
```

Disabling the timer prevents future polls; it does not cancel a poll already running. A timer being
active does not prove successful authentication or fresh usage data: inspect the service journal and
the sidecars after the first poll. Automated tests cover isolated installation, failure handling, and
preview behavior; the Linux test also runs `systemd-analyze verify` without starting a service. Live
provider login and scheduled polling still need verification on the target Linux machine.

The unit format follows the upstream [systemd service](https://github.com/systemd/systemd/blob/main/man/systemd.service.xml),
[timer](https://github.com/systemd/systemd/blob/main/man/systemd.timer.xml), and
[environment](https://github.com/systemd/systemd/blob/main/man/systemd.exec.xml) documentation.

## macOS: launchd job

On a machine that runs the heddle **window-keeper**, the keeper already polls Claude OAuth usage on a
schedule and writes the per-account `claude-<id>.oauth-usage.json` sidecars that headless routing and
`account pick` read. A **keeper-less machine** — the headless pack, no dashboard — has no scheduled
producer, so those sidecars go stale and idle-account 5h/7d headroom falls back to tap-only/stale data.

`heddle usage install-poll-launchd` installs a standalone launchd job that fills that gap:

```
heddle usage install-poll-launchd [--start-interval <secs>] [--dry-run] [--json]
```

It writes `~/Library/LaunchAgents/io.heddle.usage-poll-claude.plist` and (bootout/bootstrap) loads a
job that runs `heddle usage poll-claude` every 300 seconds (override with `--start-interval`). That
command polls **all** registry accounts and atomically writes each `claude-<id>.oauth-usage.json`.

If `HEDDLE_USAGE_DIR` or `HEDDLE_ACCOUNTS` is set in the installing shell, the installer bakes it into
the plist's `EnvironmentVariables` so the scheduled job reads the same registry and writes the same
sidecar directory the rest of heddle uses — launchd otherwise runs with a minimal environment and
would silently fall back to the defaults.

## Self-resolving invocation

The producer plist invokes the CLI as an **explicit** `node <dist/cli.js>` — launchd's PATH has no
node, and `dist/cli.js`'s `#!/usr/bin/env -S node` shebang can't find one. The installer resolves both
from the running process (`process.execPath` for node, its own sibling `dist/cli.js` for the entry
point), so there is no fnm-alias guessing and no "run from the main checkout" fragility. This is why
the headless producer can self-resolve where the dashboard window-keeper had to bake an explicit
`HEDDLE_BIN` into its plist at install time.

## One producer per machine (either/or with the keeper)

Exactly one scheduler may write the usage sidecars. `install-poll-launchd` **refuses** (exit 1) when
`io.heddle.window-keeper` is already loaded — on a keeper-equipped machine the keeper is the producer.
The keeper installer carries the reciprocal guard (it refuses if this producer is already loaded), so
the either/or holds regardless of install order (HED-552).

## Activation is a manual step

Running the command is the activation: it loads the job immediately. Nothing loads it silently. Use
`--dry-run` to preview the plist action (`would-create` / `would-update` / `would-skip`) without
writing or loading anything.

## Troubleshooting

If polling silently stops after a Node upgrade, re-run `heddle usage install-poll-launchd`. The plist
bakes the absolute path of the Node that was running at install time (`process.execPath`); a version
manager (fnm/nvm) that removes that exact version leaves the job pointing at a now-missing binary — the
poll then errors into `~/.heddle/usage-poll-claude.launchd.err` (no bad data is written). Re-running the
installer re-resolves the current Node and rewrites the plist. This is inherent to launchd's minimal
PATH; the trade-off is shared with the window-keeper's baked `HEDDLE_BIN`.
