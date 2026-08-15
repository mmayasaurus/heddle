import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attributeDispatch, resolveIdentity } from '../src/identity.js';
import type { BoundIdentity } from '../src/identity.js';

describe('identity resolution and attribution', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); dirs.length = 0; });
  const unbound = { agent: null, source: 'unbound', worker: null } as const;
  const boundU = { agent: 'U', source: 'env:HEDDLE_AGENT', worker: null } as const satisfies BoundIdentity;

  it('resolves an empty environment as an unbound identity', () => {
    expect(resolveIdentity('/tmp', {})).toEqual(unbound);
  });

  it('trims a heddle agent environment binding', () => {
    expect(resolveIdentity('/tmp', { HEDDLE_AGENT: ' U ' })).toMatchObject({ agent: 'U', source: 'env:HEDDLE_AGENT' });
  });

  it('prefers HEDDLE_AGENT over FLEET_AGENT while still supporting FLEET_AGENT alone', () => {
    expect(resolveIdentity('/tmp', { HEDDLE_AGENT: 'U', FLEET_AGENT: 'K' })).toMatchObject({ agent: 'U', source: 'env:HEDDLE_AGENT' });
    expect(resolveIdentity('/tmp', { FLEET_AGENT: 'K' })).toMatchObject({ agent: 'K', source: 'env:FLEET_AGENT' });
  });

  it('walks upward for a non-empty fleet file unless an environment identity wins', () => {
    const a = mkdtempSync(join(tmpdir(), 'heddle-identity-test-'));
    const c = join(a, 'b', 'c');
    dirs.push(a);
    mkdirSync(c, { recursive: true });
    writeFileSync(join(a, '.fleet-agent'), 'T\n');
    writeFileSync(join(c, '.fleet-agent'), '');
    expect(resolveIdentity(c, {})).toMatchObject({ agent: 'T', source: 'file:.fleet-agent' });
    expect(resolveIdentity(c, { FLEET_AGENT: 'K' })).toMatchObject({ agent: 'K', source: 'env:FLEET_AGENT' });
  });

  it('keeps worker context separate from its optional bound identity', () => {
    expect(resolveIdentity('/tmp', { HEDDLE_WORKER: '1', HEDDLE_DISPATCH_ID: '42', HEDDLE_PARENT: 'K' }))
      .toEqual({ agent: null, source: 'unbound', worker: { dispatchId: 42, parent: 'K' } });
    expect(resolveIdentity('/tmp', { HEDDLE_WORKER: '1', HEDDLE_DISPATCH_ID: 'nope' }))
      .toEqual({ agent: null, source: 'unbound', worker: { dispatchId: null, parent: null } });
    expect(resolveIdentity('/tmp', { HEDDLE_WORKER: '0' }).worker).toBeNull();
    expect(resolveIdentity('/tmp', { HEDDLE_WORKER: '1', HEDDLE_AGENT: 'U' }))
      .toEqual({ agent: 'U', source: 'env:HEDDLE_AGENT', worker: { dispatchId: null, parent: null } });
  });

  it('attributes dispatches to a binding before an optional caller identity', () => {
    expect(attributeDispatch(boundU, undefined)).toEqual({ orchestrator: 'U', identitySource: 'bound' });
    expect(attributeDispatch(boundU, 'U')).toEqual({ orchestrator: 'U', identitySource: 'bound' });
    expect(attributeDispatch(boundU, 'K')).toEqual({ orchestrator: 'U', identitySource: 'bound', ignoredCallerAgent: 'K' });
    expect(attributeDispatch(unbound, 'K')).toEqual({ orchestrator: 'K', identitySource: 'caller' });
    expect(attributeDispatch(unbound, '  ')).toEqual({ orchestrator: null, identitySource: null });
    expect(attributeDispatch(unbound, undefined)).toEqual({ orchestrator: null, identitySource: null });
  });
});
