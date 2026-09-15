import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadAccountRegistry, upsertAccount, writeAccountRegistry, type Account, type AccountTier, type BillingClass } from '../accounts.js';
import { ensureSecureDir } from '../secure-fs.js';
import { loginStatus, loginIdentity } from '../health/parse.js';
import type { CliRunner, NativeProvider } from './cli-runner.js';
import type { Prompter } from './prompt.js';
import { getProvider, listEnvRepointProviders, type ProviderMatrixEntry } from '../provider-matrix.js';

const providers: readonly NativeProvider[] = ['claude', 'codex', 'cursor'];
const services: Record<NativeProvider, string> = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor' };

export interface AccountsAddDeps { prompter: Prompter; runner: CliRunner; now?: () => Date; report?: (line: string) => void; }
export interface AccountsAddSummary { added: string[]; failed: string[]; skipped: NativeProvider[]; }
// A NativeProvider ('claude'|'codex'|'cursor'), the 'custom' sentinel, or any provider-matrix key —
// validated at runtime in runAccountsAdd. (Kept as `string` because the literal union is subsumed by it.)
type AccountsAddProvider = string;

function pathFor(provider: NativeProvider, id: string, home: string = homedir()): string {
  return join(home, '.heddle', 'accounts', provider, id);
}

function envRepointHarness(entry: ProviderMatrixEntry): 'claude' | 'codex' {
  if (entry.harnessStyle === 'anthropic-compat') return 'claude';
  if (entry.harnessStyle === 'openai-compat') return 'codex';
  throw new Error(`env-repoint provider ${entry.key} has unsupported harness style ${entry.harnessStyle}`);
}

// Slice-3 onboards only the KEYED env-repoint styles (anthropic-compat -> claude, openai-compat -> codex).
// local-runtime (Ollama/LM Studio, HED-529) and browser-oauth (Gemini, HED-528) are deferred: offering
// them here would crash envRepointHarness or misroute a non-native key into the native login path.
const ENV_REPOINT_WIZARD_STYLES: ReadonlySet<ProviderMatrixEntry['harnessStyle']> = new Set(['anthropic-compat', 'openai-compat']);
function envRepointWizardSupported(entry: ProviderMatrixEntry): boolean {
  return entry.envRepoint && ENV_REPOINT_WIZARD_STYLES.has(entry.harnessStyle);
}

function validateId(id: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw new Error(`invalid account id ${JSON.stringify(id)} — use letters, digits, '.', '_', '-' (no path separators or '..')`);
  }
}

function validateEnvVarName(value: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error('that looks like a value, not a name — pass the NAME of the env var you exported');
  }
}

function validateBaseUrl(value: string): void {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported protocol');
  } catch {
    throw new Error('base URL must be an http(s) URL');
  }
}

function createIsolatedConfigDir(provider: 'claude' | 'codex', id: string, home: string = homedir()): string {
  const configPath = pathFor(provider, id, home);
  // Freshness is a security property for env-repoint (a stale login must not survive) — refuse an existing
  // dir rather than reuse it; ensureSecureDir then creates it 0700-from-outset and validates the whole
  // created tree (rejecting a symlink / foreign-owned / group-or-other-writable path) — F8/HED-590.
  if (existsSync(configPath)) throw new Error(`isolated config directory already exists for ${provider} ${id}`);
  ensureSecureDir(configPath, { mode: 0o700 });
  // Defense-in-depth for the check-then-create window between existsSync and ensureSecureDir: ensureSecureDir
  // ACCEPTS (never chmods) an existing safe dir, so a same-uid dir raced in after the existsSync could carry a
  // stale .credentials.json. A cross-uid or symlinked race is already rejected by ensureSecureDir; refusing a
  // raced-in NON-empty dir collapses the residual to a harmless empty dir. The runtime backstop stays the
  // harness-side hard-fail-on-empty-token (see below); this is setup-time freshness hardening (F8/HED-590).
  if (readdirSync(configPath).length !== 0) throw new Error(`isolated config directory is not fresh (non-empty) for ${provider} ${id}`);
  return configPath;
}

