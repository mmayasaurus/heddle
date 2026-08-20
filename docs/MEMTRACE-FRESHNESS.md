# Memtrace graph freshness (heddle)

Keeping the fleet's memtrace graph for `repo_id=heddle` current with `origin/main`, and why the
mechanism is a **staleness detector**, not an unattended auto-indexer.

Tickets: **HED-205** (the 220-commit staleness that prompted this — resolved), **HED-233** (this
detector), **HED-234** (proper unattended indexer — blocked), **HED-208** (worktree-overlay hygiene —
sibling in the same memtrace-fleet-health cluster).

## The problem HED-205 exposed

The heddle graph anchored at commit `8c6fdd1` (2026-08-16) and sat ~220 commits behind `origin/main` —
from *before `src/rotate/` existed*. Every `find_symbol` / `find_code` for rotator and recent comms code
came back empty, and agents silently fell back to grep. A manual MCP re-index fixed it (landed at
`ea31787`), but nothing prevents it from rotting again. This detector is that prevention.

## Topology — where the live graph actually lives

There is **one** persistent graph server for the whole fleet:

```
memcore-server --bind 127.0.0.1:50051 \
  --data-dir /Users/mayatobi/Developer/Spinventory-Rebuild-App/Spinventory-Rebuild-Official/Rebuild-Project-Root/.memdb
```

Every `repo_id` (`Rebuild-Project-Root`, `heddle`, `heddle-dashboard`) is stored in **that one server's
data-dir**, reached over the socket. `heddle/.memdb` and `heddle-dashboard/.memdb` are **dead local
dirs** — not the live store. When an MCP tool (or the CLI, when it attaches to `:50051`) queries
`repo_id=heddle`, it reads this server. `index_directory` via MCP writes here — that is the path proven
to update what the fleet reads.

## The sidecar trap — why you cannot just clone Spinventory's refresh script

Spinventory's `.memtrace-refresh.sh` runs, on a launchd timer:

```sh
MEMTRACE_MEMDB_DATA_DIR="$WS/.memdb" memtrace index "$CANON"
```

With `MEMTRACE_MEMDB_DATA_DIR` set, the **CLI spins up its own SIDECAR memcore-server** against that
dir — a throwaway store nobody serves. Its own log says so verbatim:

```
? MemDB local - sidecar memcore-server (data dir: /Users/mayatobi/Developer/Spinventory-Rebuild-App/.memdb)
```

Proof it never reaches the live store: the script's marker records commit `1eb38c8a` (2026-07-21) while
the live `:50051` server holds `Rebuild-Project-Root` at `e910adda` (2026-08-01) — **different commits,
different stores**. (The live store reached `e910adda` by another path — a husky post-merge hook or a
manual MCP index — not this script.) That launchd agent is also currently **unloaded**.

**Consequence:** a shell/launchd job driving `memtrace index` (0.8.63) either sidecars into a store
nobody reads, or would have to open the live `Rebuild-Project-Root/.memdb` *concurrently with the running
`:50051` server* — a corruption risk we will not take. And a launchd shell job **cannot call MCP tools**.
So an unattended shell job cannot safely update the live graph today.

## The mechanism: detect, then re-index by hand

`scripts/memtrace-staleness-check.sh` — read-only, non-destructive:

1. `git fetch origin main` (remote-tracking refs only; no working-tree change).
2. Compare `origin/main` to a **last-indexed marker** (`.memtrace-heddle-indexed-commit`, a gitignored
   local file recording the commit last indexed into the live server).
3. If they differ → **nag loudly** (log line + stderr + a best-effort macOS notification) and exit `1`.
   If equal → exit `0`. Setup error → exit `2`.

It never writes a `.memdb` and never mutates the working tree. Run it ad-hoc, at agent `/startup`, or on
the launchd timer.

### When it nags — the re-index procedure (an agent runs this)

```
# 1. ff the canonical to origin/main if the nag says the checkout is behind:
git -C /Users/mayatobi/Developer/heddle merge --ff-only origin/main

# 2. re-index into the live :50051 store (MCP — agent-driven):
index_directory(path="/Users/mayatobi/Developer/heddle", repo_id="heddle", incremental=true, branch="main")

# 3. record what was indexed so the detector goes quiet:
printf '%s' "$(git -C /Users/mayatobi/Developer/heddle rev-parse origin/main)" \
  > /Users/mayatobi/Developer/heddle/.memtrace-heddle-indexed-commit
```

The marker is bootstrapped to `ea31787` (the commit this detector shipped against). It lives at the
canonical root and is gitignored — it is machine-local runtime state, not tracked source.

## Installing the launchd timer — Maya's call

`scripts/com.heddle.memtrace-staleness.plist` is a **template, deliberately not loaded**. Installing it
touches the machine's launchd and sits beside a still-pending decision about the shared memtrace
data-dir (see the `reference_memtrace_dashboard_runtime` memory), so the install step is Maya's
firsthand:

```sh
cp scripts/com.heddle.memtrace-staleness.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.heddle.memtrace-staleness.plist   # unload to disable
```

Even installed, it only *detects* — the re-index above is still agent-driven.

## The proper unattended fix (HED-234, blocked)

A truly hands-off refresh needs the CLI to index **into the live `:50051` server** without a sidecar and
without a second writer on its data-dir. That likely requires the pending **memtrace 0.8.63 → 1.1.5**
upgrade (a server-connect index mode) — and the upgrade itself is Maya's call (`do NOT run memtrace
install casually`). Until both land, this detector + the manual MCP re-index is the mechanism.
