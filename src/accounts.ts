import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DEFAULT_ACCOUNTS_PATH } from './capaware.js';
import { secureWriteFile } from './secure-fs.js';

export const ACCOUNTS_SCHEMA_VERSION = 2;

// A1/HED-395 owns this taxonomy and env.ts allow-by-class enforcement; it will import this type when it lands.
// BILLING_CLASSES is the SINGLE source of truth: the BillingClass type, isBillingClass, and every runtime
// validator (the billingClasses Set below, loadRouting) derive from this one tuple, so a class added in one
// place can never compile-pass for a typed Account while the runtime validators still reject it (qodo #165).
export const BILLING_CLASSES = ['subscription-flat', 'subscription-quota', 'free-tier', 'prepaid-credit', 'pay-per-token'] as const;
export type BillingClass = (typeof BILLING_CLASSES)[number];
export function isBillingClass(v: unknown): v is BillingClass {
  return typeof v === 'string' && (BILLING_CLASSES as readonly string[]).includes(v);
}
export type AccountTier = 'T0' | 'T1' | 'T2' | 'T3';
export type OveragePosture = 'hard-stop' | 'bounded-prepaid' | 'open-billing';

export interface AccountFences {
  readOnlyEnforceable: boolean;
  networkEnforceable: boolean;
  cwdEnforceable: boolean;
}

export interface AccountOverage {
  posture: OveragePosture;
  spendLimit?: number;
  creditsRemaining?: number;
}

export interface AccountEnvRepoint {
  baseUrl: string;
  authTokenRef: string;
  service: string;
  model?: string;
}

export interface Account {
  id: string;
  provider: 'claude' | 'codex' | 'cursor';
  harness: string;
  credentialRef: string;
  billingClass?: BillingClass;
  tier?: AccountTier;
  fences?: AccountFences;
  overage?: AccountOverage;
  envRepoint?: AccountEnvRepoint;
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
  region?: string;
  trainsOnInputs?: boolean;
  oneLoginAtATime?: boolean;
}

export interface AccountRegistry {
  schemaVersion: number;
  accounts: Account[];
}

export interface IdentityReconcileInput {
  /** Each poll row carries the configDir it was fetched from, so reconcile can refuse to write a live
   *  identity onto a row replaced under the same id mid-poll (raw string-or-null, matching the registry). */
  rows: Array<{ id: string; configDir: string | null; liveIdentity: { accountUuid: string; organizationUuid: string | null } | null }>;
}

export interface IdentityReconcileChange {
  id: string;
  accountUuid: string;
  orgId?: string;
}

export interface IdentityReconcileWarning {
  code: 'identity-conflict' | 'no-registry-match';
  id: string;
  message: string;
}

export interface IdentityReconcileResult {
  registry: AccountRegistry;
  changes: IdentityReconcileChange[];
  warnings: IdentityReconcileWarning[];
}

type Provider = Account['provider'];
/**
 * The provider identities that appear DIRECTLY as an `Account.provider` — the native harness logins
 * heddle can prove present or absent from accounts.json. Env-repoint providers (glm, groq, gemini, …)
 * are deliberately NOT here: they ride a native harness account via `envRepoint.service`
 * (provider-matrix.ts), so a routing target naming one is not registry-decidable and must not be gated
 * on account presence (HED-397 C2). Runtime mirror of `Account['provider']`, `satisfies`-checked so it
 * cannot hold a provider the type does not.
 */
export const ACCOUNT_PROVIDERS = ['claude', 'codex', 'cursor'] as const satisfies readonly Account['provider'][];
const modeledProviderSet = new Set<string>(ACCOUNT_PROVIDERS);
/** Does this routing-target provider appear directly as an `Account.provider` (a native harness login)? */
export const isAccountModeledProvider = (provider: string): boolean => modeledProviderSet.has(provider);
type Row = Record<string, unknown>;

const billingClasses = new Set<BillingClass>(BILLING_CLASSES);
const tiers = new Set<AccountTier>(['T0', 'T1', 'T2', 'T3']);
const overagePostures = new Set<OveragePosture>(['hard-stop', 'bounded-prepaid', 'open-billing']);

let atomicWriteSequence = 0;

