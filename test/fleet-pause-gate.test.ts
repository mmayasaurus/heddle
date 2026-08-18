import { describe, expect, it } from 'vitest';
import { CommsLog, DEFAULT_COMMS_PATH } from '../src/comms/log.js';
import { seal } from '../src/comms/seal.js';
import { fleetPauseStatus } from '../src/fleet-pause.js';
import { dispatch } from '../src/dispatch.js';
import { fakeAdapter, IDENTITIES, useTempResources } from './helpers.js';

describe('fleet pause admission gate', () => {
  const { tempDir, tempLedger } = useTempResources('heddle-fleet-pause-gate-');

  /** The broker stamps tier from a sealed decision bound to one (from, to) pair; tests mint those. */
  const decision = (from: string, to: string, tier: 'operator' | 'agent-message') =>
    seal({ from, to, tier, verified: tier !== 'agent-message', evidence: null,
      code: tier === 'operator' ? 'operator-token' : 'unverified', reason: 'test',
      dispatchId: null, requestedTier: null, downgradedFrom: null });
  const operatorDecision = (from: string, to: string) => decision(from, to, 'operator');
  const agentDecision = (from: string, to: string) => decision(from, to, 'agent-message');

  const pause = (log: CommsLog, reason = 'rotation') =>
    log.append({ from: 'operator', to: '@all', kind: 'status', body: `FLEET PAUSE — ${reason}`,
      meta: { fleetPause: { reason } } }, operatorDecision('operator', '@all'));
  const resume = (log: CommsLog, pauseId: number) =>
    log.append({ from: 'operator', to: '@all', kind: 'status', replyTo: pauseId,
      body: 'FLEET RESUMED', meta: { fleetResume: { pauseId } } }, operatorDecision('operator', '@all'));

  const withCommsDbEnv = (value: string | undefined, fn: () => void) => {
    const prev = process.env.HEDDLE_COMMS_DB;
    const had = Object.hasOwn(process.env, 'HEDDLE_COMMS_DB');
    if (value === undefined) delete process.env.HEDDLE_COMMS_DB;
    else process.env.HEDDLE_COMMS_DB = value;
    try {
      fn();
    } finally {
      if (had) process.env.HEDDLE_COMMS_DB = prev!;
      else delete process.env.HEDDLE_COMMS_DB;
    }
  };

  const captureResolvedPath = () => {
    let captured: string | undefined;
    const capture = (p: string) => {
      captured = p;
      return { fleetPauseInForce: () => null, close() {} };
    };
    fleetPauseStatus({ logFactory: capture });
    return captured;
  };

  it('1. reports a fresh comms log as not paused', () => {
    const dbPath = `${tempDir()}/comms.db`;
    const log = new CommsLog(dbPath);
    try {
      expect(fleetPauseStatus({ commsPath: dbPath })).toMatchObject({ paused: false, pauseId: null });
    } finally {
      log.close();
    }
  });

  it('2. reports an operator pause with its id, reason, and timestamp', () => {
    const dbPath = `${tempDir()}/comms.db`;
    const log = new CommsLog(dbPath);
    try {
      const requested = pause(log);
      expect(fleetPauseStatus({ commsPath: dbPath })).toEqual({
        paused: true, pauseId: requested.id, reason: 'rotation', requestedAt: requested.ts,
      });
    } finally {
      log.close();
    }
  });

  it('3. clears the gate when the operator resumes its pause', () => {
    const dbPath = `${tempDir()}/comms.db`;
    const log = new CommsLog(dbPath);
    try {
      const requested = pause(log);
      resume(log, requested.id);
      expect(fleetPauseStatus({ commsPath: dbPath })).toMatchObject({ paused: false, pauseId: null });
    } finally {
      log.close();
    }
  });

  it('4. ignores an agent-tier message that claims to pause the fleet', () => {
    const dbPath = `${tempDir()}/comms.db`;
    const log = new CommsLog(dbPath);
    try {
      log.append({ from: 'agent', to: '@all', kind: 'status', body: 'FLEET PAUSE — malicious',
        meta: { fleetPause: { reason: 'malicious' } } }, agentDecision('agent', '@all'));
      expect(fleetPauseStatus({ commsPath: dbPath })).toMatchObject({ paused: false, pauseId: null });
    } finally {
      log.close();
    }
  });

  it('4b. an agent-tier resume CANNOT lift a real operator pause (symmetric security half)', () => {
    const dbPath = `${tempDir()}/comms.db`;
    const log = new CommsLog(dbPath);
    try {
      const pause = log.append({ from: 'operator', to: '@all', kind: 'status', body: 'FLEET PAUSE — rotation',
        meta: { fleetPause: { reason: 'rotation' } } }, operatorDecision('operator', '@all'));
      // an agent forges a resume reply_to the real pause — the broker stamps it agent-message, and
      // fleetPauseResumedAt only counts OPERATOR resumes, so the pause must still stand.
      log.append({ from: 'agent', to: '@all', kind: 'status', replyTo: pause.id, body: 'resume plz',
        meta: { fleetResume: { pauseId: pause.id } } }, agentDecision('agent', '@all'));
      expect(fleetPauseStatus({ commsPath: dbPath })).toMatchObject({ paused: true, pauseId: pause.id });
    } finally {
      log.close();
    }
  });

  it('5. uses the newest unresumed operator pause', () => {
    const dbPath = `${tempDir()}/comms.db`;
    const log = new CommsLog(dbPath);
    try {
      const first = pause(log, 'first rotation');
      resume(log, first.id);
      const second = pause(log, 'second rotation');
      expect(fleetPauseStatus({ commsPath: dbPath })).toMatchObject({
        paused: true, pauseId: second.id, reason: 'second rotation', requestedAt: second.ts,
      });
    } finally {
      log.close();
    }
  });

  it('6. fails open when the comms database is absent', () => {
    const dbPath = `${tempDir()}/definitely-absent.db`;
    expect(fleetPauseStatus({ commsPath: dbPath })).toMatchObject({ paused: false, pauseId: null });
  });

  it('7. fails open when the injected comms log cannot be read', () => {
    expect(() => fleetPauseStatus({
      commsPath: `${tempDir()}/unreadable.db`,
      logFactory: () => { throw new Error('unreadable test db'); },
    })).not.toThrow();
    expect(fleetPauseStatus({
      commsPath: `${tempDir()}/unreadable.db`,
      logFactory: () => { throw new Error('unreadable test db'); },
    })).toMatchObject({ paused: false, pauseId: null });
  });

  it('8. refuses paused dispatches and admits dispatches after the operator resumes', async () => {
    const dbPath = `${tempDir()}/comms.db`;
    const log = new CommsLog(dbPath);
    const requested = pause(log);
    const previousCommsDb = process.env.HEDDLE_COMMS_DB;
    const hadCommsDb = Object.hasOwn(process.env, 'HEDDLE_COMMS_DB');
    const ledger = tempLedger();
    const fake = fakeAdapter(undefined, { readAgents: false });
    const request = {
      provider: 'codex', model: 'gpt-5.6-terra', prompt: 'x', cwd: tempDir(),
      overrideReason: 'bench paused admission path', identity: IDENTITIES.unbound,
    };

    process.env.HEDDLE_COMMS_DB = dbPath;
    try {
      const paused = await dispatch(request, ledger, () => fake.adapter);
      expect(paused.refusal?.code).toBe('fleet-paused');
      expect(fake.calls).toHaveLength(0);
      expect(ledger.recent(1)[0]).toMatchObject({ refusal: 'fleet-paused', ok: 0 });

      resume(log, requested.id);
      const admitted = await dispatch(request, ledger, () => fake.adapter);
      expect(admitted.refusal?.code).not.toBe('fleet-paused');
      expect(admitted.ok).toBe(true);
      expect(fake.calls).toHaveLength(1);
    } finally {
      if (hadCommsDb) process.env.HEDDLE_COMMS_DB = previousCommsDb!;
      else delete process.env.HEDDLE_COMMS_DB;
      log.close();
    }
  });

  it('9a. resolves HEDDLE_COMMS_DB to DEFAULT_COMMS_PATH when unset', () => {
    withCommsDbEnv(undefined, () => {
      expect(captureResolvedPath()).toBe(DEFAULT_COMMS_PATH);
    });
  });

  it('9b. resolves empty HEDDLE_COMMS_DB to DEFAULT_COMMS_PATH', () => {
    withCommsDbEnv('', () => {
      expect(captureResolvedPath()).toBe(DEFAULT_COMMS_PATH);
    });
  });

  it('9c. resolves whitespace-only HEDDLE_COMMS_DB to the literal value (matches server.ts:165)', () => {
    withCommsDbEnv('   ', () => {
      // Deliberately untrimmed — must match broker resolution at server.ts:165, not a bug.
      expect(captureResolvedPath()).toBe('   ');
    });
  });

  it('9d. resolves an explicit HEDDLE_COMMS_DB path unchanged', () => {
    const explicit = '/tmp/heddle-test-xyz.db';
    withCommsDbEnv(explicit, () => {
      expect(captureResolvedPath()).toBe(explicit);
    });
  });
});
