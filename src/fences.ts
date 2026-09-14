/**
 * HED-404 — the per-HARNESS structural fence registry (A2). The LANDMINE fact base: heddle may only
 * PROMISE a read-only / network / cwd fence that the harness actually enforces; the permission layer is
 * NOT a boundary. Verified 2026-09-14 from the adapters:
 *  - claude (adapters/claude.ts): `opts.readOnly` -> `--tools Read Grep Glob` — the ONLY mechanism
 *    verified to hold (live, twice); a permission-layer allowlist is NOT a boundary. No separate cwd or
 *    network fence heddle relies on.
 *  - codex (adapters/codex.ts): `opts.readOnly` -> `--sandbox read-only`; the workspace sandbox confines
 *    writes to the cwd and keeps outbound network OFF by default (only the `net` cap turns it on).
 *  - cursor, agy: NO write/network fence heddle can rely on. (agy's `--dangerously-skip-permissions` is a
 *    prompt toggle, not a boundary — HED-539.)
 *  - anything else (local API adapter, env-repoint / openai-compat, unknown harness): no fence heddle
 *    controls -> NO_FENCE via `harnessFences`.
 *
 * Keyed by `Account.harness` (the native runner). An env-repoint account (e.g. glm/groq riding codex)
 * carries the NATIVE harness, so it correctly inherits that harness's real fence.
 */
import type { AccountFences } from './accounts.js';

/** A harness that enforces nothing. Also the default for any harness absent from HARNESS_FENCES, so the
 *  registry can never OVER-promise a fence a harness lacks (acceptance #4). */
export const NO_FENCE: AccountFences = Object.freeze({
  readOnlyEnforceable: false,
  networkEnforceable: false,
  cwdEnforceable: false,
});

/** Per-harness ENFORCEABILITY. Only positive, code-verified fences are `true`. */
export const HARNESS_FENCES: Record<string, AccountFences> = {
  claude: { readOnlyEnforceable: true, networkEnforceable: false, cwdEnforceable: false },
  codex: { readOnlyEnforceable: true, networkEnforceable: true, cwdEnforceable: true },
  cursor: { readOnlyEnforceable: false, networkEnforceable: false, cwdEnforceable: false },
  agy: { readOnlyEnforceable: false, networkEnforceable: false, cwdEnforceable: false },
};

/** The enforceability declared for a harness; an unknown harness enforces nothing (safe default). */
export function harnessFences(harness: string): AccountFences {
  return HARNESS_FENCES[harness] ?? NO_FENCE;
}

/**
 * The EFFECTIVE fences for an account. The harness is PRIMARY — it bounds what is physically
 * enforceable — and a per-account `fences` declaration may only NARROW it (`true`->`false`), never widen
 * it. So a harness marked enforceable=false never gets a flag it cannot support (acceptance #4), and an
 * account can voluntarily give up an enforceable fence but can never claim one the harness lacks. Absent
 * per-account fences means "do not narrow".
 */
export function effectiveFences(harness: string, accountFences?: AccountFences): AccountFences {
  const h = harnessFences(harness);
  const narrow = (k: keyof AccountFences): boolean => h[k] && (accountFences?.[k] ?? true);
  return {
    readOnlyEnforceable: narrow('readOnlyEnforceable'),
    networkEnforceable: narrow('networkEnforceable'),
    cwdEnforceable: narrow('cwdEnforceable'),
  };
}
