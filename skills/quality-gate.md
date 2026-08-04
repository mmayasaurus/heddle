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
- Tests never live under `app/` (expo-router bundles `*.test` as a route and web-export goes red).
  Put them in `components/` or the repo's test directories.
