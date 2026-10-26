import { mcpAttachable, webCapable } from './mcp.js';
import type { RouteTarget, Tier } from './routing.js';

export function ladderEligible(
  target: RouteTarget,
  tier: Tier,
  opts: {
    mcp: string[];
    requiresWeb: boolean;
    grantedCapabilities: string[];
    editsCode: boolean;
    excluded: Set<string>;
  },
): boolean {
  return !opts.excluded.has(target.provider) &&
    !(opts.editsCode && tier === 'T0') && // T0 lanes are read-only by construction

    (opts.mcp.length === 0 || mcpAttachable(target.provider, opts.mcp)) &&
    (!opts.requiresWeb || webCapable(target.provider, opts.grantedCapabilities));
}
