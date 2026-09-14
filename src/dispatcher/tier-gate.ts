/**
 * HED-404 — structural read-only tier gate. A LOW-tier (T0) account is STRUCTURALLY ineligible for any
 * class heddle cannot prove is read-only, because the permission layer is not a boundary (the HED-404
 * landmines): "read-only for low tiers" must be a tier-ELIGIBILITY refusal, not a promised fence that
 * some harness cannot actually enforce.
 *
 * Mirrors billingVerdict (HED-395) exactly: a PURE function (no stderr, no ledger row) that runTarget's
 * gate slots into its ordered `gateChecks`; it resolves the bound Account through the SAME registry thunk
 * and — critically — FAILS OPEN on every uncertainty (a read-only class, no bound account, an unreadable
 * registry, an account not found, no declared tier, or a higher tier T1-T3). It REFUSES only on POSITIVE
 * evidence: the resolved account's tier is exactly 'T0' and the class is not read-only.
 *
 * No registry account declares `tier` today, so this is a NO-OP for the current fleet (the
 * zero-change-today guarantee). A fail-CLOSED gate would refuse the whole untiered fleet on one JSON edit
 * (a dispatch outage), which is forbidden — the tier field is opt-in, enforced only when positively set.
 */
import { loadAccountRegistry, type AccountRegistry } from '../accounts.js';
import type { DispatchRefusal } from './types.js';

export interface TierGateInput {
  /** The FINAL bound account id for this attempt (ctx.account); null when none. */
  accountId: string | null;
  /** The provider that will actually run (target.provider); pairs with accountId to resolve the Account,
   *  mirroring billingVerdict's `provider === a.provider && id === a.id` match. */
  provider: string;
  /** route.readOnly — `true` only for classes the routing table marks `read_only: true`. */
  readOnly: boolean;
  /** Registry loader thunk — a corrupt/unreadable registry FAILS OPEN here instead of crashing or
   *  refusing every dispatch (F4). Defaults to loadAccountRegistry(); injectable for tests. */
  loadRegistry?: () => AccountRegistry;
}

export interface TierVerdict {
  /** Set ONLY on positive evidence (a T0 account selected for a non-read-only class). Absent = allow. */
  refusal?: DispatchRefusal;
}

export function tierReadOnlyVerdict(input: TierGateInput): TierVerdict {
  const { accountId, provider, readOnly } = input;

  // A read-only class is eligible for every tier (T0 included) — nothing to gate.
  if (readOnly) return {};
  // No bound account -> no tier to read -> fail open (mirrors billing's unregistered degrade-to-allow).
  if (accountId === null) return {};

  // F4: a corrupt/unreadable registry must NEVER crash or refuse all dispatch — fail open.
  let registry: AccountRegistry;
  try {
    registry = (input.loadRegistry ?? loadAccountRegistry)();
  } catch {
    return {};
  }

  // Not found, or no declared tier, or a higher tier (T1-T3): not a T0 -> allow.
  const account = registry.accounts.find((a) => a.provider === provider && a.id === accountId);
  if (!account || account.tier !== 'T0') return {};

  // POSITIVE evidence: a T0 account selected for a class that is not marked read-only. Structural refusal.
  return {
    refusal: {
      code: 'tier-read-only',
      reason:
        `account "${account.id}" is tier T0 (structural read-only) — eligible only for classes marked ` +
        `read_only, and this class is not. heddle cannot enforce a write fence on every harness, so a low ` +
        `tier is refused STRUCTURALLY rather than run under an unenforceable "read-only" promise.`,
      instruction:
        `Route this class to a T1+ account, or dispatch a read-only class (e.g. adversarial-review) to this account.`,
    },
  };
}