// Atomic config writer (policy files): temp-in-the-same-directory write + rename so a file is never
// half-written, at a fixed 0600 — it no longer copies a pre-existing permissive mode onto the write
// (F8/HED-590: an already-0666 file would otherwise stay 0666). The credential REGISTRY uses
// secureWriteFile (fd-level ownership/symlink guards + validated parent); this stays for the
// non-credential policy files under ~/.heddle/policy.
export function atomicWriteFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${atomicWriteSequence++}.tmp`);
  try {
    writeFileSync(temporary, content, { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    try { if (existsSync(temporary)) unlinkSync(temporary); } catch { /* preserve original failure */ }
  }
}

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

function validateOverage(value: unknown, where: string, path: string): AccountOverage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`accounts.json at ${path}: ${where}.overage must be an object`);
  }
  const overage = value as Record<string, unknown>;
  if (typeof overage.posture !== 'string' || !overagePostures.has(overage.posture as OveragePosture)) {
    throw new Error(`accounts.json at ${path}: ${where}.overage.posture must be hard-stop, bounded-prepaid, or open-billing`);
  }
  const posture = overage.posture as OveragePosture;
  if (posture === 'bounded-prepaid') {
    if (typeof overage.spendLimit !== 'number' || !Number.isFinite(overage.spendLimit) || overage.spendLimit < 0) {
      throw new Error(`accounts.json at ${path}: ${where}.overage.spendLimit must be a finite number >= 0 for bounded-prepaid`);
    }
    if (typeof overage.creditsRemaining !== 'number' || !Number.isFinite(overage.creditsRemaining) || overage.creditsRemaining < 0) {
      throw new Error(`accounts.json at ${path}: ${where}.overage.creditsRemaining must be a finite number >= 0 for bounded-prepaid`);
    }
    return { posture, spendLimit: overage.spendLimit, creditsRemaining: overage.creditsRemaining };
  }
  if (overage.spendLimit !== undefined || overage.creditsRemaining !== undefined) {
    throw new Error(`accounts.json at ${path}: ${where}.overage spendLimit and creditsRemaining apply only to bounded-prepaid`);
  }
  return { posture };
}

export function validateEnvRepoint(value: unknown, where: string, path: string): AccountEnvRepoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`accounts.json at ${path}: ${where}.envRepoint must be an object`);
  }
  const envRepoint = value as Record<string, unknown>;
  if (typeof envRepoint.baseUrl !== 'string' || !envRepoint.baseUrl) {
    throw new Error(`accounts.json at ${path}: ${where}.envRepoint.baseUrl must be an http(s) URL`);
  }
  try {
    const url = new URL(envRepoint.baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('unsupported protocol');
    }
  } catch {
    throw new Error(`accounts.json at ${path}: ${where}.envRepoint.baseUrl must be an http(s) URL`);
  }
  if (typeof envRepoint.authTokenRef !== 'string' || !envRepoint.authTokenRef) {
    throw new Error(`accounts.json at ${path}: ${where}.envRepoint.authTokenRef must be a non-empty string (an env-var name or keychain ref, never the token)`);
  }
  if (typeof envRepoint.service !== 'string' || !envRepoint.service) {
    throw new Error(`accounts.json at ${path}: ${where}.envRepoint.service must be a non-empty string (the env-repoint provider key)`);
  }
  if (envRepoint.model !== undefined && (typeof envRepoint.model !== 'string' || !envRepoint.model)) {
    throw new Error(`accounts.json at ${path}: ${where}.envRepoint.model must be a non-empty string`);
  }
  return {
    baseUrl: envRepoint.baseUrl,
    authTokenRef: envRepoint.authTokenRef,
    service: envRepoint.service,
    ...(typeof envRepoint.model === 'string' ? { model: envRepoint.model } : {}),
  };
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
  const overage = row.overage === undefined ? undefined : validateOverage(row.overage, where, path);
  const envRepoint = row.envRepoint === undefined ? undefined : validateEnvRepoint(row.envRepoint, where, path);
  const pathKey = provider === 'claude' ? 'configDir' : provider === 'codex' ? 'codexHome' : 'keyFile';
  const pathValue = normalizedPath(row, pathKey);
  const defaultHarness = provider === 'claude' ? 'claude-code' : provider === 'codex' ? 'codex-cli' : 'cursor-agent';
  const notes = optionalString(row, 'notes') ?? optionalString(row, 'note');
  const account: Account = {
    id: row.id as string,
    provider,
    harness: typeof row.harness === 'string' && row.harness ? row.harness : defaultHarness,
    credentialRef: envRepoint ? `${provider}:${envRepoint.service}:${pathValue ?? 'default'}` : `${provider}:${pathValue ?? 'default'}`,
    ...(billingClass === undefined ? {} : { billingClass }),
    ...(tier === undefined ? {} : { tier }),
    ...(fences === undefined ? {} : { fences }),
    ...(overage === undefined ? {} : { overage }),
    ...(envRepoint === undefined ? {} : { envRepoint }),
    ...(optionalString(row, 'lastVerified') === undefined ? {} : { lastVerified: optionalString(row, 'lastVerified') }),
    ...(notes === undefined ? {} : { notes }),
    ...(optionalString(row, 'orgId') === undefined ? {} : { orgId: optionalString(row, 'orgId') }),
    ...(optionalString(row, 'accountUuid') === undefined ? {} : { accountUuid: optionalString(row, 'accountUuid') }),
    ...(optionalString(row, 'preferUntil') === undefined ? {} : { preferUntil: optionalString(row, 'preferUntil') }),
    ...(optionalString(row, 'email') === undefined ? {} : { email: optionalString(row, 'email') }),
    ...(typeof row.loggedIn === 'boolean' ? { loggedIn: row.loggedIn } : {}),
    ...(optionalString(row, 'region') === undefined ? {} : { region: optionalString(row, 'region') }),
    ...(typeof row.trainsOnInputs === 'boolean' ? { trainsOnInputs: row.trainsOnInputs } : {}),
    ...(typeof row.oneLoginAtATime === 'boolean' ? { oneLoginAtATime: row.oneLoginAtATime } : {}),
  };
  if (provider === 'claude') account.configDir = pathValue;
  if (provider === 'codex') account.codexHome = pathValue;
  if (provider === 'cursor') account.keyFile = pathValue;
  return account;
}

function accountsFor(raw: Record<string, unknown>, provider: Provider, path: string): Account[] {
  const values = raw[provider];
  // Absent provider → fail-soft empty, matching the legacy readers. But a PRESENT value of the wrong
  // type (e.g. `claude: {}`) is a hand-edit corruption the strict loader surfaces loudly rather than
  // hiding as empty.
  if (values === undefined) return [];
  if (!Array.isArray(values)) {
    throw new Error(`accounts.json at ${path}: "${provider}" must be an array when present (got ${JSON.stringify(values)})`);
  }
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
  // A valid JSON scalar/array/null root is still a corrupt registry (mirrors projects.ts): reject it
  // loudly here so a `null` root does not throw an opaque TypeError below and a string/array root does
  // not silently read as an empty registry.
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`accounts.json at ${path}: must be a JSON object (got ${JSON.stringify(raw)})`);
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
    // Single source of truth for the native provider set (shared with isAccountModeledProvider); order
    // preserved (claude, codex, cursor) so the concatenation is byte-identical to the prior spread.
    accounts: ACCOUNT_PROVIDERS.flatMap((provider) => accountsFor(raw, provider, path)),
  };
}

/** Replace an account by its stable provider/id identity without duplicating it. */
export function upsertAccount(registry: AccountRegistry, account: Account): AccountRegistry {
  const index = registry.accounts.findIndex((candidate) => candidate.provider === account.provider && candidate.id === account.id);
  const accounts = [...registry.accounts];
  if (index === -1) accounts.push(account);
  else accounts[index] = { ...accounts[index], ...account };
  return { schemaVersion: ACCOUNTS_SCHEMA_VERSION, accounts };
}

export function reconcileRegistryIdentity(
  registry: AccountRegistry,
  poll: IdentityReconcileInput,
): IdentityReconcileResult {
  let result = registry;
  const changes: IdentityReconcileChange[] = [];
  const warnings: IdentityReconcileWarning[] = [];
  for (const row of poll.rows) {
    if (!row.liveIdentity) continue;
    const acct = result.accounts.find((account) => account.provider === 'claude' && account.id === row.id);
    if (!acct) {
      warnings.push({ code: 'no-registry-match', id: row.id, message: 'no matching claude registry account' });
      continue;
    }
    // The live identity was fetched from the PRE-poll snapshot's credential (its configDir), but this row is
    // matched by id against the registry loaded AFTER the ~seconds-long poll. If the account was replaced
    // under the same id meanwhile (configDir changed), the polled identity belongs to the OLD credential —
    // writing it would mis-attribute it, and populate-only would make that wrong value STICKY (every later
    // poll then warns identity-conflict until a human clears it). Refuse when the configDir no longer matches
    // what we polled. Both sides derive configDir identically (raw string-or-null: normalizedPath /
    // readClaudeAccounts), so an unchanged account compares equal and is never spuriously skipped (HED-503).
    if ((acct.configDir ?? null) !== row.configDir) {
      warnings.push({ code: 'no-registry-match', id: row.id, message: 'registry account was replaced during the poll (configDir changed); identity not written' });
      continue;
    }
    const polledUuid = row.liveIdentity.accountUuid;
    const polledOrg = row.liveIdentity.organizationUuid;
    if (acct.accountUuid && acct.accountUuid !== polledUuid) {
      warnings.push({
        code: 'identity-conflict',
        id: row.id,
        message: `persisted accountUuid ${acct.accountUuid} != live ${polledUuid}; left unchanged (re-auth or fix credentialRef, then clear the stale accountUuid to re-populate)`,
      });
      continue;
    }
    // orgId is POPULATE-ONLY too: fill it when blank, but leave a DIFFERING persisted value untouched
    // (a loud conflict, never a silent overwrite — the same discipline as accountUuid above). Test with
    // TRUTHINESS, not `!= null`: optionalString yields "" for an empty-string orgId on disk, and an empty
    // orgId is unset — so it must backfill (never block) and never spuriously conflict (qodo). A null live
    // value means "not exposed this response", never "clear".
    if (polledOrg != null && acct.orgId && acct.orgId !== polledOrg) {
      warnings.push({
        code: 'identity-conflict',
        id: row.id,
        message: `persisted orgId ${acct.orgId} != live ${polledOrg}; left unchanged (clear the stale orgId to re-populate)`,
      });
    }
    const setUuid = acct.accountUuid !== polledUuid;
    const setOrg = polledOrg != null && !acct.orgId;
    if (!setUuid && !setOrg) continue;
    result = upsertAccount(result, {
      ...acct,
      accountUuid: polledUuid,
      ...(setOrg ? { orgId: polledOrg } : {}),
    });
    changes.push({
      id: row.id,
      accountUuid: polledUuid,
      ...(setOrg ? { orgId: polledOrg } : {}),
    });
  }
  return { registry: result, changes, warnings };
}

function accountRow(account: Account): Row {
  const { provider: _provider, credentialRef: _credentialRef, ...fields } = account;
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as Row;
}

function existingRaw(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/**
 * Writes the provider-keyed on-disk shape. This writer is UPSERT-ONLY — it never removes a row:
 * unknown top-level keys and matching-row fields are retained so forward-compatible metadata survives
 * a wizard rerun, and any row present on disk that this in-memory registry never saw (a concurrent
 * writer added it after we loaded) is preserved verbatim rather than clobbered. That closes the
 * data-loss window in the read-modify-write; it is not a lock — a true compare-and-swap against
 * concurrent writers is a follow-up (HED-503). A caller that must delete a row cannot use this function.
 */
export function writeAccountRegistry(
  registry: AccountRegistry,
  path: string = process.env.HEDDLE_ACCOUNTS ?? DEFAULT_ACCOUNTS_PATH,
): void {
  const raw = existingRaw(path);
  const output: Record<string, unknown> = { ...raw, schemaVersion: ACCOUNTS_SCHEMA_VERSION };
  for (const provider of ['claude', 'codex', 'cursor'] as const) {
    const priorRows = (Array.isArray(raw[provider]) ? raw[provider] : [])
      .filter((row): row is Row => Boolean(row) && typeof row === 'object' && !Array.isArray(row) && typeof row.id === 'string');
    const byId = new Map(priorRows.map((row) => [row.id as string, row]));
    const mineIds = new Set(registry.accounts.filter((account) => account.provider === provider).map((account) => account.id));
    output[provider] = [
      ...registry.accounts
        .filter((account) => account.provider === provider)
        .map((account) => ({ ...byId.get(account.id), ...accountRow(account) })),
      // A row on disk this registry never saw — a concurrent writer added it after we loaded — survives
      // verbatim (appended, not dropped), keeping the writer upsert-only.
      ...priorRows.filter((row) => !mineIds.has(row.id as string)),
    ];
  }
  // The account registry holds credential references → hardened writer: fixed 0600, fd-level
  // ownership/symlink guards, a validated euid-owned parent (created 0700 if absent). It refuses to
  // write into a group/other-WRITABLE ~/.heddle rather than silently harden a file whose parent an
  // attacker could still redirect — the misconfig, not the file mode, is the real defect (F8/HED-590).
  secureWriteFile(path, JSON.stringify(output, null, 2) + '\n');
}
