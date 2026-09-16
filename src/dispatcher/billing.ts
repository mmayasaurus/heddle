/**
 * HED-395 — the "never metered overage" money-safety decision, as ONE pure function shared by the
 * dispatch DRY-RUN (planDispatch preview) and the AUTHORITATIVE spawn-time enforcement (runTarget's
 * gate). Sharing the function IS the invariant: a `heddle route` / plan_dispatch preview can never
 * advertise a route that enforcement would refuse, and enforcement can never refuse a route the
 * preview called safe (F7 parity — the same idiom as webRefusalReason in refusals.ts).
 *
 * THE INVARIANT: a dispatch must never SILENTLY spend real money. The gate REFUSES only on POSITIVE
 * evidence of real-money risk; it LOUD-DEGRADES-to-ALLOW (recorded on the ledger + surfaced on the
 * outcome, never stderr-only) whenever it lacks the data to classify — because the hard acceptance
 * criterion is ZERO behavior change for today's all-subscription fleet (no registry account declares
 * billingClass/overage). Strict-refusing at an un-verifiable edge (resume 'default', a stale/missing
 * meter, one JSON typo → fleet-wide dispatch outage) is FORBIDDEN.
 */
import { loadAccountRegistry, type Account, type AccountRegistry, type BillingClass, isBillingClass } from '../accounts.js';
import { isOpenAICompatProvider } from '../adapters/openai-compat.js';
import { accountCapState, type CapState } from '../capaware.js';
import type { RoutingTable } from '../routing.js';
import type { ProviderCaps } from '../usage.js';
import type { DispatchRefusal } from './types.js';

/**
 * Cap state for the BILLING decision (HED-395 REV-2): a STALE PROVIDER snapshot makes the reading
 * unknowable for SPEND even if a per-account row looks fresh — a limits.json row shares the provider's
 * capture, so once the provider mirror is stale it must not authorize paid overage. This is a
 * BILLING-ONLY tightening (spend authorization is conservative-for-MONEY). It deliberately does NOT
 * touch the shared accountCapState, which stays ROW-level so detectOverageAlert (HED-443,
 * conservative-for-DANGER) and the usage display still surface a fresh per-account reading THROUGH a
 * stale provider — the earlier "fix at the source (row.stale)" approach regressed exactly those two
 * consumers (see usage-remaining.test.ts + capaware.ts detectOverageAlert). Notes: `caps` undefined →
 * accountCapState already returns 'unknown'; a `source:'none'` provider already carries stale:true, so
 * both collapse to 'unknown' consistently.
 */
function billingCapState(caps: ProviderCaps | undefined, accountId: string): CapState {
  if (caps?.stale) return 'unknown';
  return accountCapState(caps, accountId);
}

/** The one override lever the operator can flip; named verbatim in every REFUSE message so the
 *  operator can act from the message alone. */
export const PAY_PER_TOKEN_PERMIT = 'policy.cap_aware_routing.permit_pay_per_token: true';

/**
 * The outcome of the billing gate for one bound account. At most one of `refusal` / `degraded` is
 * set; `advice` accompanies a clean allow (bounded-prepaid buffer). An all-empty verdict is a clean
 * allow (subscription-like), which is what today's fleet always yields.
 */
export interface BillingVerdict {
  /** Fail-closed refusal — POSITIVE evidence of real-money risk. */
  refusal?: DispatchRefusal;
  /** Loud-degrade-to-ALLOW: `note` is the machine-greppable `billing-degraded:<reason>` recorded on
   *  the ledger row AND the outcome; `warn` is the human-readable stderr line that names the fix. */
  degraded?: { note: string; warn: string };
  /** Non-blocking bounded-prepaid advisory (surfaced by the plan preview / route_reason). */
  advice?: string;
}