// Ambient Anthropic credentials that outrank or short-circuit the per-account /login credential in the
// documented auth-precedence chain: if any is inherited from the operator's shell (an env-repoint
// ANTHROPIC_BASE_URL would even aim the native OAuth flow at a gateway), `claude auth login` and
// `auth status` would resolve THAT identity instead of the isolated CLAUDE_CONFIG_DIR — so onboarding
// could silently accept, and record loggedIn against, an inherited account (HED-585). Stripped on the
// claude onboarding path only; codex's OPENAI_* surface is a separate audit. Denylist of the documented
// precedence vars; an allowlist rebuild of the env is the harder-edged follow-up.
const CLAUDE_AMBIENT_CRED_VARS = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_PROFILE',
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_FEDERATION_RULE_ID', 'ANTHROPIC_ORGANIZATION_ID',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
] as const;

// claude/codex isolate an account with a per-account dir + config-dir env var. cursor uses the
// MACHINE login (its per-account isolation is undocumented — HED-503): no dir, and it records
// keyFile:null, which is exactly the machine-login row rotation.pickCursorAccount selects (a non-null
// keyFile would be misread as an API-key file by readCursorKey and the account would be unusable).
function accountEnv(provider: NativeProvider, configPath: string | null): NodeJS.ProcessEnv {
  if (provider === 'claude' && configPath) {
    // Copy process.env first, then strip the ambient creds from the COPY — never mutate process.env.
    // Match keys case-INSENSITIVELY: Windows env var names are case-insensitive, and the copied object
    // can retain a mixed-case spelling (e.g. anthropic_api_key) that a fixed-case delete would miss.
    const strip = new Set<string>(CLAUDE_AMBIENT_CRED_VARS.map((name) => name.toUpperCase()));
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: configPath };
    for (const key of Object.keys(env)) {
      if (strip.has(key.toUpperCase())) delete env[key];
    }
    return env;
  }
  if (provider === 'codex' && configPath) return { ...process.env, CODEX_HOME: configPath };
  return { ...process.env };
}

function makeAccount(provider: NativeProvider, id: string, configPath: string | null, tier: AccountTier, billingClass: BillingClass): Account {
  const base = { id, provider, harness: provider === 'claude' ? 'claude-code' : provider === 'codex' ? 'codex-cli' : 'cursor-agent', credentialRef: `${provider}:${configPath ?? 'default'}`, billingClass, tier };
  if (provider === 'claude') return { ...base, configDir: configPath };
  if (provider === 'codex') return { ...base, codexHome: configPath };
  return { ...base, keyFile: null };
}

