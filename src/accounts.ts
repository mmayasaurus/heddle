import { existsSync, readFileSync } from 'node:fs';
import { DEFAULT_ACCOUNTS_PATH } from './capaware.js';

export const ACCOUNTS_SCHEMA_VERSION = 2;

// A1/HED-395 owns this taxonomy and env.ts allow-by-class enforcement; it will import this type when it lands.
export type BillingClass = 'subscription-flat' | 'subscription-quota' | 'free-tier' | 'prepaid-credit' | 'pay-per-token';
export type AccountTier = 'T0' | 'T1' | 'T2' | 'T3';

export interface AccountFences {
  readOnlyEnforceable: boolean;
  networkEnforceable: boolean;
  cwdEnforceable: boolean;
}

export interface Account {
  id: string;
  provider: 'claude' | 'codex' | 'cursor';
  harness: string;
  credentialRef: string;
  billingClass?: BillingClass;
  tier?: AccountTier;
  fences?: AccountFences;
  lastVerified?: string;
  notes?: string;
  orgId?: string;
  accountUuid?: string;
  configDir?: string | null;
  codexHome?: string | null;
  keyFile?: string | null;
  preferUntil?: string;
  email?: string;
  loggedIn?: boolean;
}

export interface AccountRegistry {
  schemaVersion: number;
  accounts: Account[];
}

type Provider = Account['provider'];
type Row = Record<string, unknown>;

const billingClasses = new Set<BillingClass>([
  'subscription-flat', 'subscription-quota', 'free-tier', 'prepaid-credit', 'pay-per-token',
]);
const tiers = new Set<AccountTier>(['T0', 'T1', 'T2', 'T3']);

function normalizedPath(row: Row, key: 'configDir' | 'codexHome' | 'keyFile'): string | null {
  return typeof row[key] === 'string' && row[key] ? row[key] : null;
}

function optionalString(row: Row, key: string): string | undefined {
  return typeof row[key] === 'string' ? row[key] : undefined;
}

function validateFences(value: unknown, where: string, path: string): AccountFences {
  const keys = ['readOnlyEnforceable', 'networkEnforceable', 'cwdEnforceable'];
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value as object).length !== keys.length ||
      !keys.every((key) => typeof (value as Record<string, unknown>)[key] === 'boolean')) {
    throw new Error(`accounts.json at ${path}: ${where}.fences must be an object with exactly readOnlyEnforceable, networkEnforceable, and cwdEnforceable boolean keys`);
  }
  return value as AccountFences;
}

function toAccount(value: unknown, provider: Provider, index: number, path: string): Account | null {
  if (!value || typeof value !== 'object' || typeof (value as Row).id !== 'string') {
    // Deliberately diverges from projects.ts: legacy readers silently skip id-less rows, so retain
    // their selection behavior but make the data loss visible to the operator.
    process.stderr.write(`heddle: warning: accounts.json at ${path}: ${provider}[${index}] has no string id; dropped\n`);
    return null;
  }
  const row = value as Row;
  const where = `${provider}[${index}]`;
  let billingClass: BillingClass | undefined;
  if (row.billingClass !== undefined) {
    if (typeof row.billingClass !== 'string' || !billingClasses.has(row.billingClass as BillingClass)) {
      throw new Error(`accounts.json at ${path}: ${where}.billingClass is invalid (got ${JSON.stringify(row.billingClass)})`);
    }
    billingClass = row.billingClass as BillingClass;
  }
  let tier: AccountTier | undefined;
  if (row.tier !== undefined) {
    if (typeof row.tier !== 'string' || !tiers.has(row.tier as AccountTier)) {
      throw new Error(`accounts.json at ${path}: ${where}.tier is invalid (got ${JSON.stringify(row.tier)})`);
    }
    tier = row.tier as AccountTier;
  }
  const fences = row.fences === undefined ? undefined : validateFences(row.fences, where, path);
  const pathKey = provider === 'claude' ? 'configDir' : provider === 'codex' ? 'codexHome' : 'keyFile';
  const pathValue = normalizedPath(row, pathKey);
  const defaultHarness = provider === 'claude' ? 'claude-code' : provider === 'codex' ? 'codex-cli' : 'cursor-agent';
  const notes = optionalString(row, 'notes') ?? optionalString(row, 'note');
  const account: Account = {
    id: row.id as string,
    provider,
    harness: typeof row.harness === 'string' && row.harness ? row.harness : defaultHarness,
    credentialRef: `${provider}:${pathValue ?? 'default'}`,
    ...(billingClass === undefined ? {} : { billingClass }),
    ...(tier === undefined ? {} : { tier }),
    ...(fences === undefined ? {} : { fences }),
    ...(optionalString(row, 'lastVerified') === undefined ? {} : { lastVerified: optionalString(row, 'lastVerified') }),
    ...(notes === undefined ? {} : { notes }),
    ...(optionalString(row, 'orgId') === undefined ? {} : { orgId: optionalString(row, 'orgId') }),
    ...(optionalString(row, 'accountUuid') === undefined ? {} : { accountUuid: optionalString(row, 'accountUuid') }),
    ...(optionalString(row, 'preferUntil') === undefined ? {} : { preferUntil: optionalString(row, 'preferUntil') }),
    ...(optionalString(row, 'email') === undefined ? {} : { email: optionalString(row, 'email') }),
    ...(typeof row.loggedIn === 'boolean' ? { loggedIn: row.loggedIn } : {}),
  };
  if (provider === 'claude') account.configDir = pathValue;
  if (provider === 'codex') account.codexHome = pathValue;
  if (provider === 'cursor') account.keyFile = pathValue;
  return account;
}

function accountsFor(raw: Record<string, unknown>, provider: Provider, path: string): Account[] {
  const values = raw[provider];
  if (!Array.isArray(values)) return [];
  const ids = new Set<string>();
  const accounts: Account[] = [];
  for (const [index, value] of values.entries()) {
    const account = toAccount(value, provider, index, path);
    if (!account) continue;
    if (ids.has(account.id)) {
      throw new Error(`accounts.json at ${path}: duplicate ${provider} account id "${account.id}"`);
    }
    ids.add(account.id);
    accounts.push(account);
  }
  return accounts;
}

export function loadAccountRegistry(path: string = process.env.HEDDLE_ACCOUNTS ?? DEFAULT_ACCOUNTS_PATH): AccountRegistry {
  if (!existsSync(path)) return { schemaVersion: ACCOUNTS_SCHEMA_VERSION, accounts: [] };
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    const problem = error instanceof SyntaxError ? 'is not valid JSON' : 'exists but could not be read';
    throw new Error(`accounts.json at ${path}: ${problem}`);
  }
  // Deliberately diverges from projects.ts: accounts.json predates versioning, so absence is legacy
  // valid; there was never a schema version 1, while unknown future versions must fail loudly.
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== ACCOUNTS_SCHEMA_VERSION) {
    throw new Error(`accounts.json at ${path}: schemaVersion ${JSON.stringify(raw.schemaVersion)}, expected ${ACCOUNTS_SCHEMA_VERSION}`);
  }
  // Deliberately tolerate documentation and future top-level keys: real accounts.json files contain
  // _doc strings, unlike the strict project registry shape.
  return {
    schemaVersion: ACCOUNTS_SCHEMA_VERSION,
    accounts: [
      ...accountsFor(raw, 'claude', path),
      ...accountsFor(raw, 'codex', path),
      ...accountsFor(raw, 'cursor', path),
    ],
  };
}
