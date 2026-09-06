# The heddle testing bar — behavioral assertions, not toggle-toggles

> operator, 2026-08-15: *"does turning the switch on actually turn the function on — not just the toggle."*
> This is the fleet-wide bar for every test in `heddle` and `heddle-dashboard`. The adversarial-review
> task class (HED-3) grades against it; reviewers may block a PR whose tests only prove the toggle toggled.
>
> This copy mirrors `heddle-dashboard/docs/TESTING-BAR.md` (canonical). **The file paths and worked
> examples below refer to the heddle-dashboard repository** (`src-tauri/…`, `src/…`), not to this repo.
> heddle-core equivalents of the same patterns: a subscriptions-only test must assert the **child process
> env** lacks `ANTHROPIC_API_KEY` (not that `buildWorkerEnv` returned an object); an opt-in-gate test must
> assert the worker was **not spawned** (not that an error string matched); a materialize/restore test must
> assert the worktree file heddle wrote is restored **byte-for-byte** afterwards, including the touched-file
> case (HED-19/HED-56) — exact restoration is the contract there, not a normalized comparison.

## 1. The rubric — grade every test (or tightly related group) one of three ways

| Grade | Definition | Would it fail if the real logic regressed? |
|---|---|---|
| **BEHAVIORAL** | Asserts an outcome the user or a caller would observe (rendered UI, bytes written, a refused call, a persisted row, a process signal), across the paths that matter (happy, edge, failure). | Yes — that is the whole point. |
| **PARTIAL** | Covers a real rule but through a proxy: internal state shape, a helper in isolation, a snapshot, a store map instead of the visible result. Useful, not sufficient. | Sometimes; often passes when the wiring around the helper is wrong. |
| **SUPERFICIAL** | Proves the code does what the code says: a counter increments, an internal function was called (call-count only, no contract arguments, no meaningful non-call), a mapping table maps, a component "renders without crashing". Documents the implementation; guards nothing. | No — rewrite the implementation wrong and it still passes. |

Boundary calls are different: when a mock stands in for the outside world (persistence, network, a process
signal), asserting the call **with its contract arguments** — and asserting the meaningful *non*-calls — is a
behavioral assertion, because that call *is* the observable outcome. "Was called once" with no arguments
checked is not.

Target for new code: BEHAVIORAL for anything that enforces a rule or changes what a user sees; PARTIAL only
as scaffolding underneath a behavioral test; SUPERFICIAL never lands as the *only* coverage of a change.

## 2. False-confidence patterns — what "green" hides

1. **Golden strings / snapshots of generated code** — the launch-script snapshots in
   `src-tauri/src/agent/inject.rs` fail on harmless reformatting and pass on a wrong-but-similar script.
   Substring checks ("the hook URL is present") are only partial scaffolding — they pass when malformed
   control flow never launches anything. The behavioral version *executes* the generated script against a
   fake binary/endpoint and asserts what arrived: `src-tauri/src/agent/spawn_cli.rs::user_cli_forwards_one_quoted_project_path`
   already does exactly this (writes the shim, runs it, asserts the forwarded argv).
2. **Predicate tests instead of gate tests** — `src-tauri/src/web/mod.rs` proved
   `is_production_identifier(".release")` is true; it never proved that a production build *refuses* plaintext
   LAN binding (`src-tauri/src/lib.rs` / `src-tauri/src/command_core.rs`). Test the gate, not the predicate.
3. **Mocked collaborator never asserted** — `src/layout/CenterPane/keepAlive.test.tsx` mocks the PTY
   teardown/kill IPC and then never checks it fired for the evicted session (and only that one). If you mock
   it, assert on it.
4. **Internal counters as outcomes** — `src/store/docTabs.test.ts` asserts `reloadNonce` went 0→1→2;
   nothing proves the document was re-read from disk. Assert what the user gets.
5. **Assertions that pass before the code under test runs** — a fail-closed test that checks
   "no SSH button" while the availability promise is still pending passes even without the `.catch`
   (the default is already `false`). Await the settlement you claim to be testing (see example C).
