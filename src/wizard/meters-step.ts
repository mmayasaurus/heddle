import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadAccountRegistry } from '../accounts.js';
import { atomicWriteFile, policyPath } from './persist.js';
import type { WizardStep } from './step.js';

export interface MetersPolicy {
  version: 1;
  accounts: Record<string, { meters: boolean }>;
}

/**
 * Merge this run's decisions into any prior policy. Merge-preserving per the WizardStep contract
 * (step.ts: run() "Must be idempotent + merge-preserving"): an account not prompted this run — e.g.
 * one that was configured before but is no longer in the registry — keeps its saved choice, unknown
 * per-account and top-level fields carry through untouched, and only the prompted accounts change.
 * `prior` is the parsed prior policy ({} on a first run).
 */
export function computeMetersPolicy(
  decisions: { accountId: string; meters: boolean }[],
  prior: Record<string, unknown> = {},
): MetersPolicy {
  const priorAccounts = readAccountsMap(prior);
  const accounts: Record<string, { meters: boolean }> = { ...priorAccounts };
  for (const { accountId, meters } of decisions) {
    accounts[accountId] = { ...priorAccounts[accountId], meters };
  }
  return { ...prior, version: 1, accounts };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readAccountsMap(policy: Record<string, unknown>): Record<string, { meters: boolean }> {
  const { accounts } = policy;
  return isPlainObject(accounts) ? (accounts as Record<string, { meters: boolean }>) : {};
}

/**
 * Read, parse, and shape-validate an existing meters policy. Returns {} when the file is absent (a
 * first run); throws on any read/parse error, a non-object root, or a malformed `accounts` shape so
 * the caller can fail loudly rather than silently overwrite a corrupt policy — the ENOENT-vs-error
 * discipline the fleet-canon reader uses, extended to structure. A parseable-but-corrupt policy
 * (e.g. `"accounts": []`, an account entry that is not an object, or a non-boolean `meters`) must
 * force the operator to fix it, not be coerced to an empty map and clobbered on the next write.
 */
function readPriorPolicy(path: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isPlainObject(parsed)) {
    throw new Error('meters policy is not a JSON object');
  }
  const { accounts } = parsed;
  if (accounts !== undefined) {
    if (!isPlainObject(accounts)) {
      throw new Error('meters policy "accounts" is not an object');
    }
    for (const [id, entry] of Object.entries(accounts)) {
      if (!isPlainObject(entry)) {
        throw new Error(`meters policy account "${id}" is not an object`);
      }
      if ('meters' in entry && typeof entry.meters !== 'boolean') {
        throw new Error(`meters policy account "${id}" has a non-boolean "meters"`);
      }
    }
  }
  return parsed;
}

export const metersStep: WizardStep = {
  id: 'meters',
  title: 'Usage meters',
  async run(ctx, io) {
    // dry-run (`heddle setup --dry-run`): report what a real run would do, prompt for nothing, write
    // nothing — mirroring accountsStep. meters is a writing step, so preview returns 'skipped'.
    if (ctx.dryRun) {
      io.report(`dry-run — meters: a real run would prompt per meterable (native Claude) account and write the opt-in policy to ${policyPath(ctx.homeDir, 'meters')}; nothing was prompted or written.`);
      return { id: 'meters', status: 'skipped', summary: 'dry-run — meters prompting and policy write skipped' };
    }

    io.report([
      'Usage meters in the statusline read from each account\'s usage tap.',
      'They are blank until a session\'s first turn, then populate and self-heal each session.',
      'A blank meter at the start of a session is normal, not a broken tab.',
    ].join('\n'));

    // Resolve the registry exactly the way accountsStep does (accounts-add.ts): HEDDLE_ACCOUNTS wins
    // over the per-home default, so meters reads the same file accounts were just written to. Reading
    // from a hardcoded homeDir path instead would, with HEDDLE_ACCOUNTS set, meter a different (likely
    // empty) registry than the one setup populated.
    let accounts;
    try {
      accounts = loadAccountRegistry(process.env.HEDDLE_ACCOUNTS ?? join(ctx.homeDir, '.heddle', 'accounts.json')).accounts;
    } catch {
      return { id: 'meters', status: 'failed', summary: 'could not read the account registry' };
    }

    // Prompt only for accounts heddle can actually METER today. The one populated usage meter now is the
    // native Claude 5h/7d OAuth usage (keeper / `usage poll-claude` sidecar), so gate on native Claude
    // accounts: provider 'claude' AND not env-repointed. An env-repoint account uses the Claude harness
    // but routes ANTHROPIC_BASE_URL to another endpoint (GLM/Kimi), so its native Claude OAuth meter is a
    // dead/misleading toggle (see HED-574). TODO(generalize): replace this provider check with a real
    // "account has a populated usage meter" capability check, folding in codex/cursor/glm meters as they
    // become tracked (Y msg 2074 sanctioned claude-only-now + this TODO).
    const meterable = accounts.filter((account) => account.provider === 'claude' && !account.envRepoint);

    if (!meterable.length) {
      io.report(accounts.length
        ? 'no accounts with a populated usage meter yet (native Claude only today)'
        : 'no accounts to configure meters for');
      return { id: 'meters', status: 'skipped', summary: accounts.length ? 'no meterable accounts' : 'no accounts to configure' };
    }

    // Read any existing policy up front so we can (a) offer each prior choice as the prompt default and
    // (b) merge into it rather than replace it. A corrupt existing file fails loudly — never clobbered.
    const policyFile = policyPath(ctx.homeDir, 'meters');
    let prior: Record<string, unknown>;
    try {
      prior = readPriorPolicy(policyFile);
    } catch {
      return { id: 'meters', status: 'failed', summary: `existing meters policy is corrupt — fix or remove ${policyFile}` };
    }
    const priorAccounts = readAccountsMap(prior);

    const decisions: { accountId: string; meters: boolean }[] = [];
    const detailLines: string[] = [];
    for (const account of meterable) {
      const meters = await io.prompter.confirm(
        `show usage meters in the statusline for ${account.id} (${account.provider})?`,
        priorAccounts[account.id]?.meters ?? true,
      );
      decisions.push({ accountId: account.id, meters });
      detailLines.push(`${account.id} (${account.provider}): ${meters ? 'on' : 'off'}`);
    }

    const policy = computeMetersPolicy(decisions, prior);
    // Own our write via the HED-564 persist seam: atomic (temp-in-dir + rename), parent-dir-creating,
    // mode-preserving. The dry-run guard at the top of run() means this only runs for a real setup.
    try {
      atomicWriteFile(policyFile, `${JSON.stringify(policy, null, 2)}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { id: 'meters', status: 'failed', summary: `could not write the meters policy: ${message}` };
    }

    const enabled = decisions.filter(({ meters }) => meters).length;
    return {
      id: 'meters',
      status: 'done',
      summary: `usage meters enabled for ${enabled} of ${meterable.length} account(s)`,
      detail: detailLines.join('\n'),
    };
  },
};
