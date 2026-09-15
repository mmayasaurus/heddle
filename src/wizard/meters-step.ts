import { join } from 'node:path';
import { loadAccountRegistry } from '../accounts.js';
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

    if (!accounts.length) {
      io.report('no accounts to configure meters for');
      return { id: 'meters', status: 'skipped', summary: 'no accounts to configure' };
    }

    const decisions: { accountId: string; meters: boolean }[] = [];
    for (const account of accounts) {
      const meters = await io.prompter.confirm(
        `show usage meters in the statusline for ${account.id} (${account.provider})?`,
        true,
      );
      decisions.push({ accountId: account.id, meters });
    }

    const policy = computeMetersPolicy(decisions);
    // HOLD(HED-564): persist policy via ./persist.js (policyPath + atomicWriteFile) under a ctx.dryRun guard once HED-564 lands.
    void policy;

    const enabled = decisions.filter(({ meters }) => meters).length;
    return {
      id: 'meters',
      status: 'done',
      summary: `usage meters enabled for ${enabled} of ${accounts.length} account(s)`,
      detail: accounts.map((account, index) => `${account.id} (${account.provider}): ${decisions[index]!.meters ? 'on' : 'off'}`).join('\n'),
    };
  },
};
