import { AUTO_JOIN_TIERS, type RouteTarget, type Tier } from './routing.js';
import type { LanesConfig } from './lanes.js';

/**
 * HED-106 tier-ladder candidate ordering — the PURE half of the expansion walk (no caps, no
 * liveness, no I/O). Given a class's declared route tier and its `[minTier, maxTier]` bounds, it
 * produces the ordered cross-lane candidates the router tries when the class's OWN routes are dead.
 * `capaware.ts` owns the rest: it prepends the class's declared fallback, evaluates each candidate's
 * liveness (dead → skip, over-threshold → stays eligible), and narrates the walk for the ledger.
 *
 * The walk order is R's ratified DESIGN LOCK (HED-106, 2026-08-22):
 *   (1) within-tier siblings of the declared route's tier,
 *   (2) DESCEND toward minTier (one tier at a time — a gradual step-down, not a jump to the floor;
 *       the cheaper direction, bounded by the class's declared quality floor),
 *   (3) ASCEND above the declared route toward maxTier (a live pricier lane beats a refusal).
 * T1Q (quality reserve) and both T3 lanes never appear — they are not in `AUTO_JOIN_TIERS`, and a
 * lane with no `lane_defaults` entry is skipped, so opt-in-only lanes can never auto-join.
 * Within a tier, candidates follow lanes.yaml declaration order (a static cost/preference order);
 * headroom/cooling ranking is an S3 enrichment (this module stays meter-free for S1).
 */

/** lanes.yaml stores tiers under long keys; the auto-join short tiers map onto them 1:1. */
const TIER_KEY: Record<Tier, keyof LanesConfig['tiers']> = {
  T0: 'T0-menial',
  T1: 'T1-workhorse',
  T2: 'T2-judgment',
};

/** The lane-names declared in a given auto-join tier (in lanes.yaml order). */
export function lanesInTier(lanes: LanesConfig, tier: Tier): string[] {
  return lanes.tiers[TIER_KEY[tier]] as string[];
}

/**
 * Which auto-join tier a provider's lane sits in — the cheapest tier that has a `lane_defaults`
 * lane resolving to this provider. `null` = the provider is unlaned (gemini, ollama) OR only appears
 * on a non-auto-join lane (a provider that lives solely on T1Q/T3); the walk treats that as its
 * declared route contributing no start tier, and the caller defaults it to T1.
 */
export function tierOfProvider(
  provider: string, lanes: LanesConfig, laneDefaults: Record<string, RouteTarget>,
): Tier | null {
  for (const tier of AUTO_JOIN_TIERS) {
    for (const lane of lanesInTier(lanes, tier)) {
      if (laneDefaults[lane]?.provider === provider) return tier;
    }
  }
  return null;
}

/**
 * The ordered expansion candidates for a dead declared route. `fromTier` is the declared route's
 * tier (null → treated as T1, so an unlaned dead route still descends/ascends sensibly). `eligible`
 * is the caller's structural+capability gate — `capaware.ts` passes one that drops author-family
 * providers, providers that cannot attach the class's MCP, non-web providers for a `requiresWeb`
 * class, and (via the `tier` argument) the read-only T0 lanes for an `edits_code` class. Candidates
 * are deduped by `provider/model` so a provider named as the declared target/fallback (excluded by
 * the caller) or repeated across tiers appears at most once.
 */
export function buildLadder(
  fromTier: Tier | null,
  minTier: Tier,
  maxTier: Tier,
  lanes: LanesConfig,
  laneDefaults: Record<string, RouteTarget>,
  eligible: (target: RouteTarget, tier: Tier) => boolean,
): { target: RouteTarget; tier: Tier }[] {
  const idx = (t: Tier): number => AUTO_JOIN_TIERS.indexOf(t);
  const start = fromTier ?? 'T1';
  const lo = idx(minTier);
  const hi = idx(maxTier);
  const s = idx(start);

  const phases: Tier[] = [];
  // (1) within-tier siblings — only if the start tier is itself inside the class's [min,max] bounds.
  if (s >= lo && s <= hi) phases.push(start);
  // (2) DESCEND toward minTier, one tier at a time, CLAMPED to the bounds: a start ABOVE maxTier enters
  //     the range from its ceiling (never emits a tier above maxTier), and an inverted range (lo > hi,
  //     e.g. a defaulted min above an explicit max) yields nothing. For an in-range start this is
  //     byte-identical to `s - 1` (since s ≤ hi ⟹ s-1 < hi).
  for (let i = Math.min(s - 1, hi); i >= lo; i--) phases.push(AUTO_JOIN_TIERS[i]);
  // (3) ASCEND above the declared route toward maxTier, CLAMPED: a start BELOW minTier enters from lo
  //     (never emits a tier below minTier). For an in-range start this is byte-identical to `s + 1`.
  for (let i = Math.max(s + 1, lo); i <= hi; i++) phases.push(AUTO_JOIN_TIERS[i]);

  const out: { target: RouteTarget; tier: Tier }[] = [];
  const seen = new Set<string>();
  for (const tier of phases) {
    for (const lane of lanesInTier(lanes, tier)) {
      const target = laneDefaults[lane];
      if (!target) continue; // lane has no auto-join default (openrouter-free, T1Q, T3) — never joins
      const key = `${target.provider}/${target.model}`;
      if (seen.has(key)) continue;
      if (!eligible(target, tier)) continue;
      seen.add(key);
      out.push({ target, tier });
    }
  }
  return out;
}
