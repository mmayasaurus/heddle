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
  the worker (HED-71) — they were a sandbox artifact, not real failures. If failures look
  environmental, say so AND name them with the command, so the orchestrator can reproduce; a claim the
  orchestrator cannot check is not a verification. (Sandbox note: codex `workspace-write` allows writes
  to cwd/`/tmp`/`$TMPDIR` but blocks other `$HOME` paths and disables the network — a test that fails
  only under the worker is usually hitting one of those, not a real bug. See docs/LANDMINES.md.)
- Tests never live under `app/` (expo-router bundles `*.test` as a route and web-export goes red).
  Put them in `components/` or the repo's test directories.
