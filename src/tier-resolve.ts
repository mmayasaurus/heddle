import { isAccountModeledProvider, type Account } from './accounts.js';
import { buildLadder, tierOfProvider } from './ladder.js';
import { ladderEligible } from './ladder-eligibility.js';
import type { LanesConfig } from './lanes.js';
import { DEFAULT_MIN_TIER, type Route, type RoutePreference, type RouteTarget, type TargetTier, type Tier } from './routing.js';
import type { CapsByProvider } from './usage.js';

export interface TierResolveContext {
  lanes: LanesConfig;
  laneDefaults: Record<string, RouteTarget>;
}

export interface TierTargetResolution extends RouteTarget {
  /** The preference entry that selected this concrete target. */
  symbol: string;
  /** Short, ordered explanation intended for the ledger and `heddle route`. */
  walk: string[];
}

function label(entry: RoutePreference): string {
  return 'tier' in entry ? entry.tier : `${entry.provider}/${entry.model}`;
}

function available(target: RouteTarget, accounts: Account[]): string | null {
  // An empty registry means this process inherits the caller's login. This preserves the legacy
  // no-registry behavior; only a non-empty registry can prove a provider unavailable.
  if (accounts.length === 0) return null;
  // C2 (HED-397): only NATIVE Account providers (claude/codex/cursor) appear as `account.provider`, so
  // only they are registry-decidable. Env-repoint providers (gemini/groq/glm/…) ride a native account
  // via envRepoint.service (provider-matrix.ts); a target naming one is never dead via account presence
  // (gating them would route the operator's gemini/groq lanes away). Universal presence is a follow-up.
  if (!isAccountModeledProvider(target.provider)) return null;
  const providerAccounts = accounts.filter((account) => account.provider === target.provider && account.loggedIn !== false);
  if (providerAccounts.length === 0) return 'no logged-in account';
  // v1 deliberately gates only Fable: non-Fable Claude models remain serveable by any logged-in Claude
  // account until a complete per-model capability map is introduced. C1: an UNSET tier means
  // fable-capable (pre-HED-395 rows are untiered — the operator's real registry today), so Fable is unavailable
  // only when EVERY logged-in Claude account carries an EXPLICIT non-T3 tier; effective once HED-395
  // back-fills tiers.
  if (target.provider === 'claude' && target.model === 'fable'
      && !providerAccounts.some((account) => account.tier === undefined || account.tier === 'T3')) {
    return 'no Fable-capable (T3) Claude account';
  }
  return null;
}

function enrich(route: Route, target: RouteTarget): RouteTarget {
  return {
    ...target,
    skills: target.skills ?? route.skills,
    mcp: target.mcp ?? route.mcp,
    capabilities: target.capabilities ?? route.capabilities,
  };
}

/**
 * A LITERAL prefer entry is the class's own declared target expressed as `provider/model`, so it also
 * inherits the class's effort/extraFlags (HED-397 M5) — where a tier/ladder candidate is a DIFFERENT
 * provider and must NOT (per-provider effort vocabulary), matching walkLadder + resolveRoute's
 * declared-fallback contract. The entry's own values still win, and an undefined key is never set.
 */
function enrichLiteral(route: Route, target: RouteTarget): RouteTarget {
  const effort = target.effort ?? route.effort;
  const extraFlags = target.extraFlags ?? route.extraFlags;
  return {
    ...enrich(route, target),
    ...(effort === undefined ? {} : { effort }),
    ...(extraFlags === undefined ? {} : { extraFlags }),
  };
}

function tierCandidates(symbol: TargetTier, route: Route, context: TierResolveContext): Array<{ target: RouteTarget; label: string }> {
  const eligibility = {
    mcp: route.mcp ?? [], requiresWeb: route.requiresWeb, grantedCapabilities: route.capabilities ?? [],
    editsCode: route.editsCode, excluded: new Set<string>(),
  };
  if (symbol === 'T3') {
    // fable intentionally has no lane_default, so it can never auto-join HED-106. A requested T3
    // symbol is explicit policy and may target it, then descend through the existing T2→T0 ladder.
    // C3 (HED-397): read the T3 lane directly — `lanesInTier`/TIER_KEY only map the auto-join tiers
    // (T0–T2), so routing 'T3-orchestrator' through it returns undefined and `.includes` throws.
    const t3Lanes = context.lanes.tiers['T3-orchestrator'] ?? [];
    // Gate the DIRECT fable candidate too (not just the descended ladder) — capability ONLY (editsCode:false;
    // fable is never T0). Without this a T3 preference requiring mcp/web could select an uncapable fable and
    // reach dispatch validation instead of descending to a compatible lane (qodo/codacy #247).
    const fableTarget = enrich(route, { provider: 'claude', model: 'fable' });
    const direct = t3Lanes.includes('fable')
      && ladderEligible(fableTarget, DEFAULT_MIN_TIER, { ...eligibility, editsCode: false })
      ? [{ target: fableTarget, label: 'T3:fable' }]
      : [];
    const descended = buildLadder(
      'T2', 'T0', 'T2', context.lanes, context.laneDefaults,
      (target, tier) => ladderEligible(target, tier, eligibility),
    )
      .map((candidate) => ({ target: enrich(route, candidate.target), label: `T3→${candidate.tier}` }));
    return [...direct, ...descended];
  }
  const tier = symbol as Tier;
  return buildLadder(
    tier, tier, tier, context.lanes, context.laneDefaults,
    (target, candidateTier) => ladderEligible(target, candidateTier, eligibility),
  )
    .map((candidate) => ({ target: enrich(route, candidate.target), label: symbol }));
}

