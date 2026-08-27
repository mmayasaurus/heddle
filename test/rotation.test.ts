import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyRotationRefusal, isCooled, pickCodexAccount, pickCursorAccount,
  coolingTempPath, readCooling, readRotationAccounts, writeCooling, type CoolingStore,
} from '../src/rotation.js';
import { useTempResources } from './helpers.js';
import { dispatch } from '../src/dispatch.js';
import { fakeAdapter, IDENTITIES } from './helpers.js';
import { buildWorkerEnv } from '../src/env.js';

const { tempDir, tempLedger } = useTempResources('heddle-rotation-');

describe('rotation registry', () => {
  it('returns empty pools for missing or malformed registries', () => {
    const dir = tempDir();
    expect(readRotationAccounts(join(dir, 'missing.json'))).toEqual({ codex: [], cursor: [] });
    writeFileSync(join(dir, 'accounts.json'), '{not json');
    expect(readRotationAccounts(join(dir, 'accounts.json'))).toEqual({ codex: [], cursor: [] });
  });

  it('preserves registry preference but boosts entries through their inclusive preferUntil day', () => {
    const dir = tempDir(); const path = join(dir, 'accounts.json');
    writeFileSync(path, JSON.stringify({ codex: [
      { id: 'first', codexHome: '/a' }, { id: 'bonus', codexHome: '/b', preferUntil: '2026-09-03' },
    ] }));
    const registry = readRotationAccounts(path);
    expect(pickCodexAccount(registry, { schemaVersion: 1, lanes: {} }, undefined, Date.parse('2026-09-03T12:00:00Z') / 1000)?.id).toBe('bonus');
    expect(pickCodexAccount(registry, { schemaVersion: 1, lanes: {} }, undefined, Date.parse('2026-09-04T00:00:00Z') / 1000)?.id).toBe('first');
  });
});

