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
 * `email:<address>`.
 *
 * Where the sources can't settle it, the login is unknown (null), so a caller never takes it for some
 * other login: an email paired with two or more ids; a registered folder whose row and own
 * `.claude.json` can't be the same login, however their ids and emails resolve (one of them is stale,
 * and only a live poll could say which); and a native account with no identity anywhere. An
 * env-repoint account (`envRepoint`) has no Claude login, whatever its row or folder says: it is a
 * login of its own, `account:<id>`, and neither its row nor its folder, the default one included,
 * pairs an email with an id.
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
  const byFolder = new Map<string | null, ClaudeAccount[]>();
  for (const account of accounts) {
    const folder = folderOf(account.configDir);
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), account]);
  }
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
    // An env-repoint account has no Claude login, so neither its row nor a .claude.json left in its
    // folder pairs anything.
    if (account.envRepoint) continue;
    pair(registryIdentity(account));
    pair(blobOf(folderOf(account.configDir)));
  }
  // Sessions run in the default folder whether the registry lists it or not, so its .claude.json
  // pairs too. A registry row naming it (configDir null) has settled that above: a native row paired
  // it, an env-repoint row did not.
  if (!byFolder.has(null)) pair(blobOf(null));

  /** Every login an identity could be: its account id; else the ids its email is paired with; else,
   *  paired with none, its email. */
  const couldBe = (identity: Identity): string[] => {
    if (identity.uuid) return [`uuid:${identity.uuid}`];
    if (!identity.email) return [];
    const ids = pairedIds.get(identity.email);
    return ids ? [...ids].map((id) => `uuid:${id}`) : [`email:${identity.email}`];
  };
  const keyOf = (identity: Identity): string | null => {
    const logins = couldBe(identity);
    return logins.length === 1 ? logins[0] : null;
  };
  const ofAccount = (account: ClaudeAccount): string | null => {
    if (account.envRepoint) return `account:${account.id}`;
    const registry = registryIdentity(account);
    const cached = blobOf(folderOf(account.configDir));
    if (!registry || !cached) return registry || cached ? keyOf((registry ?? cached)!) : null;
    // The registry row names the login; the folder's .claude.json can only veto it, when no login it
    // could be is one the row could be (then one of the two is stale).
    const fromCache = couldBe(cached);
    return couldBe(registry).some((login) => fromCache.includes(login)) ? keyOf(registry) : null;
  };
  const ofFolder = (configDir: string | null): string | null => {
    const folder = folderOf(configDir);
    const registered = byFolder.get(folder) ?? [];
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
