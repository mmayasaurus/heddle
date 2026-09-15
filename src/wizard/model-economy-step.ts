import { readFileSync } from 'node:fs';
import { atomicWriteFile, policyPath } from './persist.js';
import type { WizardStep } from './step.js';

const POLICY_ID = 'model-economy';
const DEFAULT_MODEL = 'claude-opus-4-8[1m]';
const DEFAULT_EFFORT = 'high';
const PREMIUM_MODEL = 'claude-fable-5';
const PREMIUM_EFFORT = 'max';
const PREMIUM_AGENTS = ['R'];
const DEFAULT_MODEL_PINS = true;

export interface EconomyPolicy {
  version: 1;
  default: { model: string; effort: string };
  premium: { agents: string[]; model: string; effort: string };
  modelPins: boolean;
}

export interface EconomyDecision {
  defaultModel: string;
  defaultEffort: string;
  premiumAgents: string[];
  premiumModel: string;
  premiumEffort: string;
  modelPins: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asObj(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}

/**
 * Merge this run's decisions into any prior policy. Unknown top-level fields and unknown sub-fields
 * inside `default` and `premium` carry through untouched; only the values prompted in this run change.
 */
export function computeEconomyPolicy(
  decision: EconomyDecision,
  prior: Record<string, unknown> = {},
): EconomyPolicy {
  return {
    ...prior,
    version: 1,
    default: { ...asObj(prior.default), model: decision.defaultModel, effort: decision.defaultEffort },
    premium: {
      ...asObj(prior.premium),
      agents: decision.premiumAgents,
      model: decision.premiumModel,
      effort: decision.premiumEffort,
    },
    modelPins: decision.modelPins,
  };
}

/**
 * Read, parse, and shape-validate an existing model-economy policy. Returns {} only when it is absent;
 * any read, parse, root-shape, or known-field-shape failure throws so a real run never clobbers it.
 */
function readPriorEconomyPolicy(path: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }

  const parsed: unknown = JSON.parse(raw);
  if (!isPlainObject(parsed)) throw new Error('model-economy policy is not a JSON object');

  if ('default' in parsed) {
    if (!isPlainObject(parsed.default)) throw new Error('model-economy policy "default" is not an object');
    if ('model' in parsed.default && typeof parsed.default.model !== 'string') {
      throw new Error('model-economy policy "default.model" is not a string');
    }
    if ('effort' in parsed.default && typeof parsed.default.effort !== 'string') {
      throw new Error('model-economy policy "default.effort" is not a string');
    }
  }

  if ('premium' in parsed) {
    if (!isPlainObject(parsed.premium)) throw new Error('model-economy policy "premium" is not an object');
    if ('agents' in parsed.premium
      && (!Array.isArray(parsed.premium.agents) || !parsed.premium.agents.every((agent) => typeof agent === 'string'))) {
      throw new Error('model-economy policy "premium.agents" is not an array of strings');
    }
    if ('model' in parsed.premium && typeof parsed.premium.model !== 'string') {
      throw new Error('model-economy policy "premium.model" is not a string');
    }
    if ('effort' in parsed.premium && typeof parsed.premium.effort !== 'string') {
      throw new Error('model-economy policy "premium.effort" is not a string');
    }
  }

  if ('modelPins' in parsed && typeof parsed.modelPins !== 'boolean') {
    throw new Error('model-economy policy "modelPins" is not a boolean');
  }
  return parsed;
}

export const modelEconomyStep: WizardStep = {
  id: 'model-economy',
  title: 'Model economy',
  async run(ctx, io) {
    // Preview must stop before every read, prompt, or write: no real policy is observed or changed.
    if (ctx.dryRun) {
      io.report('dry-run — model-economy: a real run would prompt for the default + premium model economy and write the policy to ' + policyPath(ctx.homeDir, POLICY_ID) + '; nothing was prompted or written.');
      return { id: 'model-economy', status: 'skipped', summary: 'dry-run — model-economy prompting and policy write skipped' };
    }

    io.report('The fleet runs a default model and effort; a named premium (tail) set can ride a costlier model. Every choice below is shown back so nothing is pinned silently.');

    // Read before prompting so each saved decision remains the prompt's visible default. A malformed
    // policy fails loudly rather than being coerced and overwritten by a later atomic write.
    const file = policyPath(ctx.homeDir, POLICY_ID);
    let prior: Record<string, unknown>;
    try {
      prior = readPriorEconomyPolicy(file);
    } catch {
      return { id: 'model-economy', status: 'failed', summary: 'existing model-economy policy is corrupt — fix or remove ' + file };
    }

    const priorDefault = asObj(prior.default) as Partial<EconomyPolicy['default']>;
    const priorPremium = asObj(prior.premium) as Partial<EconomyPolicy['premium']>;
    const priorModelPins = prior.modelPins as boolean | undefined;
    const defaultModel = await io.prompter.text('default model for the fleet', priorDefault.model ?? DEFAULT_MODEL);
    const defaultEffort = await io.prompter.text('default effort', priorDefault.effort ?? DEFAULT_EFFORT);
    // An empty text answer cannot express no agents when the default is non-empty, so gate the list.
    const priorHadAgents = Array.isArray(priorPremium.agents) ? priorPremium.agents.length > 0 : true;
    const anyPremium = await io.prompter.confirm('do any agents ride a premium model?', priorHadAgents);

    let agents: string[];
    let premiumModel: string;
    let premiumEffort: string;
    if (anyPremium) {
      const agentsRaw = await io.prompter.text(
        'which agents ride the premium model? (comma-separated letters)',
        (priorPremium.agents ?? PREMIUM_AGENTS).join(','),
      );
      agents = agentsRaw.split(',').map((agent) => agent.trim()).filter(Boolean);
      premiumModel = await io.prompter.text('premium model', priorPremium.model ?? PREMIUM_MODEL);
      premiumEffort = await io.prompter.text('premium effort', priorPremium.effort ?? PREMIUM_EFFORT);
    } else {
      agents = [];
      premiumModel = priorPremium.model ?? PREMIUM_MODEL;
      premiumEffort = priorPremium.effort ?? PREMIUM_EFFORT;
    }

    const modelPins = await io.prompter.confirm('pin the model per agent?', priorModelPins ?? DEFAULT_MODEL_PINS);
    const policy = computeEconomyPolicy({
      defaultModel, defaultEffort, premiumAgents: agents, premiumModel, premiumEffort, modelPins,
    }, prior);

    // Persist through the shared atomic writer (temp-in-dir plus rename) after every decision is known.
    try {
      atomicWriteFile(file, JSON.stringify(policy, null, 2) + '\n');
    } catch (error) {
      return {
        id: 'model-economy',
        status: 'failed',
        summary: 'could not write the model-economy policy: ' + (error instanceof Error ? error.message : String(error)),
      };
    }

    return {
      id: 'model-economy',
      status: 'done',
      summary: `default ${defaultModel}@${defaultEffort}; premium ${agents.length ? `${agents.join(',')} → ${premiumModel}@${premiumEffort}` : 'none'}; model pins ${modelPins ? 'on' : 'off'}`,
      detail: [
        `default model: ${defaultModel}`,
        `default effort: ${defaultEffort}`,
        `premium agents: ${agents.length ? agents.join(',') : 'none'}`,
        `premium model: ${premiumModel}`,
        `premium effort: ${premiumEffort}`,
        `model pins: ${modelPins ? 'on' : 'off'}`,
      ].join('\n'),
    };
  },
};