async function addOne(provider: NativeProvider, deps: AccountsAddDeps, ordinal: number, registryPath: string, summary: AccountsAddSummary, home: string = homedir()): Promise<void> {
  const id = await deps.prompter.text(`Account id for ${services[provider]}`, `${provider}-${ordinal}`);
  // Confine the id — it becomes a path segment under ~/.heddle/accounts, so reject path separators
  // and traversal (must start alphanumeric; letters/digits/'.'/'_'/'-' only).
  validateId(id);
  // cursor uses the machine login (no per-account dir); claude/codex isolate under a per-account dir.
  const configPath = provider === 'cursor' ? null : pathFor(provider, id, home);
  const env = accountEnv(provider, configPath);
  if (configPath) {
    // `claude auth login` persists .credentials.json here, so create it 0700-from-outset (or re-validate an
    // existing owner-only dir) via the shared secure-fs primitive — rejecting a symlink / foreign-owned /
    // group-or-other-writable path rather than trusting it (F8/HED-590). Refuse-closed on an unsafe path
    // fails just THIS account (like the env-repoint path), never aborts the whole wizard.
    try {
      ensureSecureDir(configPath, { mode: 0o700 });
    } catch (error) {
      summary.failed.push(id);
      deps.report?.(`FAIL ${provider} ${id} (config dir: ${error instanceof Error ? error.message : String(error)})`);
      return;
    }
  }
  try {
    deps.runner.login(provider, env);
  } catch (error) {
    // A cancelled or failed vendor login must not abort the whole wizard — record FAIL and move on.
    summary.failed.push(id);
    deps.report?.(`FAIL ${provider} ${id} (login: ${error instanceof Error ? error.message : String(error)})`);
    return;
  }
  // Record-only (billing ENFORCEMENT is owned by HED-395): a paid native-login account is
  // subscription-quota; a declared free account is recorded as free-tier. The tier is independent.
  const billing = await deps.prompter.select(`${services[provider]} billing`, ['free', 'paid']);
  const billingClass: BillingClass = billing === 'paid' ? 'subscription-quota' : 'free-tier';
  const tier = await deps.prompter.select(`${services[provider]} plan tier`, ['T0', 'T1', 'T2', 'T3']) as AccountTier;
  let registry = loadAccountRegistry(registryPath);
  const account = makeAccount(provider, id, configPath, tier, billingClass);
  let probe;
  try { probe = deps.runner.status(provider, env); } catch (error) { probe = { stdout: '', stderr: String(error), exitCode: null, timedOut: false }; }
  // loginStatus returns boolean | undefined; `=== true` deliberately treats an indeterminate probe
  // as not-logged-in (not a redundant boolean compare — Codacy 1cc5654).
  const loggedIn = probe.exitCode === 0 && loginStatus(probe.stdout, probe.stderr) === true;
  registry = upsertAccount(registry, { ...account, loggedIn, lastVerified: (deps.now ?? (() => new Date()))().toISOString() });
  // secureWriteFile fails CLOSED on an unsafe registry parent/target (a group-or-other-writable ~/.heddle, or
  // a symlinked/foreign accounts.json). The config-dir precheck validates the config dir and its ancestors but
  // NOT accounts.json itself, and cursor has no config-dir precheck at all — so this refusal can reach here
  // after a successful login. Record a per-account FAIL rather than aborting the whole wizard, matching the
  // config-dir and login handlers above (F8/HED-590).
  try {
    writeAccountRegistry(registry, registryPath);
  } catch (error) {
    summary.failed.push(id);
    deps.report?.(`FAIL ${provider} ${id} (registry: ${error instanceof Error ? error.message : String(error)})`);
    return;
  }
  // Surface the signed-in identity so the operator can confirm the browser step landed on the intended
  // account (claude only — from the verified `auth status --json` identity schema; HED-585).
  const identity = loggedIn && provider === 'claude' ? loginIdentity(probe.stdout) : undefined;
  (loggedIn ? summary.added : summary.failed).push(id);
  deps.report?.(`${loggedIn ? 'PASS' : 'FAIL'} ${provider} ${id}${identity ? ` — ${identity}` : ''}`);
}

async function envRepointBaseUrl(entry: ProviderMatrixEntry, deps: AccountsAddDeps): Promise<{ baseUrl: string; region?: string }> {
  let region: string | undefined;
  if (entry.key === 'glm') {
    region = await deps.prompter.select('GLM region', ['global', 'china']);
  } else if (entry.key === 'qwen') {
    region = await deps.prompter.text('Qwen region/workspace');
    if (!region) throw new Error('Qwen region/workspace is required');
  }
  // Never offer the global default once a non-global region is chosen — otherwise the saved region and
  // endpoint can disagree (codeant #128). For a non-global region the operator must supply the URL.
  const urlDefault = region && region !== 'global' ? undefined : entry.baseUrl;
  const baseUrl = await deps.prompter.text(`${entry.displayName} base URL`, urlDefault);
  validateBaseUrl(baseUrl);
  return { baseUrl, ...(region === undefined ? {} : { region }) };
}

