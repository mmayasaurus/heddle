import { join } from 'node:path';
import { loadAccountRegistry } from '../accounts.js';
import { atomicWriteFile, policyPath } from './persist.js';
import type { WizardStep } from './step.js';

export interface MetersPolicy {
  version: 1;
  accounts: Record<string, { meters: boolean }>;
}

export function computeMetersPolicy(decisions: { accountId: string; meters: boolean }[]): MetersPolicy {
  return {
    version: 1,
    accounts: Object.fromEntries(decisions.map(({ accountId, meters }) => [accountId, { meters }])),
  };
}

export const metersStep: WizardStep = {
  id: 'meters',
  title: 'Usage meters',
  async run(ctx, io) {
    // dry-run (`heddle setup --dry-run`): report what a real run would do, prompt for nothing, write
    // nothing — mirroring accountsStep. meters is a writing step, so preview returns 'skipped'.
    if (ctx.dryRun) {
      io.report('dry-run — meters: a real run would prompt per meterable (native Claude) account and write the opt-in policy to ~/.heddle/policy/meters.json; nothing was prompted or written.');
      return { id: 'meters', status: 'skipped', summary: 'dry-run — meters prompting and policy write skipped' };
    }

    io.report([
      'Usage meters in the statusline read from each account\'s usage tap.',
      'They are blank until a session\'s first turn, then populate and self-heal each session.',
      'A blank meter at the start of a session is normal, not a broken tab.',
    ].join('\n'));

    let accounts;
    try {
      accounts = loadAccountRegistry(join(ctx.homeDir, '.heddle', 'accounts.json')).accounts;
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

    const decisions: { accountId: string; meters: boolean }[] = [];
    for (const account of meterable) {
      const meters = await io.prompter.confirm(
        `show usage meters in the statusline for ${account.id} (${account.provider})?`,
        true,
      );
      decisions.push({ accountId: account.id, meters });
    }

    const policy = computeMetersPolicy(decisions);
    // Own our write via the HED-564 persist seam: atomic (temp-in-dir + rename), parent-dir-creating,
    // mode-preserving. The dry-run guard at the top of run() means this only runs for a real setup.
    atomicWriteFile(policyPath(ctx.homeDir, 'meters'), `${JSON.stringify(policy, null, 2)}\n`);

    const enabled = decisions.filter(({ meters }) => meters).length;
    return {
      id: 'meters',
      status: 'done',
      summary: `usage meters enabled for ${enabled} of ${meterable.length} account(s)`,
      detail: meterable.map((account, index) => `${account.id} (${account.provider}): ${decisions[index]!.meters ? 'on' : 'off'}`).join('\n'),
    };
  },
};
