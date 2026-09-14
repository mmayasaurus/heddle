import { fixtureEvalContext } from './fixture.js';
import { evaluateRules, type HookPayload } from './evaluate.js';
import { matchedRuleOutcome } from './render.js';
import type { Rule } from './schema.js';

export type PreviewOutcome = 'block' | 'nudge' | 'inject' | 'none';
export interface CasePreview { name: string; matched: boolean; outcome: PreviewOutcome; }

/** Evaluate one representative hook payload without invoking the runtime hook. */
export function previewCase(rule: Rule, payload: HookPayload): CasePreview {
  const matched = evaluateRules([rule], fixtureEvalContext(payload))[0]?.verdict === 'match';
  return { name: '', matched, outcome: matched ? matchedRuleOutcome(rule) : 'none' };
}
