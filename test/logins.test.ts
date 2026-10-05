import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ClaudeAccount } from '../src/capaware.js';
import { loginKeyOf, loginNamed, loginOfConfigDir, loginOfFolder } from '../src/logins.js';
import { useTempResources } from './helpers.js';

const { tempDir } = useTempResources('heddle-logins-test-');

/** A config folder whose `.claude.json` holds `account` as its oauthAccount (undefined: no login in it). */
function folder(parent: string, name: string, account?: { accountUuid?: string; emailAddress?: string }): string {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.claude.json'), JSON.stringify(account ? { oauthAccount: account } : { numStartups: 1 }));
  return dir;
}

/** A home folder whose `.claude.json` (the default login's) holds `account`. */
function home(account?: { accountUuid?: string; emailAddress?: string }): string {
  const dir = tempDir();
  writeFileSync(join(dir, '.claude.json'), JSON.stringify(account ? { oauthAccount: account } : {}));
  return dir;
}

describe('loginOfConfigDir', () => {
  it('reads the folder\'s .claude.json, account id first, then the lower-cased email', () => {
    const parent = tempDir();
    expect(loginOfConfigDir(folder(parent, 'both', { accountUuid: 'U1', emailAddress: 'a@x.com' }))).toBe('uuid:U1');
    expect(loginOfConfigDir(folder(parent, 'email', { emailAddress: 'User@Example.com' }))).toBe('email:user@example.com');
  });

  it('reads <home>/.claude.json for the default login, never <home>/.claude/.claude.json', () => {
    const dir = home({ accountUuid: 'HOME' });
    folder(dir, '.claude', { accountUuid: 'WRONG' });
    expect(loginOfConfigDir(null, dir)).toBe('uuid:HOME');
  });

  it('is null when the file is missing, unreadable as JSON, or names no login', () => {
    const parent = tempDir();
    expect(loginOfConfigDir(join(parent, 'missing'))).toBeNull();
    const garbled = folder(parent, 'garbled');
    writeFileSync(join(garbled, '.claude.json'), 'not json');
    expect(loginOfConfigDir(garbled)).toBeNull();
    expect(loginOfConfigDir(folder(parent, 'empty'))).toBeNull();
    expect(loginOfConfigDir(folder(parent, 'blank', { accountUuid: '', emailAddress: '' }))).toBeNull();
  });
});

describe('loginKeyOf', () => {
  it('takes the registry\'s account id over its email and over the folder\'s cached .claude.json', () => {
    const configDir = folder(tempDir(), '.claude-acct2', { accountUuid: 'STALE' });
    expect(loginKeyOf({ id: 'acct2', configDir, accountUuid: 'LOGIN-2', email: 'user@x.com' })).toBe('uuid:LOGIN-2');
  });

  it('falls back to the registry email, then the folder\'s .claude.json, then the account alone', () => {
    const parent = tempDir();
    const cached = folder(parent, 'cached', { accountUuid: 'CACHED' });
    expect(loginKeyOf({ id: 'a', configDir: cached, email: 'User@X.com' })).toBe('email:user@x.com');
    expect(loginKeyOf({ id: 'a', configDir: cached })).toBe('uuid:CACHED');
    expect(loginKeyOf({ id: 'glm', configDir: folder(parent, 'glm') })).toBe('account:glm');
  });
});

describe('loginOfFolder', () => {
  it('gives a registered folder the registry\'s login, matching after ~ and a trailing slash', () => {
    const dir = home();
    const accounts: ClaudeAccount[] = [{ id: 'acct2', configDir: '~/.claude-acct2', accountUuid: 'LOGIN-2' }];
    expect(loginOfFolder(`${dir}/.claude-acct2/`, accounts, dir)).toBe('uuid:LOGIN-2');
    expect(loginOfFolder('~/.claude-acct2', accounts, dir)).toBe('uuid:LOGIN-2');
  });

  it('reads an unregistered folder\'s own .claude.json, the default folder\'s from home', () => {
    const dir = home({ accountUuid: 'LOGIN-1' });
    const accounts: ClaudeAccount[] = [{ id: 'acct1', configDir: join(dir, '.claude-acct1'), accountUuid: 'LOGIN-1' }];
    expect(loginOfFolder(null, accounts, dir)).toBe('uuid:LOGIN-1');
    expect(loginOfFolder(folder(dir, 'elsewhere', { accountUuid: 'OTHER' }), accounts, dir)).toBe('uuid:OTHER');
    expect(loginOfFolder(join(dir, 'nowhere'), accounts, dir)).toBeNull();
  });

  it('prefers the default folder\'s registry row over home\'s .claude.json', () => {
    const dir = home({ accountUuid: 'CACHED' });
    expect(loginOfFolder(null, [{ id: 'default', configDir: null, accountUuid: 'REGISTRY' }], dir)).toBe('uuid:REGISTRY');
  });

  it('needs two registry rows on one folder to agree on the login', () => {
    const dir = home();
    const agreeing: ClaudeAccount[] = [
      { id: 'a', configDir: '/accounts/dup', accountUuid: 'U' }, { id: 'b', configDir: '/accounts/dup/', accountUuid: 'U' },
    ];
    expect(loginOfFolder('/accounts/dup', agreeing, dir)).toBe('uuid:U');
    const disagreeing: ClaudeAccount[] = [
      { id: 'a', configDir: '/accounts/dup', accountUuid: 'U' }, { id: 'b', configDir: '/accounts/dup', accountUuid: 'V' },
    ];
    expect(loginOfFolder('/accounts/dup', disagreeing, dir)).toBeNull();
  });
});

describe('loginNamed', () => {
  it('names a login by account id, by "default", or by config folder', () => {
    const dir = home({ accountUuid: 'LOGIN-1' });
    const acct2 = folder(dir, '.claude-acct2', { accountUuid: 'LOGIN-2' });
    const accounts: ClaudeAccount[] = [
      { id: 'acct1', configDir: join(dir, '.claude-acct1'), accountUuid: 'LOGIN-1' },
      { id: 'acct2', configDir: acct2, accountUuid: 'LOGIN-2' },
    ];
    expect(loginNamed('acct2', accounts, dir)).toBe('uuid:LOGIN-2');
    expect(loginNamed('default', accounts, dir)).toBe('uuid:LOGIN-1');
    expect(loginNamed(acct2, accounts, dir)).toBe('uuid:LOGIN-2');
    expect(loginNamed(join(dir, 'nowhere'), accounts, dir)).toBeNull();
  });

  it('is null for "default" when the default folder holds no login', () => {
    expect(loginNamed('default', [], home())).toBeNull();
  });
});
