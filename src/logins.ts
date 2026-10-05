import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ClaudeAccount } from './capaware.js';

/**
 * Which Claude LOGIN a config folder draws on. Two folders logged into one login share ONE usage
 * pool, so a picker that spreads load must treat them as one account (`heddle account pick
 * --leaving`). A login key is `uuid:<accountUuid>`, or `email:<address>` when no account id is known.
 *
 * Sources, best first: the registry's `accountUuid` (the live login's id: the identity reconcile in
 * src/accounts.ts fills a blank one from the usage poll, and flags rather than overwrites a mismatch),
 * then its `email`; for a folder the registry doesn't list (the default `~/.claude`, say) the folder's
 * own `.claude.json` `oauthAccount`. That cached blob can lag a re-login on a cloned folder
 * (claude-usage.ts), which is why it is only the fallback.
 */

/** The login a config folder's `.claude.json` names: `~/.claude.json` for the default login
 *  (configDir null), `<configDir>/.claude.json` otherwise. Read-only; null when unreadable or none. */
export function loginOfConfigDir(configDir: string | null, home: string = homedir()): string | null {
  const file = configDir ? join(configDir, '.claude.json') : join(home, '.claude.json');
  let account: unknown;
  try {
    account = (JSON.parse(readFileSync(file, 'utf8')) as { oauthAccount?: unknown }).oauthAccount;
  } catch {
    return null;
  }
  if (!account || typeof account !== 'object') return null;
  const { accountUuid, emailAddress } = account as { accountUuid?: unknown; emailAddress?: unknown };
  if (typeof accountUuid === 'string' && accountUuid) return `uuid:${accountUuid}`;
  return typeof emailAddress === 'string' && emailAddress ? `email:${emailAddress.toLowerCase()}` : null;
}

/** The login a registered account draws on; an account nothing is known about stays on its own. */
export function loginKeyOf(account: ClaudeAccount, home?: string): string {
  if (account.accountUuid) return `uuid:${account.accountUuid}`;
  if (account.email) return `email:${account.email.toLowerCase()}`;
  return loginOfConfigDir(account.configDir, home) ?? `account:${account.id}`;
}

/** A config folder as CLAUDE_CONFIG_DIR names it, for exact comparison: a leading ~ expanded, then
 *  path.resolve (which collapses ./.. and any trailing slash). Deliberately NOT realpath — see the
 *  byNormalizedDir note in residents.ts. */
export function normalizeConfigDir(dir: string, home: string = homedir()): string {
  return resolve(dir === '~' ? home : dir.startsWith('~/') ? join(home, dir.slice(2)) : dir);
}

/** The login of the folder a session runs in: `configDir` as its CLAUDE_CONFIG_DIR reads (null = unset). */
export function loginOfFolder(configDir: string | null, accounts: readonly ClaudeAccount[], home: string = homedir()): string | null {
  const folder = configDir === null ? null : normalizeConfigDir(configDir, home);
  const registered = accounts.filter((account) =>
    folder === null ? account.configDir === null : account.configDir !== null && normalizeConfigDir(account.configDir, home) === folder);
  if (registered.length === 1) return loginKeyOf(registered[0], home);
  if (registered.length > 1) {
    // Two registry rows for one folder: they must agree on the login, or it can't be told.
    const keys = new Set(registered.map((account) => loginKeyOf(account, home)));
    return keys.size === 1 ? [...keys][0] : null;
  }
  return loginOfConfigDir(folder, home);
}

/**
 * The login `--leaving` names: a registered account id, `default` (the folder used when
 * CLAUDE_CONFIG_DIR is unset), or a config folder's path as CLAUDE_CONFIG_DIR would read. null when
 * it names no login that can be told.
 */
export function loginNamed(name: string, accounts: readonly ClaudeAccount[], home: string = homedir()): string | null {
  const registered = accounts.find((account) => account.id === name);
  if (registered) return loginKeyOf(registered, home);
  return loginOfFolder(name === 'default' ? null : name, accounts, home);
}