/** Add an env-repoint account without invoking a native harness login or status probe. */
export async function addEnvRepointOne(
  entry: ProviderMatrixEntry, deps: AccountsAddDeps, ordinal: number, registryPath: string, summary: AccountsAddSummary, home: string = homedir(),
): Promise<void> {
  if (!entry.envRepoint) throw new Error(`${entry.key} is not an env-repoint provider`);
  const id = await deps.prompter.text(`Account id for ${entry.displayName}`, `${entry.key}-${ordinal}`);
  validateId(id);
  const provider = envRepointHarness(entry);
  // Never clobber a different existing account: env-repoint accounts share the provider namespace
  // (claude/codex) with native accounts, so a colliding id would upsert-replace one and silently drop
  // its credentials (codeant #179). Fail this account instead of overwriting.
  if (loadAccountRegistry(registryPath).accounts.some((account) => account.provider === provider && account.id === id)) {
    summary.failed.push(id);
    deps.report?.(`FAIL ${entry.key} ${id} (id already used by an existing ${provider} account — choose another)`);
    return;
  }
  const { baseUrl, region } = await envRepointBaseUrl(entry, deps);
  const authTokenRef = await deps.prompter.text(
    `Which environment variable holds your ${entry.displayName} key? (a NAME you have exported, e.g. ZAI_API_KEY — not the key itself)`,
  );
  validateEnvVarName(authTokenRef);
  if (!process.env[authTokenRef]) {
    summary.failed.push(id);
    deps.report?.(`FAIL ${entry.key} ${id} (export ${authTokenRef} and re-run)`);
    return;
  }
  if (entry.trainsOnInputs && !await deps.prompter.confirm(
    `${entry.displayName} trains on inputs — only route code you're permitted to share. Continue?`, false,
  )) {
    deps.report?.(`SKIP ${entry.key} ${id} (declined trains-on-inputs)`);
    return;
  }
  const billing = await deps.prompter.select(`${entry.displayName} billing`, ['free', 'paid']);
  const billingClass: BillingClass = billing === 'paid' ? 'subscription-quota' : 'free-tier';
  const tier = await deps.prompter.select(`${entry.displayName} plan tier`, ['T0', 'T1', 'T2', 'T3']) as AccountTier;
  // A pre-existing (possibly non-empty) isolated dir must not be reused — freshness is a security
  // property (a stale login must not survive) — but a collision is a per-account failure, not a
  // reason to abort the whole wizard (an interrupted prior run can leave the dir behind).
  let configPath: string;
  try {
    configPath = createIsolatedConfigDir(provider, id, home);
  } catch (error) {
    summary.failed.push(id);
    deps.report?.(`FAIL ${entry.key} ${id} (${error instanceof Error ? error.message : String(error)})`);
    return;
  }
  // On macOS, Claude login lives in Keychain and per-config-dir Keychain isolation is UNVERIFIED.
  // This empty dir complements consumer-side hard-fail-on-empty-token; it is not sufficient alone.
  const account: Account = {
    id, provider, harness: provider === 'claude' ? 'claude-code' : 'codex-cli',
    credentialRef: `${provider}:${entry.key}:${configPath}`, billingClass, tier,
    envRepoint: { baseUrl, authTokenRef, service: entry.key },
    ...(provider === 'claude' ? { configDir: configPath } : { codexHome: configPath }),
    ...(region === undefined ? {} : { region }),
    ...(entry.trainsOnInputs ? { trainsOnInputs: true } : {}),
  };
  const registry = upsertAccount(loadAccountRegistry(registryPath), account);
  writeAccountRegistry(registry, registryPath);
  summary.added.push(id);
  deps.report?.(`ADDED ${entry.key} ${id}`);
}

function customService(name: string): string {
  const service = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!service) throw new Error('custom provider display name must contain letters or digits');
  if (getProvider(service)) throw new Error(`custom provider service ${service} collides with matrix provider key`);
  return service;
}

