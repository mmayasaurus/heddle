import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readClaudeAccounts } from '../src/capaware.js';
import {
  loadAccountRegistry,
  reconcileRegistryIdentity,
  upsertAccount,
  writeAccountRegistry,
  type AccountRegistry,
} from '../src/accounts.js';
import { readRotationAccounts } from '../src/rotation.js';
import { useTempResources } from './helpers.js';

describe('loadAccountRegistry', () => {
  const { tempDir } = useTempResources('heddle-accounts-test-');

  function writeAccounts(name: string, value: unknown): string {
    const path = join(tempDir(), name);
    writeFileSync(path, JSON.stringify(value));
    return path;
  }

  afterEach(() => vi.restoreAllMocks());

  it('returns an empty v2 registry when the file is absent', () => {
    expect(loadAccountRegistry(join(tempDir(), 'missing.json'))).toEqual({ schemaVersion: 2, accounts: [] });
  });

  it('loads legacy sibling arrays with derived provider, harness, and credential reference', () => {
    const path = writeAccounts('legacy.json', {
      claude: [{ id: 'claude-default', configDir: null }, { id: 'claude-alt', configDir: '/tmp/claude' }],
      codex: [{ id: 'codex-default', codexHome: null }, { id: 'codex-alt', codexHome: '/tmp/codex' }],
      cursor: [{ id: 'cursor-default', keyFile: null }, { id: 'cursor-alt', keyFile: '/tmp/cursor-key' }],
    });
    expect(loadAccountRegistry(path).accounts.map(({ id, provider, harness, credentialRef }) => ({ id, provider, harness, credentialRef }))).toEqual([
      { id: 'claude-default', provider: 'claude', harness: 'claude-code', credentialRef: 'claude:default' },
      { id: 'claude-alt', provider: 'claude', harness: 'claude-code', credentialRef: 'claude:/tmp/claude' },
      { id: 'codex-default', provider: 'codex', harness: 'codex-cli', credentialRef: 'codex:default' },
      { id: 'codex-alt', provider: 'codex', harness: 'codex-cli', credentialRef: 'codex:/tmp/codex' },
      { id: 'cursor-default', provider: 'cursor', harness: 'cursor-agent', credentialRef: 'cursor:default' },
      { id: 'cursor-alt', provider: 'cursor', harness: 'cursor-agent', credentialRef: 'cursor:/tmp/cursor-key' },
    ]);
  });

  it('carries optional v2 metadata and falls back from notes to legacy note', () => {
    const path = writeAccounts('metadata.json', {
      claude: [{
        id: 'claude', configDir: null, harness: 'custom-harness', billingClass: 'subscription-flat', tier: 'T2',
        fences: { readOnlyEnforceable: true, networkEnforceable: false, cwdEnforceable: true },
        lastVerified: '2026-09-05T00:00:00Z', note: 'legacy note', orgId: 'org', accountUuid: 'uuid', email: 'a@example.test', loggedIn: false,
        region: 'us-east-1', trainsOnInputs: false, oneLoginAtATime: true,
      }],
    });
    expect(loadAccountRegistry(path).accounts[0]).toMatchObject({
      id: 'claude', harness: 'custom-harness', billingClass: 'subscription-flat', tier: 'T2', notes: 'legacy note',
      orgId: 'org', accountUuid: 'uuid', email: 'a@example.test', loggedIn: false,
      region: 'us-east-1', trainsOnInputs: false, oneLoginAtATime: true,
      fences: { readOnlyEnforceable: true, networkEnforceable: false, cwdEnforceable: true },
    });
  });

  it('ignores non-boolean privacy and login metadata', () => {
    const path = writeAccounts('invalid-boolean-metadata.json', {
      claude: [{ id: 'claude', configDir: null, trainsOnInputs: 'no', oneLoginAtATime: 1 }],
    });
    const account = loadAccountRegistry(path).accounts[0]!;
    expect(account).not.toHaveProperty('trainsOnInputs');
    expect(account).not.toHaveProperty('oneLoginAtATime');
  });

  it('keeps a present notes field and prefers it over legacy note', () => {
    const path = writeAccounts('notes.json', {
      claude: [
        { id: 'notes-only', configDir: null, notes: 'direct notes' },
        { id: 'both', configDir: null, notes: 'direct notes', note: 'legacy note' },
      ],
    });
    const accounts = loadAccountRegistry(path).accounts;
    expect(accounts[0]!.notes).toBe('direct notes');
    expect(accounts[1]!.notes).toBe('direct notes');
  });

  it('carries each overage posture through the unified model', () => {
    const path = writeAccounts('overage.json', {
      claude: [{ id: 'hard-stop', overage: { posture: 'hard-stop' } }],
      codex: [{ id: 'bounded', overage: { posture: 'bounded-prepaid', spendLimit: 39, creditsRemaining: 12.5 } }],
      cursor: [{ id: 'open-billing', overage: { posture: 'open-billing' } }],
    });
    expect(loadAccountRegistry(path).accounts.map(({ id, overage }) => ({ id, overage }))).toEqual([
      { id: 'hard-stop', overage: { posture: 'hard-stop' } },
      { id: 'bounded', overage: { posture: 'bounded-prepaid', spendLimit: 39, creditsRemaining: 12.5 } },
      { id: 'open-billing', overage: { posture: 'open-billing' } },
    ]);
  });

  it('carries an envRepoint through the unified model', () => {
    const path = writeAccounts('env-repoint.json', {
      claude: [{ id: 'glm', envRepoint: { baseUrl: 'https://api.z.ai/api/anthropic', authTokenRef: 'GLM_API_KEY', service: 'glm' } }],
    });
    expect(loadAccountRegistry(path).accounts[0]!.envRepoint).toEqual({
      baseUrl: 'https://api.z.ai/api/anthropic', authTokenRef: 'GLM_API_KEY', service: 'glm',
    });
  });

  it('preserves an operator-supplied envRepoint model and omits it when absent', () => {
    const path = writeAccounts('env-repoint-model.json', { claude: [
      { id: 'with-model', envRepoint: { baseUrl: 'https://x.test', authTokenRef: 'NAME', service: 'kimi', model: 'synthetic-kimi-id' } },
      { id: 'without-model', envRepoint: { baseUrl: 'https://x.test', authTokenRef: 'NAME', service: 'glm' } },
    ] });
    const [withModel, withoutModel] = loadAccountRegistry(path).accounts;
    expect(withModel!.envRepoint).toMatchObject({ model: 'synthetic-kimi-id' });
    expect(withoutModel!.envRepoint).not.toHaveProperty('model');
  });

  it('stores envRepoint authTokenRef verbatim as a reference, never a token', () => {
    const path = writeAccounts('env-repoint-reference.json', {
      claude: [{ id: 'glm', envRepoint: { baseUrl: 'https://api.z.ai/api/anthropic', authTokenRef: 'GLM_API_KEY', service: 'glm' } }],
    });
    expect(loadAccountRegistry(path).accounts[0]!.envRepoint!.authTokenRef).toBe('GLM_API_KEY');
  });

  it.each([
    ['non-object', 'x'],
    ['array', []],
    ['null', null],
    ['missing baseUrl', { authTokenRef: 'NAME' }],
    ['empty baseUrl', { baseUrl: '', authTokenRef: 'NAME' }],
    ['non-URL baseUrl', { baseUrl: 'not a url', authTokenRef: 'NAME' }],
    ['non-http baseUrl', { baseUrl: 'ftp://x', authTokenRef: 'NAME' }],
    ['missing authTokenRef', { baseUrl: 'https://x.test' }],
    ['empty authTokenRef', { baseUrl: 'https://x.test', authTokenRef: '' }],
    ['missing service', { baseUrl: 'https://x.test', authTokenRef: 'NAME' }],
    ['empty service', { baseUrl: 'https://x.test', authTokenRef: 'NAME', service: '' }],
  ])('rejects %s envRepoint with the file path', (_label, envRepoint) => {
    const path = writeAccounts(`bad-env-repoint-${_label}.json`, { claude: [{ id: 'a', envRepoint }] });
    expect(() => loadAccountRegistry(path)).toThrow(path);
  });

  it('tolerates and ignores unknown envRepoint keys', () => {
    const path = writeAccounts('future-env-repoint.json', {
      claude: [{ id: 'a', envRepoint: { baseUrl: 'https://x.test', authTokenRef: 'NAME', service: 'glm', futureField: 'x' } }],
    });
    expect(loadAccountRegistry(path).accounts[0]!.envRepoint).toEqual({ baseUrl: 'https://x.test', authTokenRef: 'NAME', service: 'glm' });
  });

  it('derives distinct credential references for env-repoint services on one harness', () => {
    const path = writeAccounts('env-repoint-credential-refs.json', {
      claude: [
        { id: 'glm-1', configDir: null, envRepoint: { baseUrl: 'https://api.z.ai/api/anthropic', authTokenRef: 'GLM_API_KEY', service: 'glm' } },
        { id: 'kimi-1', configDir: null, envRepoint: { baseUrl: 'https://api.moonshot.ai/anthropic', authTokenRef: 'KIMI_API_KEY', service: 'kimi' } },
      ],
    });
    expect(loadAccountRegistry(path).accounts.map((account) => account.credentialRef)).toEqual([
      'claude:glm:default', 'claude:kimi:default',
    ]);
  });

  it.each([
    ['invalid posture', { posture: 'unlimited' }],
    ['bounded-prepaid missing spendLimit', { posture: 'bounded-prepaid', creditsRemaining: 1 }],
    ['bounded-prepaid missing creditsRemaining', { posture: 'bounded-prepaid', spendLimit: 1 }],
    ['hard-stop carrying spendLimit', { posture: 'hard-stop', spendLimit: 1 }],
  ])('rejects %s overage with the file path', (_label, overage) => {
    const path = writeAccounts(`bad-overage-${_label}.json`, { claude: [{ id: 'a', overage }] });
    expect(() => loadAccountRegistry(path)).toThrow(path);
  });

  it.each([undefined, 2])('accepts schemaVersion %s', (schemaVersion) => {
    const path = writeAccounts(`version-${String(schemaVersion)}.json`, {
      ...(schemaVersion === undefined ? {} : { schemaVersion }), claude: [],
    });
    expect(loadAccountRegistry(path)).toEqual({ schemaVersion: 2, accounts: [] });
  });

  it.each([1, 99, 'x'])('rejects unsupported schemaVersion %s with the file path', (schemaVersion) => {
    const path = writeAccounts(`bad-version-${String(schemaVersion)}.json`, { schemaVersion, claude: [] });
    expect(() => loadAccountRegistry(path)).toThrow(path);
  });

  it.each([
    ['billingClass', 'unknown'],
    ['tier', 'T9'],
    ['fences', { readOnlyEnforceable: true, networkEnforceable: false }],
  ])('rejects malformed %s with the file path', (key, value) => {
    const path = writeAccounts(`bad-${key}.json`, { claude: [{ id: 'a', [key]: value }] });
    expect(() => loadAccountRegistry(path)).toThrow(path);
  });

  it('rejects fences with unexpected keys', () => {
    const path = writeAccounts('extra-fence.json', {
      claude: [{ id: 'a', fences: { readOnlyEnforceable: true, networkEnforceable: false, cwdEnforceable: true, extra: true } }],
    });
    expect(() => loadAccountRegistry(path)).toThrow(path);
  });

  it('rejects duplicate ids within a provider and invalid JSON with the file path', () => {
    const duplicate = writeAccounts('duplicate.json', { claude: [{ id: 'a' }, { id: 'a' }] });
    expect(() => loadAccountRegistry(duplicate)).toThrow(duplicate);
    const invalid = join(tempDir(), 'invalid.json');
    writeFileSync(invalid, '{nope');
    expect(() => loadAccountRegistry(invalid)).toThrow(invalid);
  });

  it.each([
    ['null', null],
    ['string', 'nope'],
    ['array', [{ id: 'a' }]],
  ])('rejects a non-object JSON root (%s) with the file path', (label, root) => {
    const path = writeAccounts(`root-${label}.json`, root);
    expect(() => loadAccountRegistry(path)).toThrow(path);
  });

  it('rejects a present provider value that is not an array', () => {
    const path = writeAccounts('wrong-type-provider.json', { claude: {} });
    expect(() => loadAccountRegistry(path)).toThrow(path);
  });

  it('tolerates unknown top-level keys and warns while dropping id-less rows', () => {
    const path = writeAccounts('unknowns.json', {
      _doc: 'documentation', _doc_codex: 'documentation', foo: { future: true },
      claude: [{ configDir: '/tmp/no-id' }, { id: 'kept', configDir: null }],
    });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(loadAccountRegistry(path).accounts.map((account) => account.id)).toEqual(['kept']);
    expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/claude\[0\].*id/i));
  });

  it('preserves the legacy readers selection data exactly', () => {
    const path = writeAccounts('selection.json', {
      schemaVersion: 2,
      claude: [{ id: 'default', configDir: null }, { id: 'alt', configDir: '/tmp/claude', note: 'keep' }, { configDir: '/tmp/drop' }],
      codex: [{ id: 'default', codexHome: null }, { id: 'alt', codexHome: '/tmp/codex', preferUntil: '2027-01-01' }, { codexHome: '/tmp/drop' }],
    });
    const registry = loadAccountRegistry(path);
    expect(registry.accounts.filter((account) => account.provider === 'claude').map(({ id, configDir }) => ({ id, configDir })))
      .toEqual(readClaudeAccounts(path).map(({ id, configDir }) => ({ id, configDir })));
    expect(registry.accounts.filter((account) => account.provider === 'codex').map(({ id, codexHome }) => ({ id, codexHome })))
      .toEqual(readRotationAccounts(path).codex.map(({ id, codexHome }) => ({ id, codexHome })));
  });
});

