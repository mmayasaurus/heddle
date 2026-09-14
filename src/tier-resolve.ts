import type { Account } from './accounts.js';
import { buildLadder, lanesInTier, tierOfProvider } from './ladder.js';
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
  const providerAccounts = accounts.filter((account) => account.provider === target.provider && account.loggedIn !== false);
  if (providerAccounts.length === 0) return 'no logged-in account';
  // v1 deliberately gates only Fable: non-Fable Claude models remain serveable by any logged-in
  // Claude account until a complete per-model capability map is introduced.
  if (target.provider === 'claude' && target.model === 'fable' && !providerAccounts.some((account) => account.tier === 'T3')) {
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

function tierCandidates(symbol: TargetTier, route: Route, context: TierResolveContext): Array<{ target: RouteTarget; label: string }> {
  if (symbol === 'T3') {
    // fable intentionally has no lane_default, so it can never auto-join HED-106. A requested T3
    // symbol is explicit policy and may target it, then descend through the existing T2→T0 ladder.
    const direct = lanesInTier(context.lanes, 'T3-orchestrator' as never).includes('fable')
      ? [{ target: enrich(route, { provider: 'claude', model: 'fable' }), label: 'T3:fable' }]
      : [];
    const descended = buildLadder('T2', 'T0', 'T2', context.lanes, context.laneDefaults, () => true)
      .map((candidate) => ({ target: enrich(route, candidate.target), label: `T3→${candidate.tier}` }));
    return [...direct, ...descended];
  }
  const tier = symbol as Tier;
  return buildLadder(tier, tier, tier, context.lanes, context.laneDefaults, () => true)
    .map((candidate) => ({ target: enrich(route, candidate.target), label: symbol }));
}

function fallbackCandidates(route: Route, context: TierResolveContext): Array<{ target: RouteTarget; label: string }> {
  const candidates: Array<{ target: RouteTarget; label: string }> = [];
  if (route.fallback) candidates.push({ target: route.fallback, label: 'declared-fallback' });
  const excluded = new Set([route.provider, route.fallback?.provider].filter(Boolean));
  const maxTier = route.maxTier ?? tierOfProvider(route.provider, context.lanes, context.laneDefaults) ?? DEFAULT_MIN_TIER;
  for (const candidate of buildLadder(
    tierOfProvider(route.provider, context.lanes, context.laneDefaults), route.minTier ?? DEFAULT_MIN_TIER, maxTier,
    context.lanes, context.laneDefaults, (target) => !excluded.has(target.provider),
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
      : [{ target: enrich(route, entry), label: entryLabel }];
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