async function addCustomProvider(deps: AccountsAddDeps, registryPath: string, summary: AccountsAddSummary, home: string = homedir()): Promise<void> {
  const displayName = await deps.prompter.text('Custom provider display name');
  const service = customService(displayName);
  const style = await deps.prompter.select('Custom provider API style', ['openai-compatible', 'anthropic-compatible', 'custom']);
  const baseUrl = await deps.prompter.text('Custom provider base URL');
  validateBaseUrl(baseUrl);
  const authTokenRef = await deps.prompter.text('Which environment variable holds your custom provider key? (a NAME you have exported, not the key itself)');
  validateEnvVarName(authTokenRef);
  const modelIds = await deps.prompter.text('Custom provider model IDs');
  const usageEndpoint = await deps.prompter.text('Optional balance/usage endpoint');
  const billing = await deps.prompter.select('Custom provider billing', ['free', 'paid']);
  const trainsOnInputs = await deps.prompter.confirm('Does this provider train on inputs?', false);
  if (trainsOnInputs && !await deps.prompter.confirm(
    `${displayName} trains on inputs — only route code you're permitted to share. Continue?`, false,
  )) {
    deps.report?.(`SKIP ${service} (declined trains-on-inputs)`);
    return;
  }
  const provider = style === 'anthropic-compatible' ? 'claude' : 'codex';
  const id = await deps.prompter.text(`Account id for ${displayName}`, `${service}-1`);
  validateId(id);
  // Never clobber a different existing account through a colliding id (codeant #179; see addEnvRepointOne).
  if (loadAccountRegistry(registryPath).accounts.some((account) => account.provider === provider && account.id === id)) {
    summary.failed.push(id);
    deps.report?.(`FAIL ${service} ${id} (id already used by an existing ${provider} account — choose another)`);
    return;
  }
  if (!process.env[authTokenRef]) {
    summary.failed.push(id);
    deps.report?.(`FAIL ${service} ${id} (export ${authTokenRef} and re-run)`);
    return;
  }
  const tier = await deps.prompter.select('Custom provider plan tier', ['T0', 'T1', 'T2', 'T3']) as AccountTier;
  // Per-account freshness failure must not abort the wizard (see addEnvRepointOne).
  let configPath: string;
  try {
    configPath = createIsolatedConfigDir(provider, id, home);
  } catch (error) {
    summary.failed.push(id);
    deps.report?.(`FAIL ${service} ${id} (${error instanceof Error ? error.message : String(error)})`);
    return;
  }
  const notes = [modelIds && `models: ${modelIds}`, usageEndpoint && `usage endpoint: ${usageEndpoint}`].filter(Boolean).join('; ') || undefined;
  const account: Account = {
    id, provider, harness: provider === 'claude' ? 'claude-code' : 'codex-cli',
    credentialRef: `${provider}:${service}:${configPath}`, billingClass: billing === 'paid' ? 'subscription-quota' : 'free-tier', tier,
    envRepoint: { baseUrl, authTokenRef, service }, ...(provider === 'claude' ? { configDir: configPath } : { codexHome: configPath }),
    ...(trainsOnInputs ? { trainsOnInputs: true } : {}), ...(notes === undefined ? {} : { notes }),
  };
  writeAccountRegistry(upsertAccount(loadAccountRegistry(registryPath), account), registryPath);
  summary.added.push(id);
  deps.report?.(`ADDED ${service} ${id}`);
}