describe('account registry writes', () => {
  const { tempDir } = useTempResources('heddle-account-writes-test-');

  it('round-trips an account without persisting its derived credential reference', () => {
    const path = join(tempDir(), 'round-trip.json');
    const registry = upsertAccount({ schemaVersion: 2, accounts: [] }, {
      id: 'claude-pro', provider: 'claude', harness: 'claude-code', credentialRef: 'claude:/tmp/claude-pro',
      billingClass: 'subscription-quota', tier: 'T2', configDir: '/tmp/claude-pro', loggedIn: true,
    });
    writeAccountRegistry(registry, path);
    expect(JSON.parse(readFileSync(path, 'utf8')).claude[0]).not.toHaveProperty('credentialRef');
    expect(loadAccountRegistry(path)).toEqual(registry);
  });

  it('upserts by provider and id while preserving raw top-level and row fields', () => {
    const path = join(tempDir(), 'preserve.json');
    writeFileSync(path, JSON.stringify({
      schemaVersion: 2, _doc: 'keep this', claude: [{ id: 'same', configDir: '/old', futureField: 'kept' }],
    }));
    const updated = upsertAccount(loadAccountRegistry(path), {
      id: 'same', provider: 'claude', harness: 'claude-code', credentialRef: 'claude:/new', configDir: '/new', tier: 'T1',
    });
    writeAccountRegistry(updated, path);
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    expect(raw._doc).toBe('keep this');
    expect(raw.claude).toHaveLength(1);
    expect(raw.claude[0]).toMatchObject({ id: 'same', configDir: '/new', tier: 'T1', futureField: 'kept' });
  });

  it('uses an atomic temporary file and leaves no temporary files behind', () => {
    const path = join(tempDir(), 'atomic.json');
    writeAccountRegistry({ schemaVersion: 2, accounts: [] }, path);
    expect(existsSync(path)).toBe(true);
    expect(readdirSync(tempDir()).filter((name) => name.includes('.tmp'))).toEqual([]);
  });

  it('preserves a concurrently-added row the in-memory registry never saw (upsert-only)', () => {
    const path = join(tempDir(), 'concurrent.json');
    // This process loads an empty registry...
    const loadedEarly = loadAccountRegistry(path);
    // ...then a concurrent writer adds a codex row and persists it.
    writeAccountRegistry(upsertAccount(loadAccountRegistry(path), {
      id: 'cx', provider: 'codex', harness: 'codex-cli', credentialRef: 'codex:default', codexHome: null,
    }), path);
    // This process, still holding the stale (empty) registry, adds its own claude row and writes.
    writeAccountRegistry(upsertAccount(loadedEarly, {
      id: 'cl', provider: 'claude', harness: 'claude-code', credentialRef: 'claude:default', configDir: null,
    }), path);
    // The concurrent codex row survives instead of being clobbered by the stale write.
    expect(loadAccountRegistry(path).accounts.map((account) => `${account.provider}:${account.id}`).sort())
      .toEqual(['claude:cl', 'codex:cx']);
  });
});

