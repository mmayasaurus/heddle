/**
 * Worker environment construction — the enforcement point for heddle's subscriptions-only rule.
 *
 * Each vendor treats an API-key env var as an override that silently moves billing OFF the
 * subscription, and in headless mode there is no prompt (Anthropic's docs are explicit:
 * "In non-interactive mode (-p), the key is always used when present"; OpenAI's: "When you sign
 * in with an API key, Codex uses standard API pricing instead of included ChatGPT plan credits").
 * A stray export in a shell rc, a .env, or an inherited CI variable would therefore bill Maya
 * per-token with no visible signal. Workers get these stripped, always.
 */
const BILLING_SWITCH_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL', // repoints Claude off the subscription endpoint entirely
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
] as const;

/**
 * Credential-selection vars that are legitimate subscription-identity switches (account
 * rotation), NOT billing switches. These pass through when a caller sets them explicitly.
 * - CODEX_HOME: selects which ChatGPT account's auth.json a Codex worker uses.
 * - CLAUDE_CONFIG_DIR: selects which Anthropic account's config/session tree.
 * - CLAUDE_CODE_OAUTH_TOKEN: subscription-backed long-lived token (`claude setup-token`) —
 *   the docs-recommended headless credential; NOT an API key, stays on the plan.
 * - CURSOR_API_KEY: Cursor's only account selector (it has no config-dir mechanism). Per Cursor
 *   staff, it bills against that account's own plan rather than a separate metered SKU —
 *   forum-sourced, so verify against a real invoice before high volume.
 */
const ACCOUNT_SELECTOR_VARS = new Set([
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CURSOR_API_KEY',
]);

/**
 * Process-bound identity of the ORCHESTRATOR must not leak into a worker: a heddle process started
 * inside the worker would otherwise resolve the parent's identity and, with the worker stamp
 * scrubbed, dispatch AS the parent (HED-2 review, grok #2). Workers get their own stamps
 * (HEDDLE_WORKER / HEDDLE_DISPATCH_ID / HEDDLE_PARENT) via overrides instead.
 */
const PARENT_IDENTITY_VARS = ['HEDDLE_AGENT', 'FLEET_AGENT'] as const;

export interface WorkerEnvOptions {
  /** Explicit overrides — typically an account selector from the account registry. */
  overrides?: Record<string, string>;
}

/**
 * Build the environment for a worker subprocess: the parent env minus every billing-switch
 * variable, plus explicit overrides. Returns the env and a list of what was stripped, so the
 * dispatch ledger can record that a subscription-billing guard actually fired.
 */
export function buildWorkerEnv(opts: WorkerEnvOptions = {}): {
  env: NodeJS.ProcessEnv;
  stripped: string[];
} {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const stripped: string[] = [];

  for (const key of BILLING_SWITCH_VARS) {
    if (env[key] !== undefined) {
      delete env[key];
      stripped.push(key);
    }
  }
  for (const key of PARENT_IDENTITY_VARS) {
    if (env[key] !== undefined) {
      delete env[key];
      stripped.push(key);
    }
  }

  for (const [key, value] of Object.entries(opts.overrides ?? {})) {
    if (!ACCOUNT_SELECTOR_VARS.has(key) && (BILLING_SWITCH_VARS as readonly string[]).includes(key)) {
      throw new Error(
        `refusing to set "${key}" on a worker: it would move billing off the subscription. ` +
          `Use an account selector (${[...ACCOUNT_SELECTOR_VARS].join(', ')}) instead.`,
      );
    }
    env[key] = value;
  }

  return { env, stripped };
}
