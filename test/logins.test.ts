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

  it('takes a registered account\'s login from its registry row when its .claude.json agrees or names none', () => {
    const dir = home();
    const agreeing = folder(dir, '.claude-acct2', { accountUuid: 'LOGIN-2', emailAddress: 'two@x.com' });
    const blank = folder(dir, '.claude-acct4');
    const acct2: ClaudeAccount = { id: 'acct2', configDir: agreeing, accountUuid: 'LOGIN-2', email: 'two@x.com' };
    const acct4: ClaudeAccount = { id: 'acct4', configDir: blank, accountUuid: 'LOGIN-2' };
    const logins = loginsOf([acct2, acct4], dir);
    expect(logins.ofAccount(acct2)).toBe('uuid:LOGIN-2');
    expect(logins.ofFolder(agreeing)).toBe('uuid:LOGIN-2');
    expect(logins.ofAccount(acct4)).toBe('uuid:LOGIN-2');
  });

  it('reads the .claude.json of a registered folder that records no login, written with ~', () => {
    const dir = home();
    folder(dir, '.claude-acct2', { accountUuid: 'U2' });
    const unrecorded: ClaudeAccount = { id: 'acct2', configDir: '~/.claude-acct2' };
    expect(loginsOf([unrecorded], dir).ofAccount(unrecorded)).toBe('uuid:U2');
  });

  it('keeps an env-repoint account apart as a login of its own, but can\'t tell a native account with no identity anywhere', () => {
    const dir = home();
    const glm: ClaudeAccount = {
      id: 'glm', configDir: folder(dir, 'glm'),
      envRepoint: { baseUrl: 'https://api.example.com/anthropic', authTokenRef: 'EXAMPLE_KEY', service: 'glm' },
    };
    const blank: ClaudeAccount = { id: 'blank', configDir: folder(dir, 'blank') };
    const logins = loginsOf([glm, blank], dir);
    expect(logins.ofAccount(glm)).toBe('account:glm');
    expect(logins.ofAccount(blank)).toBeNull();
    expect(logins.named('blank')).toBeNull();
  });

  it('regression — can\'t tell a folder whose .claude.json names only an email paired elsewhere with another id', () => {
    // The default folder pairs x@example.com with U2; acct1's row says U1 while its own .claude.json holds
    // only that email. Field by field nothing differs, but the cache can only be U2: the two can't agree.
    const dir = home({ accountUuid: 'U2', emailAddress: 'x@example.com' });
    const acct1: ClaudeAccount = { id: 'acct1', configDir: folder(dir, '.claude-acct1', { emailAddress: 'x@example.com' }), accountUuid: 'U1' };
    const logins = loginsOf([acct1], dir);
    expect(logins.ofAccount(acct1)).toBeNull();
    expect(logins.ofFolder(acct1.configDir)).toBeNull();
  });

  it('takes a row and .claude.json naming one account id as one login, though their emails differ', () => {
    const dir = home();
    const acct2: ClaudeAccount = { id: 'acct2', configDir: folder(dir, '.claude-acct2', { accountUuid: 'U2', emailAddress: 'renamed@x.com' }), accountUuid: 'U2', email: 'two@x.com' };
    expect(loginsOf([acct2], dir).ofAccount(acct2)).toBe('uuid:U2');
  });

  it('regression — keeps an env-repoint account its own login whatever its row or a leftover .claude.json says, and pairs nothing from it', () => {
    const dir = home();
    const envRepoint = { baseUrl: 'https://api.example.com/anthropic', authTokenRef: 'EXAMPLE_KEY', service: 'glm' };
    // The glm folder was copied from a native one, and its row carries a native-looking identity.
    const glm: ClaudeAccount = {
      id: 'glm', configDir: folder(dir, 'glm', { accountUuid: 'U1', emailAddress: 'one@x.com' }),
      accountUuid: 'G1', email: 'one@x.com', envRepoint,
    };
    // Paired with G1 and U1 from glm, this email would be ambiguous; with glm left out it is unpaired.
    const native: ClaudeAccount = { id: 'acct1', configDir: '/accounts/acct1', email: 'one@x.com' };
    const logins = loginsOf([glm, native], dir);
    expect(logins.ofAccount(glm)).toBe('account:glm');
    expect(logins.ofFolder(glm.configDir)).toBe('account:glm');
    expect(logins.ofAccount(native)).toBe('email:one@x.com');
  });

  it('regression — pairs nothing from the default folder when an env-repoint account is registered there', () => {
    // The default folder is glm's, so the U1 its .claude.json names is no Claude login of any account's.
    // Paired anyway, x@example.com would be ambiguous between U1 and acct2's U2, and acct3 unknown.
    const dir = home({ accountUuid: 'U1', emailAddress: 'x@example.com' });
    const envRepoint = { baseUrl: 'https://api.example.com/anthropic', authTokenRef: 'EXAMPLE_KEY', service: 'glm' };
    const glm: ClaudeAccount = { id: 'glm', configDir: null, envRepoint };
    const acct2: ClaudeAccount = { id: 'acct2', configDir: '/accounts/acct2', accountUuid: 'U2', email: 'x@example.com' };
    const acct3: ClaudeAccount = { id: 'acct3', configDir: '/accounts/acct3', email: 'x@example.com' };
    const logins = loginsOf([glm, acct2, acct3], dir);
    expect(logins.ofAccount(acct3)).toBe('uuid:U2');
    expect(logins.ofFolder(null)).toBe('account:glm');
    expect(logins.named('default')).toBe('account:glm');
  });

  it('regression — can\'t tell a registered folder whose row and own .claude.json name different logins', () => {
    // One of the two is stale (a re-login the registry's populate-only reconcile left unchanged, or a
    // cloned folder's cached blob), and only a live poll could say which.
    const dir = home();
    const byId: ClaudeAccount = { id: 'acct4', configDir: folder(dir, 'by-id', { accountUuid: 'NEW' }), accountUuid: 'OLD' };
    const byEmail: ClaudeAccount = { id: 'acct5', configDir: folder(dir, 'by-email', { emailAddress: 'new@x.com' }), email: 'old@x.com' };
    const agreeing: ClaudeAccount = { id: 'acct6', configDir: folder(dir, 'agreeing', { accountUuid: 'U6', emailAddress: 'six@x.com' }), accountUuid: 'U6' };
    const logins = loginsOf([byId, byEmail, agreeing], dir);
    expect(logins.ofAccount(byId)).toBeNull();
    expect(logins.ofFolder(byId.configDir)).toBeNull();
    expect(logins.ofAccount(byEmail)).toBeNull();
    expect(logins.ofAccount(agreeing)).toBe('uuid:U6');
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

  it('matches a registered folder after ~ and a trailing slash, and the default folder through its registry row', () => {
    const dir = home({ accountUuid: 'REGISTRY' });
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
