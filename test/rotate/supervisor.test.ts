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
    relaunched_set = new Set<string>();  // addresses whose live session is the post-rotation one
    decision: RotateAction = { action: 'idle', current: 'acct1', usedPct: 10, reason: 'idle' };
    relaunchOk: (address: string) => { ok: boolean; code: string } = () => ({ ok: true, code: 'launched' });
    killOk: (address: string) => { ok: boolean; code: string } = () => ({ ok: true, code: 'killed' });
    // recorders
    killed: string[] = [];
    relaunched: { address: string; account: string }[] = [];
    needsHumanMsgs: string[] = [];
    paused: { reason: string; intent: RotationIntent }[] = [];
    resumed: string[] = [];
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
    requestPause: (reason, intent) => { w.paused.push({ reason, intent }); w.pauseId = 1; w.intent = intent; },
    resumePause: (reason) => { w.resumed.push(reason); w.pauseId = null; w.intent = null; },
    killSession: async (a) => { w.killed.push(a); const r = w.killOk(a); if (r.ok) { w.live = w.live.filter((x) => x !== a); w.relaunched_set.delete(a); } return r; },
    relaunch: async (a, account) => {
      const r = w.relaunchOk(a);
      w.relaunched.push({ address: a, account });
      if (r.ok) { w.live.push(a); w.relaunched_set.add(a); }
      return r;
    },
    needsHuman: (m) => w.needsHumanMsgs.push(m),
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
    w.live = ['R', 'S']; w.relaunched_set = new Set(['R', 'S']);
    const step = await tick(deps(w));
    expect(step.phase).toBe('verifying');
    expect(w.resumed).toEqual([]);
  });

  it('RESUME: all roster back on the target lifts the pause', async () => {
    w.pauseId = 1;
    w.intent = { target: 'acct2', from: 'acct1', roster: ['R', 'S', 'V'] };
    w.ready = true;
    w.live = ['R', 'S', 'V']; w.relaunched_set = new Set(['R', 'S', 'V']);
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
    w.relaunched_set = new Set(['R']); // R already relaunched; S,V still the old sessions
    const step = await tick(deps(w));
    expect(step.phase).toBe('relaunching');
    expect(w.killed.sort()).toEqual(['S', 'V']);   // R is NOT re-killed
    expect(w.relaunched.map((r) => r.address).sort()).toEqual(['S', 'V']);
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
});
