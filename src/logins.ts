import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ClaudeAccount } from './capaware.js';

/**
 * Which Claude LOGIN a config folder draws on. Two folders logged into one login share ONE usage
 * pool, so a picker that spreads load must treat them as one account (`heddle account pick
 * --leaving`).
 *
 * A login key is `uuid:<accountUuid>`: the account id the usage poll reports, the only trustworthy
 * grouping key (claude-usage.ts). What is known about a folder's login, best source first: its
 * registry row's `accountUuid` and `email` (the identity reconcile in src/accounts.ts fills a blank
 * `accountUuid` from the usage poll, and flags rather than overwrites a mismatch); for a folder the
 * registry doesn't list (the default `~/.claude`, say), or a row recording neither, the folder's own
 * `.claude.json` `oauthAccount`. That cached blob can lag a re-login on a cloned folder, which is why
 * it is only the fallback.
 *
 * A login known only by its email takes the account id that email is paired with elsewhere (a
 * registry row, or the `.claude.json` of a registered folder or of the default one, naming both), so
 * one login reads alike whichever source told it. An email nothing pairs with an id keys as
 * `email:<address>`. An email paired with two or more ids (a stale `.claude.json`, say) leaves its
 * login unknown: null, so a caller never takes it for some other login.
 */

interface Identity {
  uuid: string | null;
  /** Lower-cased. */
  email: string | null;
}

/** A config folder as CLAUDE_CONFIG_DIR names it, for exact comparison: a leading ~ expanded, then
 *  path.resolve (which collapses ./.. and any trailing slash). Deliberately NOT realpath — see the
 *  byNormalizedDir note in residents.ts. */
export function normalizeConfigDir(dir: string, home: string = homedir()): string {
  return resolve(dir === '~' ? home : dir.startsWith('~/') ? join(home, dir.slice(2)) : dir);
}

/** The login a `.claude.json` names: `<home>/.claude.json` for the default folder (null),
 *  `<folder>/.claude.json` otherwise. Read-only; null when unreadable or naming none. */
function cachedIdentity(folder: string | null, home: string): Identity | null {
  let account: unknown;
  try {
    const file = folder === null ? join(home, '.claude.json') : join(folder, '.claude.json');
    account = (JSON.parse(readFileSync(file, 'utf8')) as { oauthAccount?: unknown }).oauthAccount;
  } catch {
    return null;
  }
  if (!account || typeof account !== 'object') return null;
  const { accountUuid, emailAddress } = account as { accountUuid?: unknown; emailAddress?: unknown };
  const uuid = typeof accountUuid === 'string' && accountUuid ? accountUuid : null;
  const email = typeof emailAddress === 'string' && emailAddress ? emailAddress.toLowerCase() : null;
  return uuid || email ? { uuid, email } : null;
}

export interface Logins {
  /** The login a registered account draws on; an account nothing is known about is a login of its
   *  own. null when it can't be told. */
  ofAccount(account: ClaudeAccount): string | null;
  /** The login of the folder a session runs in, `configDir` as its CLAUDE_CONFIG_DIR reads (null =
   *  unset); null when it can't be told. */
  ofFolder(configDir: string | null): string | null;
  /** The login `--leaving` names: `default` (always the folder used when CLAUDE_CONFIG_DIR is unset),
   *  a registered account id, or a config folder as CLAUDE_CONFIG_DIR would read; null when it names
   *  no login that can be told. */
  named(name: string): string | null;
}

/** The logins of `accounts`' folders, all keyed alike. Reads each registered folder's and the default
 *  folder's `.claude.json` once, when built. */
export function loginsOf(accounts: readonly ClaudeAccount[], home: string = homedir()): Logins {
  const folderOf = (configDir: string | null) => (configDir === null ? null : normalizeConfigDir(configDir, home));
  const blobs = new Map<string | null, Identity | null>();
  const blobOf = (folder: string | null): Identity | null => {
    if (!blobs.has(folder)) blobs.set(folder, cachedIdentity(folder, home));
    return blobs.get(folder)!;
  };
  const registryIdentity = (account: ClaudeAccount): Identity | null =>
    account.accountUuid || account.email
      ? { uuid: account.accountUuid || null, email: account.email ? account.email.toLowerCase() : null }
      : null;

  const pairedIds = new Map<string, Set<string>>();
  const pair = (identity: Identity | null): void => {
    if (!identity?.uuid || !identity.email) return;
    pairedIds.set(identity.email, (pairedIds.get(identity.email) ?? new Set<string>()).add(identity.uuid));
  };
  for (const account of accounts) {
    pair(registryIdentity(account));
    pair(blobOf(folderOf(account.configDir)));
  }
  pair(blobOf(null));

  const keyOf = (identity: Identity): string | null => {
    if (identity.uuid) return `uuid:${identity.uuid}`;
    if (!identity.email) return null;
    const ids = pairedIds.get(identity.email);
    if (!ids) return `email:${identity.email}`;
    return ids.size === 1 ? `uuid:${[...ids][0]}` : null;
  };
  const ofAccount = (account: ClaudeAccount): string | null => {
    const identity = registryIdentity(account) ?? blobOf(folderOf(account.configDir));
    return identity ? keyOf(identity) : `account:${account.id}`;
  };
  const ofFolder = (configDir: string | null): string | null => {
    const folder = folderOf(configDir);
    const registered = accounts.filter((account) => folderOf(account.configDir) === folder);
    if (registered.length === 0) {
      const identity = blobOf(folder);
      return identity ? keyOf(identity) : null;
    }
    // Two registry rows for one folder must agree on the login, or it can't be told.
    const keys = new Set(registered.map(ofAccount));
    return keys.size === 1 ? [...keys][0] : null;
  };
  return {
    ofAccount,
    ofFolder,
    named(name) {
      if (name === 'default') return ofFolder(null);
      const registered = accounts.find((account) => account.id === name);
      return registered ? ofAccount(registered) : ofFolder(name);
    },
  };
}