/** Data-driven provider loop; each account persists before the next question. */
export async function runAccountsAdd(
  opts: { provider?: AccountsAddProvider; registryPath?: string; homeDir?: string }, deps: AccountsAddDeps,
): Promise<AccountsAddSummary> {
  // Single install root: the registry AND the per-account credential dirs both derive from `home`, so
  // `heddle setup --home <dir>` yields a self-contained install instead of splitting the registry from
  // the credential dirs (which otherwise default to the process user's real home). Defaults to homedir().
  const home = opts.homeDir ?? homedir();
  const registryPath = opts.registryPath ?? process.env.HEDDLE_ACCOUNTS ?? join(home, '.heddle', 'accounts.json');
  const summary: AccountsAddSummary = { added: [], failed: [], skipped: [] };
  const matrixProvider = opts.provider === undefined ? undefined : getProvider(opts.provider);
  if (opts.provider && opts.provider !== 'custom') {
    const isNative = providers.includes(opts.provider as NativeProvider);
    if (!matrixProvider && !isNative) throw new Error(`unknown accounts-add provider ${opts.provider}`);
    // A matrix key that is neither a native CLI nor a wizard-supported env-repoint style is a deferred
    // surface — refuse clearly instead of crashing envRepointHarness (local-runtime) or falling through
    // to the native login path with an undefined service name (browser-oauth: gemini/copilot/amazonq).
    if (matrixProvider && !isNative && !envRepointWizardSupported(matrixProvider)) {
      throw new Error(`accounts-add does not yet support ${opts.provider} (${matrixProvider.harnessStyle}) — see HED-528 (browser-oauth), HED-529 (local-runtime), HED-530 (OpenCode)`);
    }
  }
  const selectedEnv = matrixProvider && envRepointWizardSupported(matrixProvider) ? matrixProvider : undefined;
  for (const provider of opts.provider && !selectedEnv && opts.provider !== 'custom' ? [opts.provider as NativeProvider] : opts.provider ? [] : providers) {
    if (!await deps.prompter.confirm(`Do you have a ${services[provider]} account?`, false)) { summary.skipped.push(provider); continue; }
    let ordinal = loadAccountRegistry(registryPath).accounts.filter((account) => account.provider === provider).length + 1;
    do { await addOne(provider, deps, ordinal++, registryPath, summary, home); }
    while (await deps.prompter.confirm(`Any other ${services[provider]} accounts to cycle through?`, false));
  }
  const envProviders = selectedEnv && !selectedEnv.blocked ? [selectedEnv] : opts.provider ? [] : listEnvRepointProviders().filter((entry) => entry.wizardDefault && !entry.blocked && envRepointWizardSupported(entry));
  for (const entry of envProviders) {
    if (!await deps.prompter.confirm(`Do you have a ${entry.displayName} account?`, false)) continue;
    let ordinal = loadAccountRegistry(registryPath).accounts.filter((account) => account.envRepoint?.service === entry.key).length + 1;
    do { await addEnvRepointOne(entry, deps, ordinal++, registryPath, summary, home); }
    while (await deps.prompter.confirm(`Any other ${entry.displayName} accounts to cycle through?`, false));
  }
  const blocked = selectedEnv?.blocked ? [selectedEnv] : opts.provider ? [] : listEnvRepointProviders().filter((entry) => entry.blocked && envRepointWizardSupported(entry));
  for (const entry of blocked) {
    deps.report?.(`COMING ${entry.displayName}: ${entry.blocked!.reason}`);
    if (!await deps.prompter.confirm(`I already have a working ${entry.displayName} key — add it anyway?`, false)) continue;
    let ordinal = loadAccountRegistry(registryPath).accounts.filter((account) => account.envRepoint?.service === entry.key).length + 1;
    do { await addEnvRepointOne(entry, deps, ordinal++, registryPath, summary, home); }
    while (await deps.prompter.confirm(`Any other ${entry.displayName} accounts to cycle through?`, false));
  }
  if (opts.provider === 'custom' || !opts.provider && await deps.prompter.confirm('Any provider/key/model not listed?', false)) await addCustomProvider(deps, registryPath, summary, home);
  // Write a valid empty registry when nothing was recorded (all declined, or every attempt failed). This
  // write can hit the same unsafe-~/.heddle refusal as the per-account writes — report it rather than let an
  // uncaught throw abort the wizard after the per-account failures were already handled gracefully (F8/HED-590).
  if (!loadAccountRegistry(registryPath).accounts.length) {
    try {
      writeAccountRegistry({ schemaVersion: 2, accounts: [] }, registryPath);
    } catch (error) {
      deps.report?.(`FAIL (registry: ${error instanceof Error ? error.message : String(error)})`);
    }
  }
  return summary;
}