export interface BillingGateInput {
  /** The FINAL bound account id for this attempt (ctx.account / plan.account); null when none. */
  accountId: string | null;
  /** The provider that will actually run (target.provider). */
  provider: string;
  /** The ProviderCaps snapshot for `provider` (snap[provider]) — the SAME snapshot the plan used, so
   *  preview and enforcement compute the same cap state. */
  caps: ProviderCaps | undefined;
  /** policy.cap_aware_routing.permit_pay_per_token (default false). */
  permitPayPerToken: boolean;
  /** The routing table both call sites already hold — carried so the provider-class lookup happens INSIDE
   *  billingVerdict, giving preview and gate one shared resolution that cannot drift. */
  table: RoutingTable;
  /** Registry loader — a THUNK so a corrupt-registry throw degrades-to-allow here instead of crashing
   *  every dispatch (F4). Defaults to loadAccountRegistry(); the try/catch lives here so BOTH call
   *  sites (runTarget gate, planDispatch preview) are protected by the one shared path and can never
   *  disagree. Injectable for tests. */
  loadRegistry?: () => AccountRegistry;
}

/** Can't-classify degrade for an unregistered / absent account id (F2). */
function unregistered(accountId: string | null): BillingVerdict {
  const label = accountId ?? 'unset';
  const why = accountId === null ? 'no bound account id' : 'not in accounts.json';
  return {
    degraded: {
      note: `billing-degraded:account-unregistered(${label})`,
      warn: `billing gate cannot classify account '${label}' (${why}) — allowing; register it in accounts.json to enable the guard`,
    },
  };
}

/** The provider-level billing class declared in routing.v0.yaml (providers.<p>.billing_class), or
 *  undefined when absent/invalid. Enum-guarded so a hand-built RoutingTable that bypassed loadRouting
 *  can never inject a bad class. */
function providerBillingClass(table: RoutingTable, provider: string): BillingClass | undefined {
  const bc = (table.providers?.[provider] as Record<string, unknown> | undefined)?.billing_class;
  return isBillingClass(bc) ? bc : undefined;
}

/** Billing verdict for a keyed openai-compat pool (no registry account, no per-account meter/overage):
 *  refuse a pay-per-token pool unless the operator permits it; every other class is no-overage → clean
 *  allow. Mirrors classify()'s pay-per-token branch (same code + lever) with provider-appropriate text. */
function classifyProvider(billingClass: BillingClass, permitPayPerToken: boolean, provider: string): BillingVerdict {
  if (billingClass === 'pay-per-token' && !permitPayPerToken) {
    return { refusal: {
      code: 'billing.pay-per-token',
      reason: `provider "${provider}" (billing_class=pay-per-token) bills from token 1 and is refused by default.`,
      instruction: `To explicitly permit this provider, set ${PAY_PER_TOKEN_PERMIT}. (Declared at providers.${provider}.billing_class in routing.v0.yaml.)`,
    } };
  }
  return {}; // no-overage class → clean allow (no degrade note)
}

