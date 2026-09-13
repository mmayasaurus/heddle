import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadAccountRegistry, upsertAccount, writeAccountRegistry, type Account, type AccountTier, type BillingClass } from '../accounts.js';
import { loginStatus } from '../health/parse.js';
import type { CliRunner, NativeProvider } from './cli-runner.js';
import type { Prompter } from './prompt.js';

const providers: readonly NativeProvider[] = ['claude', 'codex', 'cursor'];
const services: Record<NativeProvider, string> = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor' };

export interface AccountsAddDeps { prompter: Prompter; runner: CliRunner; now?: () => Date; report?: (line: string) => void; }
export interface AccountsAddSummary { added: string[]; failed: string[]; skipped: NativeProvider[]; }

function pathFor(provider: NativeProvider, id: string): string {
  return join(homedir(), '.heddle', 'accounts', provider, id);
}

function accountEnv(provider: NativeProvider, path: string): NodeJS.ProcessEnv {
  // claude/codex isolate an account through a config-dir env var. cursor's per-account isolation
  // mechanism is undocumented (deferred to HED-503), so its login uses the default store and the
  // recorded keyFile is the INTENDED location, not a verified isolation path.
  if (provider === 'claude') return { ...process.env, CLAUDE_CONFIG_DIR: path };
  if (provider === 'codex') return { ...process.env, CODEX_HOME: path };
  return { ...process.env };
}

function makeAccount(provider: NativeProvider, id: string, path: string, tier: AccountTier, billingClass: BillingClass): Account {
  const base = { id, provider, harness: provider === 'claude' ? 'claude-code' : provider === 'codex' ? 'codex-cli' : 'cursor-agent', credentialRef: `${provider}:${path}`, billingClass, tier };
  return provider === 'claude' ? { ...base, configDir: path } : provider === 'codex' ? { ...base, codexHome: path } : { ...base, keyFile: path };
}

async function addOne(provider: NativeProvider, deps: AccountsAddDeps, ordinal: number, registryPath: string, summary: AccountsAddSummary): Promise<void> {
  const id = await deps.prompter.text(`Account id for ${services[provider]}`, `${provider}-${ordinal}`);
  const path = pathFor(provider, id);
  const env = accountEnv(provider, path);
  mkdirSync(path, { recursive: true });
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
  const account = makeAccount(provider, id, path, tier, billingClass);
  let probe;
  try { probe = deps.runner.status(provider, env); } catch (error) { probe = { stdout: '', stderr: String(error), exitCode: null, timedOut: false }; }
  // loginStatus returns boolean | undefined; `=== true` deliberately treats an indeterminate probe
  // as not-logged-in (not a redundant boolean compare — Codacy 1cc5654).
  const loggedIn = probe.exitCode === 0 && loginStatus(probe.stdout, probe.stderr) === true;
  registry = upsertAccount(registry, { ...account, loggedIn, lastVerified: (deps.now ?? (() => new Date()))().toISOString() });
  writeAccountRegistry(registry, registryPath);
  (loggedIn ? summary.added : summary.failed).push(id);
  deps.report?.(`${loggedIn ? 'PASS' : 'FAIL'} ${provider} ${id}`);
}

/** Data-driven provider loop; each account persists before the next question. */
export async function runAccountsAdd(
  opts: { provider?: NativeProvider; registryPath?: string }, deps: AccountsAddDeps,
): Promise<AccountsAddSummary> {
  const registryPath = opts.registryPath ?? process.env.HEDDLE_ACCOUNTS ?? join(homedir(), '.heddle', 'accounts.json');
  const summary: AccountsAddSummary = { added: [], failed: [], skipped: [] };
  for (const provider of opts.provider ? [opts.provider] : providers) {
    if (!await deps.prompter.confirm(`Do you have a ${services[provider]} account?`, false)) { summary.skipped.push(provider); continue; }
    let ordinal = loadAccountRegistry(registryPath).accounts.filter((account) => account.provider === provider).length + 1;
    do { await addOne(provider, deps, ordinal++, registryPath, summary); }
    while (await deps.prompter.confirm(`Any other ${services[provider]} accounts to cycle through?`, false));
  }
  if (await deps.prompter.confirm('Any provider/key/model not listed?', false)) {
    const name = await deps.prompter.text('Unlisted provider/key/model name');
    const note = await deps.prompter.text('Unlisted provider/key/model note');
    deps.report?.(`NOTE unlisted ${name}: ${note}`);
  }
  if (!loadAccountRegistry(registryPath).accounts.length) writeAccountRegistry({ schemaVersion: 2, accounts: [] }, registryPath);
  return summary;
}
