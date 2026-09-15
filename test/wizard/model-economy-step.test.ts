import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeEconomyPolicy, modelEconomyStep } from '../../src/wizard/model-economy-step.js';
import { ScriptedPrompter } from '../../src/wizard/prompt.js';
import type { WizardContext, WizardIO } from '../../src/wizard/step.js';
import { useTempResources } from '../helpers.js';

describe('modelEconomyStep', () => {
  const { track } = useTempResources('heddle-model-economy-step-test-');

  function home(): string {
    const homeDir = mkdtempSync(join(tmpdir(), 'heddle-model-economy-step-test-'));
    track(homeDir);
    return homeDir;
  }

  function writePriorPolicy(homeDir: string, policy: unknown): string {
    const policyDir = join(homeDir, '.heddle', 'policy');
    mkdirSync(policyDir, { recursive: true });
    const file = join(policyDir, 'model-economy.json');
    writeFileSync(file, typeof policy === 'string' ? policy : JSON.stringify(policy));
    return file;
  }

  function context(homeDir: string): WizardContext {
    return { homeDir, now: () => new Date(0), results: new Map() };
  }

  function io(answers: unknown[], captured: string[]): WizardIO {
    return { prompter: new ScriptedPrompter(answers), report: (line) => captured.push(line) };
  }

  it('accepts all defaults, writes the full seed policy, and echoes every choice', async () => {
    const homeDir = home();
    const result = await modelEconomyStep.run(context(homeDir), io(['', '', true, '', '', '', true], []));

    expect(result).toMatchObject({ id: 'model-economy', status: 'done' });
    expect(result.summary).toContain('claude-opus-4-8[1m]@high');
    expect(result.summary).toContain('R → claude-fable-5@max');
    expect(result.summary).toContain('model pins on');
    expect(JSON.parse(readFileSync(join(homeDir, '.heddle', 'policy', 'model-economy.json'), 'utf8'))).toEqual({
      version: 1,
      default: { model: 'claude-opus-4-8[1m]', effort: 'high' },
      premium: { agents: ['R'], model: 'claude-fable-5', effort: 'max' },
      modelPins: true,
    });
  });

  it('records and echoes explicit non-default choices', async () => {
    const homeDir = home();
    const result = await modelEconomyStep.run(
      context(homeDir),
      io(['claude-sonnet', 'medium', true, 'Y, Z', 'claude-premium', 'low', false], []),
    );

    expect(result).toMatchObject({ id: 'model-economy', status: 'done' });
    expect(result.summary).toContain('claude-sonnet@medium');
    expect(result.summary).toContain('Y,Z → claude-premium@low');
    expect(result.summary).toContain('model pins off');
    expect(JSON.parse(readFileSync(join(homeDir, '.heddle', 'policy', 'model-economy.json'), 'utf8'))).toMatchObject({
      default: { model: 'claude-sonnet', effort: 'medium' },
      premium: { agents: ['Y', 'Z'], model: 'claude-premium', effort: 'low' },
      modelPins: false,
    });
  });

  it('allows opting out of premium agents while retaining a complete premium policy', async () => {
    const homeDir = home();
    const result = await modelEconomyStep.run(context(homeDir), io(['', '', false, true], []));

    expect(result).toMatchObject({ id: 'model-economy', status: 'done' });
    expect(result.summary).toContain('premium none');
    expect(JSON.parse(readFileSync(join(homeDir, '.heddle', 'policy', 'model-economy.json'), 'utf8'))).toMatchObject({
      premium: { agents: [], model: 'claude-fable-5', effort: 'max' },
    });
  });

  it('under --dry-run reports intent, prompts for nothing, and writes no policy file', async () => {
    const homeDir = home();
    const captured: string[] = [];
    const result = await modelEconomyStep.run({ ...context(homeDir), dryRun: true }, io([], captured));

    expect(result).toEqual({
      id: 'model-economy', status: 'skipped', summary: 'dry-run — model-economy prompting and policy write skipped',
    });
    expect(captured.join('\n')).toMatch(/dry-run/i);
    expect(existsSync(join(homeDir, '.heddle', 'policy', 'model-economy.json'))).toBe(false);
  });

  it('merge-preserves unknown top-level and nested fields on a rerun', async () => {
    const homeDir = home();
    const file = writePriorPolicy(homeDir, {
      version: 1,
      keep: 'top-level',
      default: { model: 'old', effort: 'low', keep: 'nested' },
      premium: { agents: ['R'], model: 'old-premium', effort: 'medium' },
      modelPins: true,
    });

    await modelEconomyStep.run(context(homeDir), io(['new', 'high', false, false], []));

    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      version: 1,
      keep: 'top-level',
      default: { model: 'new', effort: 'high', keep: 'nested' },
      premium: { agents: [], model: 'old-premium', effort: 'medium' },
      modelPins: false,
    });
  });

  it.each([
    '{ not json',
    JSON.stringify({ version: 1, premium: { agents: 'R' } }),
    JSON.stringify({ version: 1, modelPins: 'yes' }),
    JSON.stringify({ version: 2 }),
    JSON.stringify({ version: '1' }),
  ])('fails loudly on a corrupt policy without overwriting its bytes', async (raw) => {
    const homeDir = home();
    const file = writePriorPolicy(homeDir, raw);

    const result = await modelEconomyStep.run(context(homeDir), io([], []));

    expect(result).toMatchObject({ id: 'model-economy', status: 'failed' });
    // The summary names why it is corrupt (the thrown reason), then how to recover.
    expect(result.summary).toMatch(/corrupt: .+ — fix or remove /);
    expect(readFileSync(file, 'utf8')).toBe(raw);
  });
});

describe('computeEconomyPolicy', () => {
  it('maps a decision into the full policy shape', () => {
    expect(computeEconomyPolicy({
      defaultModel: 'default-model', defaultEffort: 'high',
      premiumAgents: ['R'], premiumModel: 'premium-model', premiumEffort: 'max', modelPins: true,
    })).toEqual({
      version: 1,
      default: { model: 'default-model', effort: 'high' },
      premium: { agents: ['R'], model: 'premium-model', effort: 'max' },
      modelPins: true,
    });
  });

  it('merges into a prior policy while preserving unknown top-level and nested fields', () => {
    expect(computeEconomyPolicy({
      defaultModel: 'new-default', defaultEffort: 'high',
      premiumAgents: ['Y'], premiumModel: 'new-premium', premiumEffort: 'max', modelPins: false,
    }, {
      version: 0,
      keep: 'top-level',
      default: { model: 'old-default', effort: 'low', keepDefault: true },
      premium: { agents: ['R'], model: 'old-premium', effort: 'medium', keepPremium: true },
      modelPins: true,
    })).toEqual({
      version: 1,
      keep: 'top-level',
      default: { model: 'new-default', effort: 'high', keepDefault: true },
      premium: { agents: ['Y'], model: 'new-premium', effort: 'max', keepPremium: true },
      modelPins: false,
    });
  });
});
