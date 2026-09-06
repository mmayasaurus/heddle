/**
 * Worker environment construction — the enforcement point for heddle's subscriptions-only rule.
 *
 * Each vendor treats an API-key env var as an override that silently moves billing OFF the
 * subscription, and in headless mode there is no prompt (Anthropic's docs are explicit:
 * "In non-interactive mode (-p), the key is always used when present"; OpenAI's: "When you sign
 * in with an API key, Codex uses standard API pricing instead of included ChatGPT plan credits").
 * A stray export in a shell rc, a .env, or an inherited CI variable would therefore bill the operator
 * per-token with no visible signal. Workers get these stripped, always.
 */
const BILLING_SWITCH_VARS = [
  // TODO(HED-484/HED-395): when Account.envRepoint lands, ANTHROPIC_BASE_URL/AUTH_TOKEN become
  // dispatch-scoped overrides for that selected account; inherited values remain stripped here.
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
 * rotation), NOT billing switches. These pass through when a caller sets them explicitly —
 * but CLAUDE_CODE_OAUTH_TOKEN is stripped when merely INHERITED (see INHERITED_CREDENTIAL_VARS):
 * a token in the parent's shell outranks the config-dir OAuth inside `claude`, so leaving it
 * would silently pin every worker to the token's account and defeat rotation.
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

/**
 * Stripped from the INHERITED env but allowed as an explicit override: a credential that overrides
 * the account selection heddle just made. CLAUDE_CODE_OAUTH_TOKEN beats CLAUDE_CONFIG_DIR's OAuth
 * inside Claude Code, so a stray export would run every worker as the token's account no matter
 * which config dir the picker chose (PR #12 review, codex-connector P1).
 */
const INHERITED_CREDENTIAL_VARS = ['CLAUDE_CODE_OAUTH_TOKEN'] as const;

/**
 * Vendor credential / billing / endpoint NAMESPACES. Any INHERITED env var whose name starts with one
 * of these is stripped from a worker. A denylist of exact names can't keep pace with each vendor's new
 * `*_BASE_URL` / `*_API_KEY` / `*_PROJECT` / `*_USE_VERTEXAI` switch — the HED-30 audit found ~15 current
 * Anthropic override vars alone (ANTHROPIC_PROFILE, the FEDERATION/WORKSPACE ids, CUSTOM_HEADERS, the
 * AWS_/BEDROCK_/VERTEX_/FOUNDRY_ base-URLs + keys, AWS_BEARER_TOKEN_BEDROCK, …) plus OpenAI/Google/Cursor
 * ones that the exact-name list missed — so strip by namespace and stay correct as vendors add more.
 * BILLING_SWITCH_VARS above stays for CODEX_API_KEY (a bare `CODEX_` prefix would also catch the
 * CODEX_HOME account selector) and to name the switch in the override-refusal message. Account selectors
 * are re-applied as overrides AFTER this strip, so an inherited stale selector is replaced by heddle's
 * chosen one, never leaked. (Operator firsthand approval 2026-08-19.)
 */
const VENDOR_CREDENTIAL_PREFIXES = [
  'ANTHROPIC_', 'OPENAI_', 'GEMINI_', 'GOOGLE_', 'GCLOUD_', 'VERTEXAI_', 'VERTEX_',
  'CLAUDE_CODE_USE_', 'CURSOR_', 'AWS_', 'BEDROCK_', 'FOUNDRY_', 'ZAI_', 'GLM_',
] as const;

/**
 * The ONLY env vars an override may set (HED-30 ALLOWLIST — operator firsthand approval 2026-08-19). The old
 * denylist let any UNLISTED override pass silently, so a new vendor billing-switch (or a typo) slipped
 * through; an allowlist is secure-by-default. The legitimate overrides heddle sets are exactly the
 * account selectors and the worker stamps. Stamp names mirror `identity.WORKER_ENV` — hardcoded here to
 * avoid an env.ts↔identity.ts import cycle, and a test guards them against drift.
 */
