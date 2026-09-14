import { describe, expect, it } from 'vitest';
import type { Prompter } from '../../src/wizard/prompt.js';
import type { WizardContext, WizardIO, WizardStep, WizardStepResult } from '../../src/wizard/step.js';

// HED-564: proves the frozen step contract is importable and a conforming step is constructible + runnable.
// Step owners (accounts/model-economy/spread/meters/rules/doctor) build their module against exactly this.

const noopPrompter = {} as Prompter; // steps under test here do not prompt

function context(overrides: Partial<WizardContext> = {}): WizardContext {
  return { homeDir: '/tmp/home', now: () => new Date('2026-01-01T00:00:00Z'), results: new Map<string, WizardStepResult>(), ...overrides };
}

describe('wizard step contract (HED-564)', () => {
  it('a conforming step runs and returns a typed result; report() emits progress', async () => {
    const step: WizardStep = {
      id: 'sample',
      title: 'Sample',
      async run(ctx, io) {
        io.report(`home ${ctx.homeDir}`);
        return { id: 'sample', status: 'done', summary: `at ${ctx.now().toISOString()}` };
      },
    };
    const lines: string[] = [];
    const io: WizardIO = { prompter: noopPrompter, report: (line) => lines.push(line) };
    const result = await step.run(context(), io);
    expect(result).toEqual({ id: 'sample', status: 'done', summary: 'at 2026-01-01T00:00:00.000Z' });
    expect(lines).toEqual(['home /tmp/home']);
  });

  it('applies() is optional and can gate a step on context', () => {
    const step: WizardStep = {
      id: 'scoped',
      title: 'Scoped',
      applies: (ctx) => ctx.targetDir !== undefined,
      async run() { return { id: 'scoped', status: 'done', summary: '' }; },
    };
    expect(step.applies?.(context())).toBe(false);
    expect(step.applies?.(context({ targetDir: '/tmp/project' }))).toBe(true);
  });

  it('a step can read a prior step result from context.results', async () => {
    const prior: WizardStepResult = { id: 'accounts', status: 'done', summary: '2 accounts' };
    const step: WizardStep = {
      id: 'reader',
      title: 'Reader',
      async run(ctx) {
        const accounts = ctx.results.get('accounts');
        return { id: 'reader', status: accounts ? 'done' : 'skipped', summary: accounts?.summary ?? 'no accounts' };
      },
    };
    const result = await step.run(context({ results: new Map([['accounts', prior]]) }), { prompter: noopPrompter, report: () => {} });
    expect(result).toMatchObject({ id: 'reader', status: 'done', summary: '2 accounts' });
  });
});
