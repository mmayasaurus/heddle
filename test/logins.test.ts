import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ClaudeAccount } from '../src/capaware.js';
import { loginsOf } from '../src/logins.js';
import { useTempResources } from './helpers.js';

const { tempDir } = useTempResources('heddle-logins-test-');

type Blob = { accountUuid?: string; emailAddress?: string };

/** A config folder whose `.claude.json` holds `account` as its oauthAccount (undefined: no login in it). */
function folder(parent: string, name: string, account?: Blob): string {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.claude.json'), JSON.stringify(account ? { oauthAccount: account } : { numStartups: 1 }));
  return dir;
}

/** A home folder whose `.claude.json` (the default folder's) holds `account`. */
function home(account?: Blob): string {
  const dir = tempDir();
  writeFileSync(join(dir, '.claude.json'), JSON.stringify(account ? { oauthAccount: account } : {}));
  return dir;
}

describe('loginsOf — the login a folder or account draws on', () => {
  it('reads a folder the registry doesn\'t list by its .claude.json: account id first, then the lower-cased email', () => {
    const dir = home();
    const logins = loginsOf([], dir);
    expect(logins.ofFolder(folder(dir, 'both', { accountUuid: 'U1', emailAddress: 'a@x.com' }))).toBe('uuid:U1');
    expect(logins.ofFolder(folder(dir, 'email', { emailAddress: 'User@Example.com' }))).toBe('email:user@example.com');
  });

  it('reads <home>/.claude.json for the default folder, and a folder\'s own .claude.json when one is named', () => {
    const dir = home({ accountUuid: 'HOME' });
    const named = folder(dir, '.claude', { accountUuid: 'SET' });
    const logins = loginsOf([], dir);
    expect(logins.ofFolder(null)).toBe('uuid:HOME');
    expect(logins.ofFolder(named)).toBe('uuid:SET');
  });

  it('can\'t tell a folder whose .claude.json is missing, unreadable, or names no login', () => {
    const dir = home();
    const garbled = folder(dir, 'garbled');
    writeFileSync(join(garbled, '.claude.json'), 'not json');
    const logins = loginsOf([], dir);
    expect(logins.ofFolder(join(dir, 'missing'))).toBeNull();
    expect(logins.ofFolder(garbled)).toBeNull();
    expect(logins.ofFolder(folder(dir, 'empty'))).toBeNull();
    expect(logins.ofFolder(folder(dir, 'blank', { accountUuid: '', emailAddress: '' }))).toBeNull();
    expect(logins.ofFolder(null)).toBeNull();
  });

  it('takes a registered account\'s login from the registry over its folder\'s cached .claude.json', () => {
    const dir = home();
    const configDir = folder(dir, '.claude-acct2', { accountUuid: 'STALE' });
    const account: ClaudeAccount = { id: 'acct2', configDir, accountUuid: 'LOGIN-2', email: 'two@x.com' };
    const logins = loginsOf([account], dir);
    expect(logins.ofAccount(account)).toBe('uuid:LOGIN-2');
    expect(logins.ofFolder(configDir)).toBe('uuid:LOGIN-2');
  });

  it('reads the .claude.json of a registered folder that records no login, written with ~, and keeps a login-less account apart', () => {
    const dir = home();
    folder(dir, '.claude-acct2', { accountUuid: 'U2' });
    const unrecorded: ClaudeAccount = { id: 'acct2', configDir: '~/.claude-acct2' };
    const glm: ClaudeAccount = { id: 'glm', configDir: folder(dir, 'glm') };
    const logins = loginsOf([unrecorded, glm], dir);
    expect(logins.ofAccount(unrecorded)).toBe('uuid:U2');
    expect(logins.ofAccount(glm)).toBe('account:glm');
  });

  it('regression — keys one login alike when one source knows it by email and another by account id', () => {
    // The registry knows acct1 only by email; the default folder's .claude.json pairs that email with an
    // account id. Both must key as that id, or `--leaving default` could pick acct1, the login being left.
    const dir = home({ accountUuid: 'U1', emailAddress: 'one@example.com' });
    const acct1: ClaudeAccount = { id: 'acct1', configDir: join(dir, '.claude-acct1'), email: 'One@Example.com' };
    const logins = loginsOf([acct1], dir);
    expect(logins.ofAccount(acct1)).toBe('uuid:U1');
    expect(logins.ofFolder(null)).toBe('uuid:U1');
    expect(logins.named('default')).toBe(logins.named('acct1'));
  });

  it('pairs an email with an account id from any registry row or registered folder\'s .claude.json', () => {
    const dir = home();
    const accounts: ClaudeAccount[] = [
      { id: 'acct1', configDir: '/accounts/acct1', accountUuid: 'U1', email: 'one@x.com' },
      { id: 'clone', configDir: '/accounts/clone', email: 'one@x.com' },
      { id: 'acct3', configDir: folder(dir, '.claude-acct3', { accountUuid: 'U3', emailAddress: 'three@x.com' }) },
      { id: 'acct3-email', configDir: '/accounts/acct3-email', email: 'three@x.com' },
    ];
    const logins = loginsOf(accounts, dir);
    expect(accounts.map(logins.ofAccount)).toEqual(['uuid:U1', 'uuid:U1', 'uuid:U3', 'uuid:U3']);
  });

  it('can\'t tell the login of an email paired with two account ids', () => {
    const accounts: ClaudeAccount[] = [
      { id: 'a', configDir: '/accounts/a', accountUuid: 'U1', email: 'same@x.com' },
      { id: 'b', configDir: '/accounts/b', accountUuid: 'U2', email: 'same@x.com' },
      { id: 'c', configDir: '/accounts/c', email: 'same@x.com' },
    ];
    const logins = loginsOf(accounts, home());
    expect(logins.ofAccount(accounts[2])).toBeNull();
    expect(logins.ofFolder('/accounts/c')).toBeNull();
    expect(logins.named('c')).toBeNull();
  });

  it('regression — a stale .claude.json pairing an email with an old id makes that email\'s login unknown, never another login', () => {
    // acct1's own folder still caches an old id for its email; the default folder has the current one.
    // Keyed `email:one@x.com`, acct1 would read as a different login from the default folder's and could
    // be picked when leaving it; unknown, it never is.
    const dir = home({ accountUuid: 'CURRENT', emailAddress: 'one@x.com' });
    const acct1: ClaudeAccount = { id: 'acct1', configDir: folder(dir, '.claude-acct1', { accountUuid: 'OLD', emailAddress: 'one@x.com' }), email: 'one@x.com' };
    const logins = loginsOf([acct1], dir);
    expect(logins.ofAccount(acct1)).toBeNull();
    expect(logins.named('default')).toBe('uuid:CURRENT');
  });

  it('always names the default folder by "default", even beside an account with that id', () => {
    const dir = home({ accountUuid: 'CURRENT' });
    const logins = loginsOf([{ id: 'default', configDir: '/accounts/other', accountUuid: 'OTHER' }], dir);
    expect(logins.named('default')).toBe('uuid:CURRENT');
  });

  it('matches a registered folder after ~ and a trailing slash, and prefers the default folder\'s row over home\'s .claude.json', () => {
    const dir = home({ accountUuid: 'CACHED' });
    const logins = loginsOf([
      { id: 'acct2', configDir: '~/.claude-acct2', accountUuid: 'LOGIN-2' },
      { id: 'default', configDir: null, accountUuid: 'REGISTRY' },
    ], dir);
    expect(logins.ofFolder(`${dir}/.claude-acct2/`)).toBe('uuid:LOGIN-2');
    expect(logins.ofFolder('~/.claude-acct2')).toBe('uuid:LOGIN-2');
    expect(logins.ofFolder(null)).toBe('uuid:REGISTRY');
  });

  it('needs two registry rows on one folder to agree on the login', () => {
    const dir = home();
    expect(loginsOf([
      { id: 'a', configDir: '/accounts/dup', accountUuid: 'U' }, { id: 'b', configDir: '/accounts/dup/', accountUuid: 'U' },
    ], dir).ofFolder('/accounts/dup')).toBe('uuid:U');
    expect(loginsOf([
      { id: 'a', configDir: '/accounts/dup', accountUuid: 'U' }, { id: 'b', configDir: '/accounts/dup', accountUuid: 'V' },
    ], dir).ofFolder('/accounts/dup')).toBeNull();
  });

  it('names a login by account id, by "default", or by config folder', () => {
    const dir = home({ accountUuid: 'LOGIN-1' });
    const acct2 = folder(dir, '.claude-acct2', { accountUuid: 'LOGIN-2' });
    const logins = loginsOf([
      { id: 'acct1', configDir: join(dir, '.claude-acct1'), accountUuid: 'LOGIN-1' },
      { id: 'acct2', configDir: acct2, accountUuid: 'LOGIN-2' },
    ], dir);
    expect(logins.named('acct2')).toBe('uuid:LOGIN-2');
    expect(logins.named('default')).toBe('uuid:LOGIN-1');
    expect(logins.named(acct2)).toBe('uuid:LOGIN-2');
    expect(logins.named(join(dir, 'nowhere'))).toBeNull();
    expect(loginsOf([], home()).named('default')).toBeNull();
  });
});
