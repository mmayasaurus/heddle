# Keeper-less usage polling (`io.heddle.usage-poll-claude`)

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
