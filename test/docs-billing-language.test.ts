import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * HED-395 acceptance #4: "docs contain no remaining 'no API keys ever' wording (test greps the docs)."
 *
 * The docs half (commit 2b9d4b8) replaced the absolutist "Subscriptions only / no API keys in any
 * execution path, ever" framing with the honest rule — NEVER METERED OVERAGE — because the code
 * already runs no-overage KEY pools (openai-compat groq/cerebras/openrouter/glm). If any doc
 * reintroduced the absolutist claim, the docs would disagree with src/env.ts's billing-class gate
 * again — the exact drift HED-395 reconciled. This grep locks the reconciliation in.
 *
 * The patterns target ONLY the removed ABSOLUTIST claims. The corrected docs still use "API key" /
 * "API billing" / "subscription" in nuanced, correct contexts (e.g. "never per-token API billing",
 * "each vendor treats an API key as a silent switch", "subscription-quota") — those MUST pass, so
 * the patterns match the specific banned phrasings, not those substrings.
 */
const DOCS = ['../README.md', '../docs/SPEC.md', '../docs/ARCHITECTURE.md', '../docs/LANDMINES.md'] as const;

const FORBIDDEN: ReadonlyArray<{ pattern: RegExp; note: string }> = [
  { pattern: /subscriptions only/i, note: '"Subscriptions only" — the absolutist framing replaced by "never metered overage"' },
  { pattern: /no API keys in any execution path/i, note: '"no API keys in any execution path, ever" — the removed README rule-1 claim' },
  { pattern: /adapters never accept API keys/i, note: '"adapters never accept API keys" — the removed SPEC §1 claim (adapters accept no-overage keys)' },
  { pattern: /never accepts? API keys/i, note: '"never accept(s) API keys" — contradicts the billing-class key gate' },
];

describe('HED-395 docs: never-metered-overage wording (acceptance #4)', () => {
  for (const rel of DOCS) {
    const text = readFileSync(new URL(rel, import.meta.url), 'utf8');
    it(`${rel.replace('../', '')} carries no absolutist "subscriptions only / no API keys ever" wording`, () => {
      for (const { pattern, note } of FORBIDDEN) {
        expect(pattern.test(text), `${rel.replace('../', '')} reintroduced ${note}`).toBe(false);
      }
    });
  }
});
