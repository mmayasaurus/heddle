import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Deterministic lock for the idle-watchdog exit-race fixes in subprocess.ts (HED-511 B2, ce52763).
//
// The observable effect of those fixes — after a natural exit, the armed idle timer must NOT
// group-SIGKILL the (now-dead) child — cannot be locked with a REAL subprocess: to catch the bug the
// idle timeout has to be < GRACE_MS (otherwise the drain window settles first and finish() clears the
// timer, hiding the buggy behavior), but under full-suite parallel load the parent event loop can be
// starved past a sub-GRACE idle timeout while the child's 'exit' is still pending, so libuv's timers
// phase fires idle before the poll phase observes the exit — a spurious idle-kill on CORRECT code
// (production is immune: the real idle timeout is 300_000ms). That real-subprocess timing therefore
// joins the known contention class; here we drive run()'s timers with FAKE timers and a FAKE child so
// all three fixes are deterministic. A separate file keeps the real-spawn subprocess tests on real spawn.
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

import { run, GRACE_MS } from '../src/adapters/subprocess.js';

// A pid that cannot exist. If a fake child were ever left in the module's liveChildren set and reaped
// at worker exit (after the process.kill spy is restored), the real process.kill(-pid) throws ESRCH and
// killGroupOrChild falls through to the fake's own .kill() — so no real process group is ever signaled.
const IMPOSSIBLE_PID = 2 ** 31 - 1;
const IDLE_MS = 400;
const TIMEOUT_MS = 15_000; // > IDLE_MS + GRACE_MS, so run() enables the idle watchdog.

type FakeStream = EventEmitter & { setEncoding: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };
type FakeChild = EventEmitter & {
  pid: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: ReturnType<typeof vi.fn>;
  unref: ReturnType<typeof vi.fn>;
  stdout: FakeStream;
  stderr: FakeStream;
};

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = IMPOSSIBLE_PID;
  child.exitCode = null;   // mutable: set to mimic libuv observing the OS-level exit
  child.signalCode = null;
  child.kill = vi.fn(() => true);
  child.unref = vi.fn();
  const mkStream = () => {
    const s = new EventEmitter() as FakeStream;
    s.setEncoding = vi.fn();
    s.destroy = vi.fn();
    return s;
  };
  child.stdout = mkStream();
  child.stderr = mkStream();
  return child;
}

describe('idle watchdog timer logic — deterministic lock for the ce52763 exit-race fixes', () => {
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    // Intercept the ONLY process.kill call site run() has (killGroupOrChild's process.kill(-pid)); any
    // call therefore means a group-kill fired. Return true so killGroupOrChild takes the early return.
    killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
    spawnMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('clears the idle timer on a natural exit so no group-kill fires after the child dies (main fix)', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    const p = run('bin', [], '/tmp', TIMEOUT_MS, undefined, undefined, undefined, IDLE_MS);
    child.stdout.emit('data', 'go');   // arms the idle timer (due at +IDLE_MS)
    child.exitCode = 0;
    child.emit('exit', 0, null);       // fix: clears idleTimer, sets childExited, arms the drain
    await vi.advanceTimersByTimeAsync(IDLE_MS + 1);   // idle WOULD fire here if the fix did not clear it
    expect(killSpy).not.toHaveBeenCalled();           // pre-fix: process.kill(-pid,'SIGKILL') group-kills the dead child
    await vi.advanceTimersByTimeAsync(GRACE_MS);       // drain settles at exit + GRACE_MS
    const r = await p;
    expect(r.exitCode).toBe(0);
    expect(r.idleTimedOut).toBe(false);
    expect(r.timedOut).toBe(false);
  });

  it('does not let a post-exit buffered stdout chunk re-arm the idle timer (!childExited reset guard)', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    const p = run('bin', [], '/tmp', TIMEOUT_MS, undefined, undefined, undefined, IDLE_MS);
    child.stdout.emit('data', 'go');
    child.exitCode = 0;
    child.emit('exit', 0, null);
    child.stdout.emit('data', 'late'); // pre-fix: the stdout reset re-arms idle (no !childExited guard)
    await vi.advanceTimersByTimeAsync(IDLE_MS + 1);
    expect(killSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    const r = await p;
    expect(r.exitCode).toBe(0);
    expect(r.idleTimedOut).toBe(false);
  });

  it('does not idle-kill when the OS-level exit precedes the exit event (child.exitCode sub-tick guard)', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    const p = run('bin', [], '/tmp', TIMEOUT_MS, undefined, undefined, undefined, IDLE_MS);
    child.stdout.emit('data', 'go');
    child.exitCode = 0;                // libuv has observed the exit, but the 'exit' EVENT has not fired yet
    await vi.advanceTimersByTimeAsync(IDLE_MS + 1);   // idle fires; fix bails on child.exitCode !== null
    expect(killSpy).not.toHaveBeenCalled();           // pre-fix: no exitCode guard → group-kill fires
    // Now let the deferred 'exit' arrive to settle run() and remove the child from liveChildren.
    child.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    const r = await p;
    expect(r.exitCode).toBe(0);
  });

  // Reset keep-alive regression coverage (the stdout 'data' reset path, from ddd03c0 — not a ce52763
  // fix, so it survives the mutation-revert below; it locks the behavior the relaxed real-subprocess
  // "resets the idle watchdog on each stdout chunk" smoke can no longer assert deterministically).
  it('resets the idle timer on each stdout chunk and fires only once output stops (reset keep-alive)', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    const p = run('bin', [], '/tmp', TIMEOUT_MS, undefined, undefined, undefined, IDLE_MS);
    // Chunks arrive every IDLE_MS/2 — each before the idle deadline — so the timer is reset before it
    // can fire; the child stays alive across four half-budgets (two full idle budgets of wall-time).
    for (let i = 0; i < 4; i += 1) {
      await vi.advanceTimersByTimeAsync(IDLE_MS / 2);
      child.stdout.emit('data', '.');
    }
    expect(killSpy).not.toHaveBeenCalled();            // survived: each chunk re-armed the idle timer
    // Output stops: after one full idle budget of silence the watchdog fires and group-kills the live child.
    await vi.advanceTimersByTimeAsync(IDLE_MS + 1);
    expect(killSpy).toHaveBeenCalledWith(-IMPOSSIBLE_PID, 'SIGKILL');
    await vi.advanceTimersByTimeAsync(GRACE_MS);        // grace net settles the idle kill
    const r = await p;
    expect(r.idleTimedOut).toBe(true);
    expect(r.exitCode).toBeNull();
    child.emit('exit', null, 'SIGKILL');               // late reaper signal — removes the fake from liveChildren
  });
});
