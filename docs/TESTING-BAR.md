# The heddle testing bar — behavioral assertions, not toggle-toggles

> Maya, 2026-08-15: *"does turning the switch on actually turn the function on — not just the toggle."*
> This is the fleet-wide bar for every test in `heddle` and `heddle-dashboard`. The adversarial-review
> task class (HED-3) grades against it; reviewers may block a PR whose tests only prove the toggle toggled.
>
> This copy mirrors `heddle-dashboard/docs/TESTING-BAR.md` (canonical; the worked examples are from the
> dashboard suite). heddle-core equivalents of the same patterns: a subscriptions-only test must assert the
> **child process env** lacks `ANTHROPIC_API_KEY` (not that `buildWorkerEnv` returned an object); an
> opt-in-gate test must assert the worker was **not spawned** (not that an error string matched); a
> materialize/restore test must assert the worktree is **byte-identical** afterwards, including the
> touched-file case (HED-19/HED-56).

## 1. The rubric — grade every test (or tightly related group) one of three ways

| Grade | Definition | Would it fail if the real logic regressed? |
|---|---|---|
| **BEHAVIORAL** | Asserts an outcome the user or a caller would observe (rendered UI, bytes written, a refused call, a persisted row, a process signal), across the paths that matter (happy, edge, failure). | Yes — that is the whole point. |
| **PARTIAL** | Covers a real rule but through a proxy: internal state shape, a helper in isolation, a snapshot, a store map instead of the visible result. Useful, not sufficient. | Sometimes; often passes when the wiring around the helper is wrong. |
| **SUPERFICIAL** | Proves the code does what the code says: a counter increments, a function was called, a mapping table maps, a component "renders without crashing". Documents the implementation; guards nothing. | No — rewrite the implementation wrong and it still passes. |

Target for new code: BEHAVIORAL for anything that enforces a rule or changes what a user sees; PARTIAL only
as scaffolding underneath a behavioral test; SUPERFICIAL never lands as the *only* coverage of a change.

## 2. False-confidence patterns — what "green" hides

1. **Golden strings / snapshots of generated code** — the launch-script snapshots in `agent/inject.rs`
   fail on harmless reformatting and pass on a wrong-but-similar script. Assert the *effect* (the shim
   forwards the quoted path; the hook URL is present; a missing binary produces the notfound URL).
2. **Predicate tests instead of gate tests** — `web/mod.rs` proved `is_production_identifier(".release")`
   is true; it never proved that a production build *refuses* plaintext LAN binding (`lib.rs` /
   `command_core.rs`). Test the gate, not the predicate feeding it.
3. **Mocked collaborator never asserted** — `keepAlive.test.tsx` mocks `ptyKill` and then never checks it
   was called for the evicted session (and only that one). If you mock it, assert on it.
4. **Internal counters as outcomes** — `docTabs.test.ts` asserts `reloadNonce` went 0→1→2; nothing proves
   the document was re-read from disk. Assert what the user gets.
5. **Assertions that pass before the code under test runs** — a fail-closed test that checks
   "no SSH button" while the availability promise is still pending passes even without the `.catch`
   (the default is already `false`). Await the settlement you claim to be testing (see example C).
6. **Happy-path-only** — no test for the refusal, the timeout, the malformed payload, the concurrent
   second process. In heddle the refusals ARE the feature (subscriptions-only, opt-in gates, disabled
   remote provisioning): every guard gets a test that the guarded thing does *not* happen.
7. **"Renders"/"is defined"/"was called once"** with no observable consequence attached.
8. **Tests that can't fail for the stated reason** — read the assertion and ask: which regression makes
   this red? If you can't name one, it's superficial.

## 3. Before → after — three real examples from the dashboard suite

### A. Production plaintext-LAN refusal (`src-tauri/src/web/mod.rs`, `lib.rs`)
*Before (SUPERFICIAL):*
```rust
assert!(is_production_identifier("io.vlinx.vlxterm.release"));
assert!(!is_production_identifier("io.vlinx.vlxterm"));
```
Proves a suffix check. Says nothing about whether a release build can still bind `0.0.0.0` in plaintext.

*After (BEHAVIORAL, HED-50 item 2):* start the headless server path with a production identifier and
`ServeMode::LanHttp`; assert it returns the "only available in dev builds" error **and** nothing is
listening on the LAN port; then the same call with a dev identifier binds. (Today `is_production_identifier`
can never be true for `com.heddle.app` — HED-39 — so this test also documents the gap.)

### B. Keep-alive eviction actually kills the PTY (`src/layout/CenterPane/keepAlive.test.tsx`)
*Before (PARTIAL):* over the live-tab limit, assert the oldest idle tab **unmounts** and a notice is recorded;
`ptyKill` is mocked at the top of the file and never asserted.

*After (BEHAVIORAL):* keep the unmount assertion **and** `expect(ptyKill).toHaveBeenCalledWith("S1")` /
`not.toHaveBeenCalledWith("S2")` — the user-visible promise is "background sessions stay alive; evicted
ones die", and only the kill call proves the second half.

### C. Fail-closed gate on the Connect panel (`src/layout/TitleBar/ConnectRemotePanel.sshGate.test.tsx`)
*Before (looked BEHAVIORAL, was PARTIAL — caught in review of #7):*
```ts
invoke.mockImplementation((cmd) => cmd === "ssh_remote_available" ? Promise.reject(new Error("no backend")) : Promise.resolve([]));
render(<ConnectRemotePanel onClose={vi.fn()} />);
await waitFor(() => expect(invoke).toHaveBeenCalledWith("ssh_remote_available"));
expect(screen.queryByRole("button", { name: "SSH" })).toBeNull(); // already true while pending
```
*After (BEHAVIORAL):* hold the promise, assert while pending, **reject inside `act()` and await it**, then
assert again — a removed `.catch` now surfaces as an unhandled rejection and a default-true gate would
render the SSH button after settlement.

## 4. Checklist for authors and reviewers

- [ ] Name the regression each test would catch (write it in the test name or a one-line comment).
- [ ] Guards get a *negative* test: the guarded action does not happen (no network, no write, no render).
- [ ] Mocked collaborators are asserted (calls, arguments, and *non*-calls where that is the promise).
- [ ] Async: await the settlement you claim to test; never assert into a still-pending promise.
- [ ] Concurrency / second-process / stale-state cases exist where the code has them (migrations, locks, races).
- [ ] No golden strings for generated code unless the string *is* the contract (a wire protocol).
- [ ] Verification claims list exact commands and failing test names, never "N unrelated failures" (HED-71).

## 5. Where this came from
The 2026-08-15 test-quality review of the dashboard suite (HED-50, report attached there): ~60 % behavioral,
~30 % partial, ~10 % superficial. The five highest-value tests to add are tracked in HED-50; the rubric above
is the standing bar for everything after.