6. **Happy-path-only** — no test for the refusal, the timeout, the malformed payload, the concurrent
   second process. In heddle, the refusals ARE the feature (subscriptions-only, opt-in gates, the SSH-remote
   provisioning gate introduced in dashboard #7): every guard gets a test that the guarded thing does *not*
   happen.
7. **"Renders"/"is defined"/"was called once"** with no observable consequence attached.
8. **Tests that can't fail for the stated reason** — read the assertion and ask: which regression makes
   this red? If you can't name one, it's superficial.
9. **A green suite that never asked whether the property could be false** — T's line, earned on
   heddle#39: *"the useful habit is asking what a passing test would look like if the property were
   false — not whether the suite is green."* All three real security defects there (fail-open
   redaction, an escaped-form scrubber dodge, an env-inheritance leak) were invisible to a passing
   suite; reviewers caught every one and the tests caught none. For any guard, write down what the
   world looks like when the guard is broken, then name the test that goes red in that world. If you
   cannot name it, the property is unverified no matter how green the run is.
10. **A harness that invokes the thing differently from production** — a local test rig must invoke the
    code under test EXACTLY as CI does, byte for byte; otherwise its green is testing a different program.
    Measured case (HED-113, 2026-08-17): the gitleaks-guard fixture rig ran the script as `sh -e <script>`,
    supplying the very `-e` flag that the extraction had silently dropped — so 12/12 passed green while the
    regression was live in the shipped workflow. The rig now invokes it the way the workflow does.
    Ask of any harness: does it add a flag, an env var, a shell, or a working directory that production
    does not? Each difference is a class of bug the suite cannot see.

## 3. Before → after — three examples from the dashboard suite

"Before" is what the suite has (or had) on `main`; "After" is the rewrite this bar asks for. A and B are
**recommended rewrites, not yet landed** (tracked in HED-50); C **landed with dashboard #7** (HED-38/42),
so its files exist only once that PR is on `main`.

### A. Production plaintext-LAN refusal (`src-tauri/src/web/mod.rs`, `src-tauri/src/lib.rs`) — recommended
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

### B. Keep-alive eviction actually tears the PTY down (`src/layout/CenterPane/keepAlive.test.tsx`) — recommended
*Before (PARTIAL):* over the live-tab limit, assert the oldest idle tab **unmounts** and a notice is recorded;
the PTY IPC is mocked at the top of the file and never asserted.

*After (BEHAVIORAL):* eviction unmounts the terminal, whose `usePtySession` cleanup calls
`ptyTeardownSession(id)` — on desktop that is `pty_kill`, in a browser client a detach that leaves the shared
process alive (`src/ipc/transport.ts::ptyTeardown`). So keep the unmount assertion **and**
`expect(ptyTeardownSession).toHaveBeenCalledWith("S1")` / `expect(ptyTeardownSession).not.toHaveBeenCalledWith("S2")`,
with the environment-specific outcome (kill vs detach) asserted where the test controls `isTauri`. The
user-visible promise is "background sessions stay alive; evicted ones are released" — only the teardown
call, with its argument and its non-call, proves the second half. (Explicit user close is the separate
`closeLiveTab` → `ptyKill` path.)

### C. Fail-closed gate on the Connect panel (`src/layout/TitleBar/ConnectRemotePanel.sshGate.test.tsx`) — landed in dashboard #7
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
- [ ] Global resources (ports, temp files, env vars, on-disk state) are isolated per test and cleaned up, so
      the suite is stable and order-independent (`tempfile::tempdir()`, unique ports, no shared `~/…` writes).
- [ ] No golden strings for generated code unless the string *is* the contract (a wire protocol).
- [ ] Verification claims list exact commands and failing test names, never "N unrelated failures" (HED-71).

## 5. Where this came from
The 2026-08-15 test-quality review of the dashboard suite (HED-50, report attached there): ~60 % behavioral,
~30 % partial, ~10 % superficial. The five highest-value tests to add are tracked in HED-50; the rubric above
is the standing bar for everything after.