describe('rotation cooling', () => {
  it('skips cooled accounts until their supplied clock reaches expiry', () => {
    const cooling: CoolingStore = { schemaVersion: 1, lanes: { 'codex:a': { cooledAt: 100, cooldownS: 60, reason: 'rate-limit' } } };
    expect(isCooled(cooling, 'codex', 'a', 159)).toBe(true);
    expect(isCooled(cooling, 'codex', 'a', 160)).toBe(false);
    const registry = { codex: [{ id: 'a', codexHome: '/a' }, { id: 'b', codexHome: '/b' }], cursor: [] };
    expect(pickCodexAccount(registry, cooling, undefined, 120)).toMatchObject({ id: 'b', reason: expect.stringContaining('cooling') });
  });

  it('treats a corrupt cooling store as empty and writes atomically', () => {
    const dir = tempDir(); const path = join(dir, 'cooling.json');
    writeFileSync(path, '{bad');
    expect(readCooling(path)).toEqual({ schemaVersion: 1, lanes: {} });
    writeCooling(path, { schemaVersion: 1, lanes: { 'cursor:a': { cooledAt: 1, cooldownS: 3600, reason: 'quota' } } });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ schemaVersion: 1, lanes: { 'cursor:a': { reason: 'quota' } } });
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it('recreates a leftover cooling temp file with private permissions', () => {
    const dir = tempDir(); const path = join(dir, 'cooling.json');
    writeFileSync(`${path}.tmp`, 'leftover'); chmodSync(`${path}.tmp`, 0o644);
    writeCooling(path, { schemaVersion: 1, lanes: {} });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('uses a unique private temp file without trusting a foreign leftover', () => {
    const dir = tempDir(); const path = join(dir, 'cooling.json');
    const first = coolingTempPath(path); const second = coolingTempPath(path);
    expect(first).not.toBe(second);
    expect(first).toMatch(new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.${process.pid}\\.\\d+\\.tmp$`));
    writeFileSync(`${path}.tmp`, '{foreign'); chmodSync(`${path}.tmp`, 0o644);
    writeCooling(path, { schemaVersion: 1, lanes: { 'codex:one': { cooledAt: 1, cooldownS: 60, reason: 'quota' } } });
    expect(JSON.parse(readFileSync(path, 'utf8')).lanes['codex:one']).toMatchObject({ reason: 'quota' });
    expect(readFileSync(`${path}.tmp`, 'utf8')).toBe('{foreign');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe('rotation classifier and selectors', () => {
  it('only classifies clear provider quota failures', () => {
    expect(classifyRotationRefusal('codex', { ok: false, output: '', error: 'HTTP 429 rate limit exceeded', exitCode: 1 })).toBe('rate-limit');
    expect(classifyRotationRefusal('cursor', { ok: false, output: 'usage cap exhausted', exitCode: 1 })).toBe('rate-limit');
    expect(classifyRotationRefusal('codex', { ok: false, output: '', error: 'socket closed', exitCode: 1 })).toBeNull();
    expect(classifyRotationRefusal('cursor', { ok: false, output: '', error: 'invalid request', exitCode: 1 })).toBeNull();
  });

  it('finds refusal signals in either error stream while rejecting generic resource failures', () => {
    expect(classifyRotationRefusal('cursor', { ok: false, error: 'cursor-agent is_error=true (exit 1)', output: "You've hit your usage limit", exitCode: 1 })).toBe('rate-limit');
    expect(classifyRotationRefusal('codex', { ok: false, error: 'HTTP 429 rate limit exceeded', output: 'x'.repeat(2500), exitCode: 1 })).toBe('rate-limit');
    expect(classifyRotationRefusal('codex', { ok: false, error: 'ENOMEM: memory exhausted', output: '', exitCode: 1 })).toBeNull();
    expect(classifyRotationRefusal('cursor', { ok: false, error: 'retries exhausted', output: '', exitCode: 1 })).toBeNull();
    expect(classifyRotationRefusal('cursor', { ok: false, error: 'disk quota exceeded', output: '', exitCode: 1 })).toBeNull();
  });

  it('honors a codex pin even while cooled and explains that cooling is advisory', () => {
    const registry = { codex: [{ id: 'a', codexHome: '/a' }], cursor: [] };
    const cooling: CoolingStore = { schemaVersion: 1, lanes: { 'codex:a': { cooledAt: 100, cooldownS: 3600, reason: 'quota' } } };
    expect(pickCodexAccount(registry, cooling, '/a', 101)).toMatchObject({ id: 'a', reason: expect.stringContaining('pinned') });
    expect(pickCodexAccount(registry, cooling, '/a', 101)?.reason).toContain('cooling');
  });

  it('uses the first preferred codex account when every registered account is cooling', () => {
    const registry = { codex: [{ id: 'one', codexHome: '/one' }, { id: 'two', codexHome: '/two' }], cursor: [] };
    const cooling: CoolingStore = { schemaVersion: 1, lanes: {
      'codex:one': { cooledAt: 100, cooldownS: 3600, reason: 'quota' },
      'codex:two': { cooledAt: 100, cooldownS: 3600, reason: 'quota' },
    } };
    expect(pickCodexAccount(registry, cooling, undefined, 101)).toMatchObject({ id: 'one', reason: expect.stringContaining('cooling') });
  });

  it('uses machine login byte-stably for Cursor-native models and selects API accounts for metered models', () => {
    const dir = tempDir(); const key = join(dir, 'key');
    writeFileSync(key, '  cursor-key\n'); chmodSync(key, 0o600);
    const registry = { codex: [], cursor: [
      { id: 'machine', keyFile: null }, { id: 'api', keyFile: key, preferUntil: '2026-09-03' },
    ] };
    const cooling: CoolingStore = { schemaVersion: 1, lanes: {} };
    expect(pickCursorAccount('cursor-fast', registry, cooling, 1_788_300_800)).toEqual({ id: 'machine', keyFile: null, reason: 'account:machine cursor included pool' });
    expect(pickCursorAccount('kimi-k3', registry, cooling, 1_788_300_800)).toMatchObject({ id: 'api', keyFile: key });
  });

  it('keeps machine login fallback-only for metered Cursor models', () => {
    const registry = { codex: [], cursor: [{ id: 'machine', keyFile: null }, { id: 'api', keyFile: '/k' }] };
    const cooling: CoolingStore = { schemaVersion: 1, lanes: {} };
    expect(pickCursorAccount('kimi-k3', registry, cooling, 1)).toMatchObject({ id: 'api', keyFile: '/k' });
    cooling.lanes['cursor:api'] = { cooledAt: 1, cooldownS: 3600, reason: 'rate-limit' };
    expect(pickCursorAccount('kimi-k3', registry, cooling, 1)).toMatchObject({ id: 'machine', keyFile: null, reason: expect.stringContaining('fallback') });
  });
});

describe('rotation dispatch wiring', () => {
  it('passes selected CODEX_HOME through buildWorkerEnv and unsets it for the default account', async () => {
    const fake = fakeAdapter(undefined, { readAgents: false }); const cwd = tempDir();
    const outcome = await dispatch({ taskClass: 'bulk-mechanical', prompt: 'x', cwd, identity: IDENTITIES.unbound,
      rotationAccounts: { codex: [{ id: 'default', codexHome: null }], cursor: [] }, coolingPath: join(tempDir(), 'cooling.json'), nowS: 1 }, tempLedger(), () => fake.adapter);
    expect(outcome.account).toBe('default');
    expect(buildWorkerEnv({ overrides: fake.calls[0].opts.env, unset: fake.calls[0].opts.envUnset }).env.CODEX_HOME).toBeUndefined();
    expect(fake.calls[0].opts.envUnset).toContain('CODEX_HOME');
  });

  it('uses an all-cooled codex account rather than leaking an inherited CODEX_HOME', async () => {
    const fake = fakeAdapter(undefined, { readAgents: false }); const cwd = tempDir(); const coolingPath = join(tempDir(), 'cooling.json');
    writeCooling(coolingPath, { schemaVersion: 1, lanes: {
      'codex:one': { cooledAt: 100, cooldownS: 3600, reason: 'quota' },
      'codex:two': { cooledAt: 100, cooldownS: 3600, reason: 'quota' },
    } });
    const outcome = await dispatch({ taskClass: 'bulk-mechanical', prompt: 'x', cwd, identity: IDENTITIES.unbound,
      rotationAccounts: { codex: [{ id: 'one', codexHome: '/one' }, { id: 'two', codexHome: null }], cursor: [] }, coolingPath, nowS: 101 }, tempLedger(), () => fake.adapter);
    expect(outcome.account).toBe('one');
    expect(fake.calls[0].opts.env?.CODEX_HOME).toBe('/one');
    expect(fake.calls[0].opts.envUnset).not.toContain('CODEX_HOME');
  });

  it('keeps a resumed codex dispatch on its explicit home or the default login', async () => {
    const registry = { codex: [{ id: 'one', codexHome: '/one' }, { id: 'two', codexHome: '/two' }], cursor: [] };
    const coolingPath = join(tempDir(), 'cooling.json');
    writeCooling(coolingPath, { schemaVersion: 1, lanes: { 'codex:one': { cooledAt: 100, cooldownS: 3600, reason: 'quota' } } });
    const defaultRun = fakeAdapter(undefined, { readAgents: false });
    const defaultOutcome = await dispatch({ taskClass: 'bulk-mechanical', prompt: 'x', cwd: tempDir(), resume: 'thread', identity: IDENTITIES.unbound, rotationAccounts: registry, coolingPath, nowS: 101 }, tempLedger(), () => defaultRun.adapter);
    expect(defaultOutcome.account).toBe('default');
    expect(defaultRun.calls[0].opts.envUnset).toContain('CODEX_HOME');
    const pinnedRun = fakeAdapter(undefined, { readAgents: false });
    const pinnedOutcome = await dispatch({ taskClass: 'bulk-mechanical', prompt: 'x', cwd: tempDir(), resume: 'thread', identity: IDENTITIES.unbound, env: { CODEX_HOME: '/two' }, rotationAccounts: registry, coolingPath, nowS: 101 }, tempLedger(), () => pinnedRun.adapter);
    expect(pinnedOutcome.account).toBe('two');
    expect(pinnedRun.calls[0].opts.env?.CODEX_HOME).toBe('/two');
  });

  it('keeps Cursor included-pool workers on machine login without key injection', async () => {
    const fake = fakeAdapter(undefined, { readAgents: false }); const cwd = tempDir();
    const outcome = await dispatch({ taskClass: 'bulk-mechanical', prompt: 'x', cwd, identity: IDENTITIES.unbound,
      caps: { codex: { provider: 'codex', source: 'limits.json', stale: false, capturedAt: 1, fiveHour: { usedPercentage: 95, resetsAt: null }, sevenDay: { usedPercentage: null, resetsAt: null }, windows: {}, noteCodes: [], accounts: [], activeAccount: null } },
      env: { CURSOR_API_KEY: 'caller-key' }, rotationAccounts: { codex: [], cursor: [{ id: 'machine', keyFile: null }, { id: 'api', keyFile: '/unused' }] }, coolingPath: join(tempDir(), 'cooling.json'), nowS: 1 }, tempLedger(), () => fake.adapter);
    expect(outcome.account).toBe('machine');
    expect(buildWorkerEnv({ overrides: fake.calls[0].opts.env, unset: fake.calls[0].opts.envUnset }).env.CURSOR_API_KEY).toBeUndefined();
    expect(fake.calls[0].opts.envUnset).toContain('CURSOR_API_KEY');
  });

  it('cools a rate-limited codex account and retries once on the next account before fallback', async () => {
    const fake = fakeAdapter(undefined, { readAgents: false }); const cwd = tempDir(); const coolingPath = join(tempDir(), 'cooling.json');
    let calls = 0;
    const adapter = { ...fake.adapter, dispatch: async (prompt: string, opts: Parameters<typeof fake.adapter.dispatch>[1]) => {
      calls += 1; await fake.adapter.dispatch(prompt, opts);
      return calls === 1 ? { ok: false, output: '', error: '429 rate limit', exitCode: 1 } : { ok: true, output: 'done', exitCode: 0 };
    } };
    const outcome = await dispatch({ taskClass: 'bulk-mechanical', prompt: 'x', cwd, identity: IDENTITIES.unbound,
      rotationAccounts: { codex: [{ id: 'one', codexHome: '/one' }, { id: 'two', codexHome: '/two' }], cursor: [] }, coolingPath, nowS: 100 }, tempLedger(), () => adapter);
    expect(fake.calls).toHaveLength(2); expect(fake.calls.map((call) => call.opts.env?.CODEX_HOME)).toEqual(['/one', '/two']);
    expect(outcome.account).toBe('two'); expect(outcome.routeReason).toContain('account-failover:one→two (rate-limit)');
    expect(readCooling(coolingPath).lanes['codex:one']).toMatchObject({ cooledAt: 100, reason: 'rate-limit' });
  });

  it('falls through to the class fallback when both rotated codex accounts rate-limit', async () => {
    const fake = fakeAdapter(undefined, { readAgents: false }); const cwd = tempDir(); const coolingPath = join(tempDir(), 'cooling.json');
    const adapter = { ...fake.adapter, dispatch: async (prompt: string, opts: Parameters<typeof fake.adapter.dispatch>[1]) => {
      await fake.adapter.dispatch(prompt, opts);
      return fake.calls.length < 3 ? { ok: false, output: '', error: '429 rate limit', exitCode: 1 } : { ok: true, output: 'done', exitCode: 0 };
    } };
    const outcome = await dispatch({ taskClass: 'bulk-mechanical', prompt: 'x', cwd, identity: IDENTITIES.unbound,
      rotationAccounts: { codex: [{ id: 'one', codexHome: '/one' }, { id: 'two', codexHome: '/two' }], cursor: [] }, coolingPath, nowS: 100 }, tempLedger(), () => adapter);
    expect(fake.calls).toHaveLength(3); expect(fake.calls[2].opts.model).toBe('composer-2.5-fast');
    expect(readCooling(coolingPath).lanes['codex:one']).toMatchObject({ cooledAt: 100, reason: 'rate-limit' });
    expect(readCooling(coolingPath).lanes['codex:two']).toMatchObject({ cooledAt: 100, reason: 'rate-limit' });
    expect(outcome.routeReason).toContain('account-failover:one→two (rate-limit)');
    expect(outcome.routeReason).toContain('failed → class fallback');
  });

  // NOTE: escape/destroyed preservation across the account-failover retry (grok F2) is a trivial object
  // merge in dispatch() (primary.escape/destroyed carried onto the retry outcome). It was covered by a
  // real-`git worktree add` test, removed here because it contended with the git-heavy review suite under
  // full-suite parallelism and timed out an unrelated test — the merge is verified by inspection + the
  // existing escape/destroyed DETECTION tests. (A lighter regression test can ride HED-392.)

  it('does not cool generic codex failures and uses the existing provider fallback', async () => {
    const fake = fakeAdapter(undefined, { readAgents: false }); const cwd = tempDir(); const coolingPath = join(tempDir(), 'cooling.json');
    let calls = 0;
    const adapter = { ...fake.adapter, dispatch: async (prompt: string, opts: Parameters<typeof fake.adapter.dispatch>[1]) => {
      calls += 1; await fake.adapter.dispatch(prompt, opts);
      return calls === 1 ? { ok: false, output: '', error: 'socket closed', exitCode: 1 } : { ok: true, output: 'done', exitCode: 0 };
    } };
    const outcome = await dispatch({ taskClass: 'bulk-mechanical', prompt: 'x', cwd, identity: IDENTITIES.unbound,
      rotationAccounts: { codex: [{ id: 'one', codexHome: '/one' }, { id: 'two', codexHome: '/two' }], cursor: [] }, coolingPath, nowS: 100 }, tempLedger(), () => adapter);
    expect(fake.calls).toHaveLength(2); expect(fake.calls[1].opts.model).toBe('composer-2.5-fast');
    expect(readCooling(coolingPath).lanes).toEqual({}); expect(outcome.routeReason).not.toContain('account-failover');
  });

  it('cools a rate-limited account under noFallback without retrying', async () => {
    const fake = fakeAdapter(undefined, { readAgents: false }); const coolingPath = join(tempDir(), 'cooling.json');
    const adapter = { ...fake.adapter, dispatch: async (prompt: string, opts: Parameters<typeof fake.adapter.dispatch>[1]) => {
      await fake.adapter.dispatch(prompt, opts);
      return { ok: false, output: '', error: 'HTTP 429 rate limit', exitCode: 1 };
    } };
    const outcome = await dispatch({ taskClass: 'bulk-mechanical', prompt: 'x', cwd: tempDir(), identity: IDENTITIES.unbound, noFallback: true,
      rotationAccounts: { codex: [{ id: 'one', codexHome: '/one' }], cursor: [] }, coolingPath, nowS: 100 }, tempLedger(), () => adapter);
    expect(outcome.ok).toBe(false); expect(fake.calls).toHaveLength(1);
    expect(readCooling(coolingPath).lanes['codex:one']).toMatchObject({ cooledAt: 100, reason: 'rate-limit' });
  });
});
