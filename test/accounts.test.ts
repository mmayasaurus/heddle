import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readClaudeAccounts } from '../src/capaware.js';
import { loadAccountRegistry } from '../src/accounts.js';
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
      }],
    });
    expect(loadAccountRegistry(path).accounts[0]).toMatchObject({
      id: 'claude', harness: 'custom-harness', billingClass: 'subscription-flat', tier: 'T2', notes: 'legacy note',
      orgId: 'org', accountUuid: 'uuid', email: 'a@example.test', loggedIn: false,
      fences: { readOnlyEnforceable: true, networkEnforceable: false, cwdEnforceable: true },
    });
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
