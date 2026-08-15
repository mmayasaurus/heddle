/**
 * Per-dispatch capability allowlist — "the grant IS the tool surface" (SPEC §11): a worker gets
 * nothing risky unless the dispatch names it, every grant is ledgered, and heddle passes a grant to
 * the CLI ONLY where that CLI can actually enforce it. A grant a provider cannot enforce is REFUSED
 * (ledgered) rather than silently ignored — never pretend a worker is fenced when it is not.
 *
 * Tokens (decided 2026-08-15, Maya via Agent R — `exec-playbook` renamed to `exec-privileged`):
 *   net             outbound network from inside the worker's sandbox
 *   browse          live web retrieval (search/fetch) by the worker's own tools
 *   exec-privileged run outside the worker sandbox (codex `--sandbox danger-full-access`) — anything
 *                   that could push to remotes, run deploy scripts, or touch $HOME outside cwd.
 *                   Loud by design: additionally requires `opt_in: true` on the call.
 *
 * Enforcement matrix (verified against each CLI's own docs/help, 2026-08-15 — see LANDMINES):
 *   codex   net → `-c sandbox_workspace_write.network_access=true` (workspace-write keeps network OFF
 *           by default per the official sandbox docs); browse → `-c web_search="live"` (default
 *           "cached" = OpenAI index, no external access); exec-privileged → `--sandbox danger-full-access`.
 *   cursor  no per-capability flags in headless mode (`--sandbox enabled|disabled` exists but its
 *           network/fs semantics are undocumented) → cannot enforce any grant → refused.
 *   gemini  agy has `--sandbox` (terminal restrictions) only, no network/browse knobs → refused.
 *   claude  workers are in-session subagents (refused earlier as claude-in-session).
 * Default-deny is only as real as the CLI's sandbox: codex workspace-write denies network by default;
 * cursor/agy headless workers are NOT network-fenced by heddle today (documented gap, LANDMINES).
 */

export const CAPABILITIES = ['net', 'browse', 'exec-privileged'] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** Which capabilities each provider's CLI can enforce from flags heddle passes. */
export const ENFORCEABLE: Record<string, readonly Capability[]> = {
  codex: ['net', 'browse', 'exec-privileged'],
  cursor: [],
  gemini: [],
  claude: [],
};

export interface CapabilityDecision {
  /** De-duplicated grants in allowlist order — what the adapter will enforce and the ledger records. */
  granted: Capability[];
  /** Present iff the request must be refused (unknown token, missing opt-in, or unenforceable). */
  refusal?: { code: 'capability-denied'; reason: string };
}

/** Operator-owned switches from the routing YAML (`policy.capabilities`). */
export interface CapabilityPolicy {
  /** exec-privileged is refused unless the OPERATOR enabled it here — the model's `opt_in` alone is not enough. */
  allowExecPrivileged: boolean;
}
export const DEFAULT_CAPABILITY_POLICY: CapabilityPolicy = { allowExecPrivileged: false };

export function capabilityPolicy(table: { policy: Record<string, unknown> }): CapabilityPolicy {
  const node = (table.policy as any)?.capabilities ?? {};
  return { allowExecPrivileged: node.allow_exec_privileged === true };
}

export function decideCapabilities(
  provider: string, requested: readonly string[] | undefined, optIn: boolean,
  policy: CapabilityPolicy = DEFAULT_CAPABILITY_POLICY,
): CapabilityDecision {
  const asked = [...new Set((requested ?? []).map((c) => c.trim()).filter(Boolean))];
  if (asked.length === 0) return { granted: [] };

  const unknown = asked.filter((c) => !(CAPABILITIES as readonly string[]).includes(c));
  if (unknown.length) {
    return {
      granted: [],
      refusal: {
        code: 'capability-denied',
        reason: `unknown capability ${unknown.map((u) => `"${u}"`).join(', ')} — the allowlist is ` +
          `${CAPABILITIES.join(', ')}; a dispatch cannot mint capabilities heddle does not know.`,
      },
    };
  }
  const granted = CAPABILITIES.filter((c) => asked.includes(c));

  if (granted.includes('exec-privileged')) {
    // Two keys: the OPERATOR enables it in the routing YAML (policy.capabilities.allow_exec_privileged),
    // AND the call says opt_in:true. A model-controlled tool argument alone can never widen the sandbox.
    if (!policy.allowExecPrivileged) {
      return {
        granted: [],
        refusal: {
          code: 'capability-denied',
          reason: 'capability "exec-privileged" (no sandbox: codex danger-full-access) is disabled by the ' +
            'operator — routing.v0.yaml policy.capabilities.allow_exec_privileged is not true. A tool ' +
            'argument cannot enable it.',
        },
      };
    }
    if (!optIn) {
      return {
        granted: [],
        refusal: {
          code: 'capability-denied',
          reason: 'capability "exec-privileged" runs the worker OUTSIDE its sandbox (codex ' +
            'danger-full-access: can push to remotes, run deploy scripts, touch $HOME) and additionally ' +
            'requires `opt_in: true` on the call.',
        },
      };
    }
  }

  const enforceable = Object.prototype.hasOwnProperty.call(ENFORCEABLE, provider) ? ENFORCEABLE[provider] : [];
  const unenforceable = granted.filter((c) => !enforceable.includes(c));
  if (unenforceable.length) {
    return {
      granted: [],
      refusal: {
        code: 'capability-denied',
        reason: `provider "${provider}" cannot enforce capability ${unenforceable.map((c) => `"${c}"`).join(', ')} ` +
          `(no CLI flag heddle can pass — see docs/LANDMINES.md); refusing rather than pretending the ` +
          `worker is fenced. Enforceable on ${provider}: ${enforceable.length ? enforceable.join(', ') : 'none'}` +
          (provider !== 'codex' && (ENFORCEABLE.codex as readonly string[]).some((c) => unenforceable.includes(c as Capability))
            ? '; codex enforces it — dispatch there.' : '.'),
      },
    };
  }
  return { granted };
}