const OVERRIDE_ALLOWLIST = new Set<string>([
  ...ACCOUNT_SELECTOR_VARS,
  'HEDDLE_WORKER', 'HEDDLE_DISPATCH_ID', 'HEDDLE_PARENT',
]);

export interface WorkerEnvOptions {
  /** Explicit overrides — typically an account selector from the account registry. */
  overrides?: Record<string, string>;
  /**
   * Vars to REMOVE from the worker env even if the parent has them — e.g. CLAUDE_CONFIG_DIR when the
   * chosen Claude account is the DEFAULT login (setting it explicitly to ~/.claude changes resolution
   * and `claude auth status` reports logged-out; verified by Agent R 2026-08-15).
   */
  unset?: string[];
}

/**
 * Build the environment for a worker subprocess: the parent env minus every billing-switch variable
 * AND every vendor-credential namespace (HED-30), plus an ALLOW-LISTED set of overrides (account
 * selectors + worker stamps only — a parent-identity override is silently dropped, any OTHER override
 * is refused). Returns the env and a list of what was stripped, so the dispatch ledger can record that
 * a subscription-billing guard actually fired.
 */
export function buildWorkerEnv(opts: WorkerEnvOptions = {}): {
  env: NodeJS.ProcessEnv;
  stripped: string[];
} {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const stripped: string[] = [];

  // Fixed strips in one pass: billing-switch vars + the orchestrator's identity + the inherited credential.
  for (const key of [...BILLING_SWITCH_VARS, ...PARENT_IDENTITY_VARS, ...INHERITED_CREDENTIAL_VARS]) {
    if (env[key] !== undefined) {
      delete env[key];
      stripped.push(key);
    }
  }
  // Then strip any INHERITED var under a vendor credential/billing NAMESPACE (HED-30) — scalable vs a
  // fixed denylist. Case-INSENSITIVE: Windows env names are case-insensitive but the copied object keeps
  // their casing, so a lowercase `openai_base_url` would survive an uppercase startsWith yet still be
  // read by the CLI as OPENAI_BASE_URL (codex-connector/qodo #64). Account selectors are re-applied as
  // overrides below, so a stale inherited one is replaced.
  for (const key of Object.keys(env)) {
    if (VENDOR_CREDENTIAL_PREFIXES.some((p) => key.toUpperCase().startsWith(p))) {
      delete env[key];
      if (!stripped.includes(key)) stripped.push(key);
    }
  }

  for (const [key, value] of Object.entries(opts.overrides ?? {})) {
    if ((PARENT_IDENTITY_VARS as readonly string[]).includes(key)) continue; // overrides cannot re-inject the parent's identity
    if (!OVERRIDE_ALLOWLIST.has(key)) {
      const isSwitch = (BILLING_SWITCH_VARS as readonly string[]).includes(key)
        || VENDOR_CREDENTIAL_PREFIXES.some((p) => key.toUpperCase().startsWith(p));
      throw new Error(
        `refusing to set "${key}" on a worker: overrides are allow-listed (HED-30) — only account ` +
          `selectors (${[...ACCOUNT_SELECTOR_VARS].join(', ')}) and the worker stamps ` +
          `(HEDDLE_WORKER, HEDDLE_DISPATCH_ID, HEDDLE_PARENT) may be set.` +
          (isSwitch ? ' This is a vendor billing/endpoint switch — use an account selector instead.' : ''),
      );
    }
    env[key] = value;
  }

  // unset is applied LAST so it always wins — an override must not be able to re-introduce a var
  // the caller asked to remove (e.g. CLAUDE_CONFIG_DIR for the default login; PR #12, copilot).
  for (const key of opts.unset ?? []) {
    if (env[key] !== undefined) {
      delete env[key];
      stripped.push(key);
    }
  }

  return { env, stripped };
}
