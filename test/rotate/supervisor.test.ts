import { describe, it, expect, beforeEach } from 'vitest';
import { tick, type RotatorDeps, type RotationIntent } from '../../src/rotate/supervisor.js';
import type { RotateAction } from '../../src/rotate/decide.js';
import type { PauseReadiness } from '../../src/comms/quiesce.js';
import type { ClaudeAccount } from '../../src/capaware.js';

/**
 * Rotator supervisor (HED-117). The whole point is that the KILL is irreversible, so the tests are
 * weighted to: (1) the kill never happens before readiness; (2) a re-entrant tick after a crash
 * relaunches only what is still un-moved — never re-killing a moved session; (3) any relaunch
 * failure stops and surfaces a half-rotated fleet, never retries blindly.
 */
describe('rotator supervisor tick', () => {
  const acct = (id: string, configDir: string | null): ClaudeAccount => ({ id, configDir, loggedIn: true });

  // A mutable fake world the injected deps read and mutate, plus recorders for the irreversible ops.
  class World {
    pauseId: number | null = null;
    intent: RotationIntent | null = null;
    ready = false;
    readinessLive: string[] = [];
    blockers: string[] = [];
    live: string[] = [];
    relaunched_set = new Set<string>();  // addresses whose live session has BOOTED (isRelaunched)
    marks = new Set<string>();           // addresses with a durable relaunch marker (wasRelaunched)
    decision: RotateAction = { action: 'idle', current: 'acct1', usedPct: 10, reason: 'idle' };
    relaunchOk: (address: string) => { ok: boolean; code: string } = () => ({ ok: true, code: 'launched' });
    killOk: (address: string) => { ok: boolean; code: string } = () => ({ ok: true, code: 'killed' });
    verifyTimedOut = false;         // HED-157: VERIFY boot-timeout — false = still within the window
    verifyTimeoutMsVal = 300_000;
    quiesceTimedOut = false;        // HED-186: PRE-KILL quiesce timeout — false = still within the window
    quiesceTimeoutMsVal = 1_200_000;
    abortCooldown = false;          // HED-200: is a recent abort still inside its cooldown window?
    // recorders
    killed: string[] = [];
    relaunched: { address: string; account: string }[] = [];
    needsHumanMsgs: string[] = [];
    paused: { reason: string; intent: RotationIntent }[] = [];
    resumed: string[] = [];
    abortsRecorded: string[] = [];  // HED-200: targets stamped with a durable abort marker
    ops: string[] = [];  // call order across resumePause/needsHuman/recordAbort (the abort path escalates, lifts, THEN stamps)
  }

  const readinessOf = (w: World): PauseReadiness => ({
    pauseId: w.pauseId, requestedAt: w.pauseId ? 'ts' : null, resumedAt: null, reason: null,
    live: w.readinessLive, acked: [], pending: [], notParked: [], restarted: [], joinedAfterPause: [],
    inFlightDispatches: 0, ledgerConsulted: true, ready: w.ready, blockers: w.blockers,
  });

  const deps = (w: World): RotatorDeps => ({
    decide: () => w.decision,
    readiness: () => readinessOf(w),
    pauseIntent: () => w.intent,
    liveAddresses: () => [...w.live],
    isRelaunched: (a) => w.relaunched_set.has(a),
    markRelaunched: async (a) => { w.marks.add(a); },
    wasRelaunched: (a) => w.marks.has(a),
    verifyTimeout: () => ({ timedOut: w.verifyTimedOut, timeoutMs: w.verifyTimeoutMsVal }),
    quiesceTimeout: () => ({ timedOut: w.quiesceTimedOut, timeoutMs: w.quiesceTimeoutMsVal }),
    requestPause: async (reason, intent) => { w.paused.push({ reason, intent }); w.pauseId = 1; w.intent = intent; },
    resumePause: async (reason) => { w.ops.push('resumePause'); w.resumed.push(reason); w.pauseId = null; w.intent = null; },
    killSession: async (a) => { w.killed.push(a); const r = w.killOk(a); if (r.ok) { w.live = w.live.filter((x) => x !== a); w.relaunched_set.delete(a); } return r; },
    relaunch: async (a, account) => {
      const r = w.relaunchOk(a);
      w.relaunched.push({ address: a, account });
      if (r.ok) { w.live.push(a); w.relaunched_set.add(a); }
      return r;
    },
    recordAbort: async (t) => { w.ops.push('recordAbort'); w.abortsRecorded.push(t); },
    abortCooldownActive: () => w.abortCooldown,
    needsHuman: async (m) => { w.ops.push('needsHuman'); w.needsHumanMsgs.push(m); },
  });

  /** A world with a fleet of `addrs` all live on the source account and NO pause in force. */
  const fleetOn = (_source: string, ...addrs: string[]): World => {
    const w = new World();
    w.live = [...addrs];        // all live on the old (source) session; none relaunched yet
    return w;
  };

  const rotateDecision = (from: string, target: ClaudeAccount, usedPct = 92): RotateAction => ({
    action: 'rotate', current: from, usedPct, target,
    targetEnv: { env: target.configDir ? { CLAUDE_CONFIG_DIR: target.configDir } : {}, envUnset: target.configDir ? [] : ['CLAUDE_CONFIG_DIR'] },
    reason: `rotate ${from} → ${target.id}`,
  });

  let w: World;
  beforeEach(() => { w = fleetOn('acct1', 'R', 'S', 'V'); });

  it('WATCH: idle decision requests no pause and kills nothing', async () => {
    w.decision = { action: 'idle', current: 'acct1', usedPct: 20, reason: 'low' };
    const step = await tick(deps(w));
    expect(step.phase).toBe('idle');
    expect(w.paused).toHaveLength(0);
    expect(w.killed).toEqual([]);
  });

  it('WATCH: exhausted decision posts a needs-human and does not pause', async () => {
    w.decision = { action: 'exhausted', current: 'acct1', usedPct: 95, reason: 'all accounts near the cap' };
    const step = await tick(deps(w));
    expect(step.phase).toBe('exhausted');
    expect(w.needsHumanMsgs.join(' ')).toMatch(/no target/);
    expect(w.paused).toHaveLength(0);
  });

  it('WATCH: a rotate decision requests an operator pause stamped with the target AND the roster', async () => {
    w.decision = rotateDecision('acct1', acct('acct2', null));
    const step = await tick(deps(w));
    expect(step.phase).toBe('paused');
    expect(w.paused).toHaveLength(1);
    expect(w.paused[0]?.intent).toMatchObject({ target: 'acct2', from: 'acct1', roster: ['R', 'S', 'V'] });
    expect(w.killed).toEqual([]); // pausing is not killing
  });

  it('QUIESCE: a pause in force but fleet not ready kills NOTHING — waits', async () => {
    w.pauseId = 1;
    w.intent = { target: 'acct2', from: 'acct1', roster: ['R', 'S', 'V'] };
    w.ready = false; w.blockers = ['2 live agent(s) have not acked: S, V'];
    const step = await tick(deps(w));
    expect(step.phase).toBe('quiescing');
    expect(w.killed).toEqual([]);           // the irreversible half never runs before ready
    expect(w.relaunched).toEqual([]);
  });

  it('RELAUNCH: once ready, every roster member on the source is killed then relaunched onto the target', async () => {
    w.pauseId = 1;
    w.intent = { target: 'acct2', from: 'acct1', roster: ['R', 'S', 'V'] };
    w.ready = true;
    const step = await tick(deps(w));
    expect(step.phase).toBe('relaunching');
    expect(w.killed.sort()).toEqual(['R', 'S', 'V']);
    expect(w.relaunched.map((r) => r.address).sort()).toEqual(['R', 'S', 'V']);
    expect(w.relaunched.every((r) => r.account === 'acct2')).toBe(true);
    // each was killed BEFORE it was relaunched (launch-only primitive; supervisor owns the kill)
    for (const r of w.relaunched) expect(w.killed).toContain(r.address);
  });

  it('RELAUNCH failure stops immediately, posts needs-human, and does NOT relaunch the rest', async () => {
    w.pauseId = 1;
    w.intent = { target: 'acct2', from: 'acct1', roster: ['R', 'S', 'V'] };
    w.ready = true;
    w.relaunchOk = (a) => (a === 'S' ? { ok: false, code: 'exit-3' } : { ok: true, code: 'launched' });
    const step = await tick(deps(w));
    expect(step.phase).toBe('blocked');
    expect(w.needsHumanMsgs.join(' ')).toMatch(/half-rotated/);
    // R was moved, S failed → stop. V is never touched (no blind march through a broken fleet).
    expect(w.relaunched.map((r) => r.address)).toEqual(['R', 'S']);
    expect(w.killed).not.toContain('V');
  });

  it('a REFUSED kill (ambiguous pid) stops before relaunch — never two processes on one conversation', async () => {
    w.pauseId = 1;
    w.intent = { target: 'acct2', from: 'acct1', roster: ['R', 'S', 'V'] };
    w.ready = true;
    w.killOk = (a) => (a === 'R' ? { ok: false, code: 'exit-2' } : { ok: true, code: 'killed' });
    const step = await tick(deps(w));
    expect(step.phase).toBe('blocked');
    expect(w.needsHumanMsgs.join(' ')).toMatch(/could NOT kill R/);
    expect(w.relaunched).toEqual([]); // never relaunched over a possibly-live old session
  });

  it('VERIFY: relaunched but not all roster back on target yet → waits, does not resume', async () => {
    w.pauseId = 1;
    w.intent = { target: 'acct2', from: 'acct1', roster: ['R', 'S', 'V'] };
    w.ready = true;
    // R and S came back relaunched; V has not re-registered yet (not live).
    w.live = ['R', 'S']; w.relaunched_set = new Set(['R', 'S']); w.marks = new Set(['R', 'S', 'V']);
    const step = await tick(deps(w));
    expect(step.phase).toBe('verifying');
    expect(w.resumed).toEqual([]);
  });

  it('RESUME: all roster back on the target lifts the pause', async () => {
    w.pauseId = 1;
    w.intent = { target: 'acct2', from: 'acct1', roster: ['R', 'S', 'V'] };
    w.ready = true;
    w.live = ['R', 'S', 'V']; w.relaunched_set = new Set(['R', 'S', 'V']); w.marks = new Set(['R', 'S', 'V']);
    const step = await tick(deps(w));
    expect(step.phase).toBe('resumed');
    expect(w.resumed).toHaveLength(1);
    expect(w.pauseId).toBeNull(); // lifted
  });

  it('RE-ENTRANCY: a tick after a partial relaunch only moves the STILL-un-moved members — no re-kill', async () => {
    // Simulate a crash mid-rotation: R was already killed+relaunched onto acct2 last run; S and V
    // are still on the source. The roster in the pause meta is the source of truth.
    w.pauseId = 1;
    w.intent = { target: 'acct2', from: 'acct1', roster: ['R', 'S', 'V'] };
    w.ready = true;
    w.live = ['R', 'S', 'V'];
    w.relaunched_set = new Set(['R']); w.marks = new Set(['R']); // R done; S,V still un-relaunched
    const step = await tick(deps(w));
    expect(step.phase).toBe('relaunching');
    expect(w.killed.sort()).toEqual(['S', 'V']);   // R is NOT re-killed
    expect(w.relaunched.map((r) => r.address).sort()).toEqual(['S', 'V']);
  });


  it('CRASH GAP: a member killed but not yet marked is RE-relaunched, not deadlocked in verify', async () => {
    // Simulate a crash between kill and relaunch of R: R was killed (not live, no mark); S,V are
    // still the old sessions. Without markers this would deadlock — VERIFY would wait forever for R
    // to boot, but nothing ever relaunched it.
    w.pauseId = 1;
    w.intent = { target: 'acct2', from: 'acct1', roster: ['R', 'S', 'V'] };
    w.ready = true;
    w.live = ['S', 'V'];          // R was killed in the crashed tick
    w.marks = new Set<string>();  // …but never marked relaunched
    const step = await tick(deps(w));
    expect(step.phase).toBe('relaunching');
    // All three (incl. the killed-but-unmarked R) are relaunched — R is recovered, not stranded.
    expect(w.relaunched.map((r) => r.address).sort()).toEqual(['R', 'S', 'V']);
    expect(w.marks.has('R')).toBe(true);
  });

  it('a MARKED member still booting is NOT re-launched (no duplicate) — verify just waits', async () => {
    w.pauseId = 1;
    w.intent = { target: 'acct2', from: 'acct1', roster: ['R', 'S', 'V'] };
    w.ready = true;
    // All marked relaunched; R and S have booted; V is marked but not yet live (booting).
    w.marks = new Set(['R', 'S', 'V']);
    w.live = ['R', 'S']; w.relaunched_set = new Set(['R', 'S']);
    const step = await tick(deps(w));
    expect(step.phase).toBe('verifying');
    expect(w.relaunched).toEqual([]);   // V is NOT relaunched again while booting — no duplicate
    expect(w.killed).toEqual([]);
  });

  it('leaves a NON-rotation operator pause alone (not the rotator\'s to resume)', async () => {
    w.pauseId = 1;
    w.intent = null; // a manual pause with no rotation intent
    w.ready = true;
    const step = await tick(deps(w));
    expect(step.phase).toBe('idle');
    expect(w.killed).toEqual([]);
    expect(w.resumed).toEqual([]);
  });

  // ── HED-157 hardening ──────────────────────────────────────────────────────────────────────

  it('VERIFY boot-timeout: a member that never boots past the deadline stops waiting and escalates — not infinite VERIFY', async () => {
    w.pauseId = 1;
    w.intent = { target: 'acct2', from: 'acct1', roster: ['R', 'S', 'V'] };
    w.ready = true;
    w.marks = new Set(['R', 'S', 'V']);                            // every roster member already relaunched
    w.live = ['R', 'S']; w.relaunched_set = new Set(['R', 'S']);    // V never re-registered (crashed on boot)
    w.verifyTimedOut = true;                                       // past the deadline
    const step = await tick(deps(w));
    expect(step.phase).toBe('blocked');
    expect(w.needsHumanMsgs).toHaveLength(1);                      // one combined escalation
    expect(w.needsHumanMsgs[0]).toContain('V');
    expect(w.needsHumanMsgs[0]).toMatch(/did not come back within 300000ms/);
    expect(w.resumed).toEqual([]);                                 // DECISION: never auto-resume on a VERIFY timeout
  });

  it('VERIFY: before the deadline, a not-yet-booted member just waits — no escalation (unchanged behavior)', async () => {
    w.pauseId = 1;
    w.intent = { target: 'acct2', from: 'acct1', roster: ['R', 'S', 'V'] };
    w.ready = true;
    w.marks = new Set(['R', 'S', 'V']);
    w.live = ['R', 'S']; w.relaunched_set = new Set(['R', 'S']);
    w.verifyTimedOut = false;                                      // still within the window
    const step = await tick(deps(w));
    expect(step.phase).toBe('verifying');
    expect(w.needsHumanMsgs).toEqual([]);
  });

  // ── HED-186: PRE-KILL quiesce timeout ──────────────────────────────────────────────────────
  // The MIRROR of the VERIFY timeout, with the OPPOSITE resolution: nothing has been killed yet, so
  // the safe move is to lift the pause and escalate — never leave the fleet paused forever on a
  // stuck agent that will not ack.

  it('QUIESCE timeout: a fleet that never goes quiet ABORTS — pause lifted, human notified, nothing killed', async () => {
    w.pauseId = 1;
    w.intent = { target: 'acct2', from: 'acct1', roster: ['R', 'S', 'V'] };
    w.live = ['R', 'S', 'V'];                       // every roster member still live: nothing was killed
    w.ready = false; w.blockers = ['2 live agent(s) have not acked: S, V'];
    w.quiesceTimedOut = true;                       // past the pre-kill deadline
    const step = await tick(deps(w));
    expect(step.phase).toBe('aborted');
    expect(w.killed).toEqual([]);                   // THE point: the irreversible half never ran
    expect(w.relaunched).toEqual([]);
    expect(w.resumed).toHaveLength(1);              // the pause is LIFTED (unlike the VERIFY timeout)
    expect(w.resumed[0]).toMatch(/ABORTED/);
    expect(w.resumed[0]).toMatch(/no session was killed/);
    expect(w.resumed[0]).toMatch(/rotation 1 to acct2/);              // the pause id reaches the resume log
    expect(w.needsHumanMsgs).toHaveLength(1);
    expect(w.needsHumanMsgs[0]).toMatch(/did not quiesce within 1200000ms/);
    expect(w.needsHumanMsgs[0]).toContain('have not acked: S, V');   // the blockers reach the human
    // Escalate FIRST, then lift, then stamp: a resumePause that throws must not swallow the operator
    // notification, and the HED-200 marker lands only once the lift actually succeeded.
    expect(w.ops).toEqual(['needsHuman', 'resumePause', 'recordAbort']);
    expect(w.abortsRecorded).toEqual(['acct2']);    // HED-200: the durable marker names the target
  });

  it('QUIESCE timeout MID-ROTATION: some members already relaunched stays BLOCKED — the pause is NOT lifted', async () => {
    // The abort branch is RE-ENTRANT: a tick that already killed+relaunched part of the roster can come
    // back here on a later tick and read !ready. Lifting the pause then resumes a HALF-ROTATED fleet
    // (members split across accounts), so this must escalate and hold like the VERIFY timeout.
    w.pauseId = 1;
    w.intent = { target: 'acct2', from: 'acct1', roster: ['R', 'S', 'V'] };
    w.marks = new Set(['R']);                       // R carries a durable relaunch marker: progress was made
    w.live = ['R', 'S', 'V'];
    w.ready = false; w.blockers = ['1 live agent(s) have not acked: V'];
    w.quiesceTimedOut = true;
    const step = await tick(deps(w));
    expect(step.phase).toBe('blocked');
    expect(step.reason).toMatch(/mid-rotation/);
    expect(w.resumed).toEqual([]);                  // THE point: the pause is HELD, not lifted
    expect(w.killed).toEqual([]);
    expect(w.relaunched).toEqual([]);
    expect(w.needsHumanMsgs).toHaveLength(1);
    expect(w.needsHumanMsgs[0]).toMatch(/HALF-ROTATED/);
    expect(w.needsHumanMsgs[0]).toMatch(/1 of 3 member\(s\) already relaunched/);
  });

  it('QUIESCE timeout with a roster member NOT live stays BLOCKED — kill succeeded, relaunch failed leaves no mark', async () => {
    // A member killed by an earlier tick whose relaunch FAILED carries no marker, so a marks-only check
    // reads "nothing relaunched" and would abort past a DEAD member. killSession unregisters the presence
    // row, so the missing member is exactly what the liveness clause catches.
    w.pauseId = 1;
    w.intent = { target: 'acct2', from: 'acct1', roster: ['R', 'S', 'V'] };
    w.marks = new Set<string>();                    // zero marks — indistinguishable from "nothing killed"
    w.live = ['R', 'S'];                            // ...except V is GONE: killed, relaunch failed
    w.ready = false; w.blockers = ['1 in-flight dispatch'];   // an INDEPENDENT blocker holds the fleet !ready
    w.quiesceTimedOut = true;
    const step = await tick(deps(w));
    expect(step.phase).toBe('blocked');
    expect(w.resumed).toEqual([]);                  // THE point: never lift the pause around a dead member
    expect(w.killed).toEqual([]);
    expect(w.needsHumanMsgs).toHaveLength(1);
    expect(w.needsHumanMsgs[0]).toMatch(/not live/);
  });

  it('QUIESCE: before the deadline, a not-yet-quiet fleet just waits — no abort, no resume (unchanged behavior)', async () => {
    w.pauseId = 1;
    w.intent = { target: 'acct2', from: 'acct1', roster: ['R', 'S', 'V'] };
    w.ready = false; w.blockers = ['2 live agent(s) have not acked: S, V'];
    w.quiesceTimedOut = false;                      // still within the window
    const step = await tick(deps(w));
    expect(step.phase).toBe('quiescing');
    expect(w.resumed).toEqual([]);
    expect(w.needsHumanMsgs).toEqual([]);
    expect(w.killed).toEqual([]);
  });

  it('QUIESCE timeout is NOT consulted once the fleet is ready — a quiet fleet proceeds to the kill', async () => {
    // Ordering guard: the timeout lives INSIDE the !ready branch. If it were checked before the
    // readiness gate, a rotation that went quiet slowly would abort instead of rotating.
    w.pauseId = 1;
    w.intent = { target: 'acct2', from: 'acct1', roster: ['R', 'S', 'V'] };
    w.ready = true;
    w.quiesceTimedOut = true;                       // stale-but-quiet: past the deadline AND ready
    const step = await tick(deps(w));
    expect(step.phase).toBe('relaunching');
    expect(w.killed.sort()).toEqual(['R', 'S', 'V']);
    expect(w.resumed).toEqual([]);                  // no abort — readiness wins
  });

  // ── HED-200: durable post-abort cooldown ───────────────────────────────────────────────────
  // The abort above lifts the pause but leaves the account STILL over threshold, so decide() re-issues
  // 'rotate' on the very next tick. Untreated that is a pause → quiesce-fail → abort SAWTOOTH, one
  // cycle per interval — and because each cycle mints a NEW pause id, the needsHuman de-dupe (scoped
  // to the active pause) misses it and re-posts every cycle too.

  it('WATCH: a rotate decision INSIDE the post-abort cooldown holds — no pause requested, nothing killed', async () => {
    w.decision = rotateDecision('acct1', acct('acct2', null));
    w.abortCooldown = true;
    const step = await tick(deps(w));
    expect(step.phase).toBe('watch');
    expect(step.reason).toMatch(/post-abort cooldown/);
    expect(step.reason).toMatch(/rotate acct1 → acct2/);  // the underlying decision still reaches the log
    expect(w.paused).toEqual([]);                   // THE point: no new fleet-wide pause is requested
    expect(w.killed).toEqual([]);
  });

  it('WATCH: the same rotate decision OUTSIDE the cooldown pauses as before — the hold expires', async () => {
    w.decision = rotateDecision('acct1', acct('acct2', null));
    w.abortCooldown = false;
    const step = await tick(deps(w));
    expect(step.phase).toBe('paused');
    expect(w.paused).toHaveLength(1);
    expect(w.paused[0]?.intent).toMatchObject({ target: 'acct2', from: 'acct1' });
  });

  it('the cooldown gates ONLY the rotate branch — an exhausted decision still escalates during it', async () => {
    // Ordering guard, like the quiesce-timeout one above: the check lives INSIDE `case 'rotate'`. Hoisted
    // above the switch it would also swallow the no-target escalation, hiding a real needs-human.
    w.decision = { action: 'exhausted', current: 'acct1', usedPct: 97, reason: 'all accounts near the cap' };
    w.abortCooldown = true;
    const step = await tick(deps(w));
    expect(step.phase).toBe('exhausted');
    expect(w.needsHumanMsgs).toHaveLength(1);
  });

  it('a quiesce timeout that stays BLOCKED records NO abort marker — the pause was never lifted', async () => {
    // The marker means "a rotation aborted and the fleet is free again". A half-rotated fleet HELD under
    // its pause is the opposite case: a human is already on it, and stamping a cooldown here would also
    // suppress the retry that human may be working toward.
    w.pauseId = 1;
    w.intent = { target: 'acct2', from: 'acct1', roster: ['R', 'S', 'V'] };
    w.marks = new Set(['R']);                       // progress was made → blocked, not aborted
    w.live = ['R', 'S', 'V'];
    w.ready = false; w.blockers = ['1 live agent(s) have not acked: V'];
    w.quiesceTimedOut = true;
    const step = await tick(deps(w));
    expect(step.phase).toBe('blocked');
    expect(w.abortsRecorded).toEqual([]);
    expect(w.ops).toEqual(['needsHuman']);          // no lift, so no stamp
  });

});
