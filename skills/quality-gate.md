Before reporting any code change complete, run the gate from the inner repo
(`Spinventory-Rebuild-Official/Rebuild-Project-Root`, or your worktree):

```
npm run gate        # lint + typecheck (both tsconfigs) + vitest — matches CI
npm run e2e:web     # additionally after UI changes (Playwright web smoke)
```

Rules:
- A bug fix REQUIRES a regression test named for it:
  `describe('regression PR#NNNN — <symptom>')`, forward-only, when vitest-reachable.
- Never bypass CI. No `--admin` merges, no `[skip ci]`, no merging on red or pending.
- Report honestly: what passed, what was only written vs actually run, what is unverified,
  and what could break. "Tests pass" is not "it works" — say which is which.
- When tests FAIL, LIST the failing test names and the EXACT command you ran — never a bare count
  like "N unrelated failures" or "N pre-existing failures." An unnamed count is unverifiable and has
  been WRONG: a worker once reported "7 unrelated failures" that all PASSED on a plain re-run outside
  the worker (HED-71). That re-run proves only that they did NOT reproduce — NOT that they were
  "sandbox artifacts"; their real cause was never identified (a flake, test ordering, leaked state, or
  a different invocation are all still possible). Record such failures as UNEXPLAINED unless you
  reproduce the SAME named command with only the sandbox changed. If failures look environmental, say
  so AND name them with the command, so the orchestrator can reproduce; a claim the orchestrator cannot
  check is not a verification. (Sandbox note: codex `workspace-write` allows writes to cwd/`/tmp`/
  `$TMPDIR` but blocks other `$HOME` paths — `~/.cargo`, `~/.rustup`, `~/.npm`, `~/Library`, and even
  `.git` inside cwd — and disables the network BY DEFAULT (the `net` capability re-enables it). A test
  failing only under the worker MAY be hitting one of those rather than a real bug — but it also may
  not; NAME it with its command so the orchestrator can tell which, don't assume. See docs/LANDMINES.md.)
- Tests never live under `app/` (expo-router bundles `*.test` as a route and web-export goes red).
  Put them in `components/` or the repo's test directories.