/** The billing/overage classification for a REGISTERED account that declares a billingClass. Pure. */
function classify(account: Account, caps: ProviderCaps | undefined, permitPayPerToken: boolean): BillingVerdict {
  const identity = `selected account "${account.id}" (billingClass=${account.billingClass}`;

  // KNOWN pay-per-token bills from token 1 → refuse unless the operator explicitly permits it.
  if (account.billingClass === 'pay-per-token' && !permitPayPerToken) {
    return { refusal: {
      code: 'billing.pay-per-token',
      reason: `${identity}) bills from token 1 and is refused by default.`,
      instruction: `To explicitly permit this account, set ${PAY_PER_TOKEN_PERMIT}.`,
    } };
  }

  const posture = account.overage?.posture;

  // open-billing enters PAID overage past the cap. Refuse when KNOWN at/over the cap, AND when the
  // cap state is UNKNOWABLE (stale/missing/null caps row) — an unmetered spend we cannot rule out is
  // treated as real-money risk (F3). OPEN-BILLING ONLY.
  if (posture === 'open-billing') {
    const capState = billingCapState(caps, account.id);
    if (capState === 'over') {
      return { refusal: {
        code: 'billing.open-billing-at-cap',
        reason: `${identity}, overage.posture=open-billing) is at or over its five-hour cap and would enter paid overage.`,
        instruction: `No switch overrides open-billing at cap; ${PAY_PER_TOKEN_PERMIT} is the exact pay-per-token permit lever and does not permit this posture. Select an account with headroom or change its overage posture.`,
      } };
    }
    if (capState === 'unknown') {
      return { refusal: {
        code: 'billing.open-billing-at-cap',
        reason: `open-billing account '${account.id}' (billingClass ${account.billingClass}): cap state unknown (caps row stale/missing) — refusing to avoid unmetered spend; refresh meters or rotate`,
        instruction: `No switch overrides open-billing with an unknown cap state; ${PAY_PER_TOKEN_PERMIT} is the exact pay-per-token permit lever and does not permit this posture. Refresh this account's usage meters or select an account with a fresh, under-cap reading.`,
      } };
    }
  }

  // bounded-prepaid draws a FINITE operator-funded pool that the provider hard-stops at exhaustion.
  if (posture === 'bounded-prepaid') {
    if (account.overage?.creditsRemaining === 0) {
      return { refusal: {
        code: 'billing.prepaid-exhausted',
        reason: `${identity}, overage.posture=bounded-prepaid) has credits exhausted.`,
        instruction: `No switch overrides exhausted prepaid credit; ${PAY_PER_TOKEN_PERMIT} is the exact pay-per-token permit lever and does not replenish this account. Add prepaid credit or select another account.`,
      } };
    }
    const capState = billingCapState(caps, account.id);
    // A stale/missing caps row does NOT refuse here (unlike open-billing): the provider hard-stops at
    // exhaustion by construction, so refusing would be over-strict. Loud-degrade-to-allow (F6).
    if (capState === 'unknown') {
      return { degraded: {
        note: 'billing-degraded:prepaid-caps-stale',
        warn: `billing gate: bounded-prepaid account '${account.id}' has a stale/missing caps row — allowing (the provider hard-stops at exhaustion by construction); refresh meters for buffer advice`,
      } };
    }
    // Known at/over cap with credits left: allow, but advise that we are burning the prepaid buffer.
    if (capState === 'over') {
      return { advice: `burning prepaid buffer (${account.overage?.creditsRemaining} of ${account.overage?.spendLimit})` };
    }
  }

  // Any other classified posture (hard-stop, or no overage object at all) never bills open-endedly →
  // clean allow. A billingClass without an overage object is subscription-like for spend purposes.
  return {};
}

/**
 * The single billing/overage decision for a bound account. Fail-closed on positive money risk;
 * loud-degrade-to-allow when unclassifiable. PURE: it emits no stderr and writes no ledger row — the
 * runTarget gate acts on the returned `degraded`/`refusal` (stderr + ledger note + outcome), and the
 * plan preview reads `refusal`/`advice` only.
 */
export function billingVerdict(input: BillingGateInput): BillingVerdict {
  const { accountId, caps, provider, permitPayPerToken } = input;

  // Providers with a strict routing catalog may have no registry account; their provider-level
  // billing class is authoritative because every admitted model belongs to that verified catalog.
  if (accountId === null) {
    const config = input.table.providers?.[provider] as Record<string, unknown> | undefined;
    if (isOpenAICompatProvider(provider) || config?.strict_model_catalog === true) {
      const pc = providerBillingClass(input.table, provider);
      if (pc) return classifyProvider(pc, permitPayPerToken, provider);
    }
    return unregistered(null);
  }

  // F4: a corrupt/unreadable registry must NEVER crash all dispatch. loadAccountRegistry throws loud
  // by design; catch it HERE (the shared path) so both call sites degrade-to-allow identically.
  let registry: AccountRegistry;
  try {
    registry = (input.loadRegistry ?? loadAccountRegistry)();
  } catch {
    return {
      degraded: {
        note: 'billing-degraded:registry-unreadable',
        warn: 'billing gate cannot read accounts.json (corrupt/unreadable) — allowing; fix accounts.json to re-enable the guard',
      },
    };
  }

  // F2: the bound account is not in the registry → can't classify → loud-degrade-to-allow.
  const account = registry.accounts.find((a) => a.provider === provider && a.id === accountId);
  if (!account) return unregistered(accountId);

  // A registered account with no declared billingClass is unclassifiable for spend → subscription-like
  // clean allow. This is the branch today's entire fleet takes → the zero-change-today guarantee.
  if (!account.billingClass) return {};

  return classify(account, caps, permitPayPerToken);
}