describe('reconcileRegistryIdentity', () => {
  const { tempDir } = useTempResources('heddle-reconcile-identity-test-');

  function registry(claudeIdentity: { accountUuid?: string; orgId?: string } = {}): AccountRegistry {
    return {
      schemaVersion: 2,
      accounts: [
        {
          id: 'claude-pro', provider: 'claude', harness: 'claude-code',
          credentialRef: 'claude:/tmp/claude-pro', configDir: '/tmp/claude-pro', ...claudeIdentity,
        },
        {
          id: 'codex-pro', provider: 'codex', harness: 'codex-cli',
          credentialRef: 'codex:/tmp/codex-pro', codexHome: '/tmp/codex-pro', notes: 'untouched',
        },
      ],
    };
  }

  it('populates fresh account and organization identities', () => {
    const result = reconcileRegistryIdentity(registry(), {
      rows: [{ id: 'claude-pro', liveIdentity: { accountUuid: 'A', organizationUuid: 'O' } }],
    });

    expect(result.changes).toEqual([{ id: 'claude-pro', accountUuid: 'A', orgId: 'O' }]);
    expect(result.warnings).toEqual([]);
    expect(result.registry.accounts[0]).toMatchObject({ accountUuid: 'A', orgId: 'O' });
  });

  it('populates accountUuid without orgId when the live organization is null', () => {
    const result = reconcileRegistryIdentity(registry(), {
      rows: [{ id: 'claude-pro', liveIdentity: { accountUuid: 'A', organizationUuid: null } }],
    });

    expect(result.changes).toEqual([{ id: 'claude-pro', accountUuid: 'A' }]);
    expect(result.changes[0]).not.toHaveProperty('orgId');
    expect(result.registry.accounts[0]).toMatchObject({ accountUuid: 'A' });
    expect(result.registry.accounts[0]).not.toHaveProperty('orgId');
  });

  it('does nothing when persisted identity already matches the live identity', () => {
    const original = registry({ accountUuid: 'A', orgId: 'O' });
    const result = reconcileRegistryIdentity(original, {
      rows: [{ id: 'claude-pro', liveIdentity: { accountUuid: 'A', organizationUuid: 'O' } }],
    });

    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.registry).toBe(original);
  });

  it('backfills orgId when accountUuid already matches', () => {
    const result = reconcileRegistryIdentity(registry({ accountUuid: 'A' }), {
      rows: [{ id: 'claude-pro', liveIdentity: { accountUuid: 'A', organizationUuid: 'O' } }],
    });

    expect(result.changes).toEqual([{ id: 'claude-pro', accountUuid: 'A', orgId: 'O' }]);
    expect(result.registry.accounts[0]).toMatchObject({ accountUuid: 'A', orgId: 'O' });
  });

  it('refuses to overwrite a conflicting persisted orgId (populate-only)', () => {
    const result = reconcileRegistryIdentity(registry({ accountUuid: 'A', orgId: 'OLD-ORG' }), {
      rows: [{ id: 'claude-pro', liveIdentity: { accountUuid: 'A', organizationUuid: 'NEW-ORG' } }],
    });

    expect(result.changes).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({ code: 'identity-conflict', id: 'claude-pro' });
    expect(result.warnings[0]!.message).toContain('OLD-ORG');
    expect(result.warnings[0]!.message).toContain('NEW-ORG');
    expect(result.registry.accounts[0]).toMatchObject({ accountUuid: 'A', orgId: 'OLD-ORG' });
  });

  it('populates a blank accountUuid but refuses a conflicting orgId in the same row', () => {
    const result = reconcileRegistryIdentity(registry({ orgId: 'OLD-ORG' }), {
      rows: [{ id: 'claude-pro', liveIdentity: { accountUuid: 'A', organizationUuid: 'NEW-ORG' } }],
    });

    // accountUuid was blank → populated; orgId differs → refused + warned, left as OLD-ORG.
    expect(result.changes).toEqual([{ id: 'claude-pro', accountUuid: 'A' }]);
    expect(result.changes[0]).not.toHaveProperty('orgId');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({ code: 'identity-conflict', id: 'claude-pro' });
    expect(result.registry.accounts[0]).toMatchObject({ accountUuid: 'A', orgId: 'OLD-ORG' });
  });

  it('refuses to overwrite a conflicting persisted accountUuid', () => {
    const result = reconcileRegistryIdentity(registry({ accountUuid: 'OLD' }), {
      rows: [{ id: 'claude-pro', liveIdentity: { accountUuid: 'NEW', organizationUuid: 'O' } }],
    });

    expect(result.changes).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({ code: 'identity-conflict', id: 'claude-pro' });
    expect(result.warnings[0]!.message).toContain('OLD');
    expect(result.warnings[0]!.message).toContain('NEW');
    expect(result.registry.accounts[0]).toMatchObject({ accountUuid: 'OLD' });
    expect(result.registry.accounts[0]).not.toHaveProperty('orgId');
  });

  it('skips a poll row without a live identity', () => {
    const original = registry({ accountUuid: 'A', orgId: 'O' });
    const result = reconcileRegistryIdentity(original, {
      rows: [{ id: 'claude-pro', liveIdentity: null }],
    });

    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.registry).toBe(original);
  });

  it('warns when a poll row has no matching claude registry account', () => {
    const original = registry();
    const result = reconcileRegistryIdentity(original, {
      rows: [{ id: 'ghost', liveIdentity: { accountUuid: 'A', organizationUuid: 'O' } }],
    });

    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([{
      code: 'no-registry-match', id: 'ghost',
      message: 'poll row id "ghost" has no matching claude registry account',
    }]);
    expect(result.registry).toBe(original);
  });

  it('leaves non-claude accounts untouched', () => {
    const original = registry();
    const codexBefore = original.accounts[1];
    const result = reconcileRegistryIdentity(original, {
      rows: [{ id: 'claude-pro', liveIdentity: { accountUuid: 'A', organizationUuid: 'O' } }],
    });

    expect(result.registry.accounts[1]).toBe(codexBefore);
    expect(result.registry.accounts[1]).toEqual(original.accounts[1]);
  });

  it('preserves sibling rows and unknown top-level keys through load, reconcile, and write', () => {
    const path = join(tempDir(), 'accounts.json');
    const codexRow = {
      id: 'codex-pro', harness: 'codex-cli', codexHome: '/tmp/codex-pro',
      notes: 'keep verbatim', futureField: { nested: true },
    };
    writeFileSync(path, JSON.stringify({
      schemaVersion: 2,
      claude: [{ id: 'claude-pro', configDir: '/tmp/claude-pro' }],
      codex: [codexRow],
      someUnknownKey: 123,
    }));

    const identity = reconcileRegistryIdentity(loadAccountRegistry(path), {
      rows: [{ id: 'claude-pro', liveIdentity: { accountUuid: 'A', organizationUuid: 'O' } }],
    });
    writeAccountRegistry(identity.registry, path);
    const raw = JSON.parse(readFileSync(path, 'utf8'));

    expect(raw.claude[0]).toMatchObject({ id: 'claude-pro', accountUuid: 'A', orgId: 'O' });
    expect(raw.codex[0]).toEqual(codexRow);
    expect(raw.someUnknownKey).toBe(123);
  });
});