function fallbackCandidates(route: Route, context: TierResolveContext): Array<{ target: RouteTarget; label: string }> {
  const candidates: Array<{ target: RouteTarget; label: string }> = [];
  const excluded = new Set<string>([route.provider, route.fallback?.provider].filter((provider): provider is string => Boolean(provider)));
  const eligibility = {
    mcp: route.mcp ?? [], requiresWeb: route.requiresWeb, grantedCapabilities: route.capabilities ?? [],
    editsCode: route.editsCode, excluded,
  };
  // The declared fallback leads the walk, but only if it clears the capability gate — matching walkLadder's
  // declared-fallback check: capability ONLY (editsCode:false; empty excluded, since the fallback provider is
  // itself in `excluded`). An uncapable fallback is skipped so a later compatible ladder candidate can win
  // instead of a dispatch-time throw (qodo/codacy #247).
  if (route.fallback && ladderEligible(route.fallback, route.minTier ?? DEFAULT_MIN_TIER, { ...eligibility, editsCode: false, excluded: new Set<string>() })) {
    candidates.push({ target: route.fallback, label: 'declared-fallback' });
  }
  const maxTier = route.maxTier ?? tierOfProvider(route.provider, context.lanes, context.laneDefaults) ?? DEFAULT_MIN_TIER;
  for (const candidate of buildLadder(
    tierOfProvider(route.provider, context.lanes, context.laneDefaults), route.minTier ?? DEFAULT_MIN_TIER, maxTier,
    context.lanes, context.laneDefaults, (target, tier) => ladderEligible(target, tier, eligibility),
  )) candidates.push({ target: enrich(route, candidate.target), label: `ladder:${candidate.tier}` });
  return candidates;
}

/**
 * Pure dispatch-time preference resolver. Caps are intentionally accepted but never make a route
 * unavailable: account existence/login/model capability decides availability; cap-aware routing
 * ranks or routes after this choice in the existing dispatcher path.
 */
export function resolveTierTarget(
  route: Route, accounts: Account[], _caps: CapsByProvider, context: TierResolveContext,
): TierTargetResolution {
  const walk: string[] = [];
  const preferences = route.prefer ?? [{ provider: route.provider, model: route.model }];
  for (const entry of preferences) {
    const entryLabel = label(entry);
    const candidates = 'tier' in entry
      ? tierCandidates(entry.tier, route, context)
      : [{ target: enrichLiteral(route, entry), label: entryLabel }];
    for (const candidate of candidates) {
      const reason = available(candidate.target, accounts);
      if (reason) {
        walk.push(`${entryLabel} → ${candidate.target.provider}/${candidate.target.model} skipped (${reason})`);
        continue;
      }
      walk.push(`${entryLabel} → ${candidate.target.provider}/${candidate.target.model} chosen (${candidate.label})`);
      return { ...candidate.target, symbol: entryLabel, walk };
    }
    if (candidates.length === 0) walk.push(`${entryLabel} skipped (no concrete lane target)`);
  }
  for (const candidate of fallbackCandidates(route, context)) {
    const reason = available(candidate.target, accounts);
    if (reason) {
      walk.push(`${candidate.target.provider}/${candidate.target.model} skipped (${reason})`);
      continue;
    }
    walk.push(`${candidate.target.provider}/${candidate.target.model} chosen (${candidate.label})`);
    return { ...candidate.target, symbol: candidate.label, walk };
  }
  // Preserve the existing dispatch refusal path when every candidate is unavailable. The caller
  // receives the original concrete route plus the complete explanation rather than a new error.
  walk.push('walk exhausted — preserving declared target for the existing refusal path');
  return { ...route, symbol: label(preferences[0]!), walk };
}
