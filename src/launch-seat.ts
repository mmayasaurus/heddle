/**
 * HED-669 — resolve the Claude account SEAT (the CLAUDE_CONFIG_DIR) a single project agent should
 * launch on, by REUSING the deterministic weighted-LPT spread in `pickClaudeAccountsBatch`
 * (src/account-pick.ts). A per-project session launcher calls the `heddle account seat <project>
 * <agent>` CLI (src/cli.ts) at launch time so each agent lands on a spread-out account instead of
 * whatever login the shell inherited.
 *
 * This module is the PURE core: no filesystem, no process, no env. The CLI assembles the inputs
 * (accounts, caps, floors, project registry, seat weights) exactly the way `heddle account pick`
 * already does and hands them here; this function does the project scoping + assignment extraction
 * and returns a discriminated result the CLI turns into stdout/stderr/exit.
 *
 * FAIL-LOUD is the whole point. A prior incident had an agent silently land on the default login /
 * the most-loaded account because a launcher fell through when the seat could not resolve. So there
 * is NO fallback here: a refused batch assignment, an agent that is not in the project, an unknown
 * project, OR an assignment to the default-login account (configDir null) all return `{ ok: false }`
 * with a reason — never a configDir the caller might mistake for a real seat.
 *
 * RESIDENCY IS DELIBERATELY NOT CENSUSED HERE. Unlike `heddle account pick --for R,S,T` (one call,
 * whole batch), this resolver is invoked ONCE PER AGENT by a launcher. Feeding it a live resident
 * census would count each just-launched sibling and re-place the rest of the project around it, so
 * call order would change every agent's seat and could stack two agents on one account — the exact
 * failure this command exists to prevent. Spreading over the project's FULL `agentIds` with an empty
 * census makes each per-agent call recompute the SAME deterministic split and simply read off one
 * agent's seat. Callers that genuinely want residency-aware placement may pass `residentsByAccount`.
 */
import { pickClaudeAccountsBatch, type ResidentLoad } from './account-pick.js';
import type { ClaudeAccount } from './capaware.js';
import type { ClaudeFloors } from './floors.js';
import type { ProjectRegistry } from './projects.js';
import type { ProviderCaps } from './usage.js';

export interface LaunchSeatInput {
  /** The loaded project↔fleet registry (src/projects.ts). */
  registry: ProjectRegistry;
  /** Project name to resolve within — matched exactly against `Project.name`. */
  projectName: string;
  /** Requested agent id — matched case-insensitively against the project's `agentIds`. */
  agent: string;
  /** USABLE Claude caps (the caller must have gated freshness, e.g. via usableClaudeCaps). */
  caps: ProviderCaps;
  /** Claude account registry rows (src/capaware.ts readClaudeAccounts). */
  accounts: ClaudeAccount[];
  /** Ratified floors from lanes.yaml (src/floors.ts claudeFloorsFrom). */
  floors: ClaudeFloors;
  /** Residency load per account. Defaults to EMPTY — see the module note on per-agent invocation. */
  residentsByAccount?: ReadonlyMap<string, ResidentLoad>;
  /** Seat-weight lookup for LPT ordering. Defaults to unit weights (matches pickClaudeAccountsBatch). */
  weightOf?: (letter: string) => number;
}

export type LaunchSeatResult =
  | { ok: true; configDir: string; account: string; agent: string; reason: string }
  | { ok: false; reason: string };

/**
 * Resolve the CLAUDE_CONFIG_DIR seat for one (project, agent) pair. Pure over its inputs; never
 * throws for a resolution failure — every failure is a `{ ok: false, reason }` the caller renders
 * loudly. See the module doc for the fail-loud contract and why residency is not censused.
 */
export function resolveLaunchSeat(input: LaunchSeatInput): LaunchSeatResult {
  const { registry, projectName, agent, caps, accounts, floors } = input;

  const project = registry.projects.find((candidate) => candidate.name === projectName);
  if (!project) {
    const known = registry.projects.map((candidate) => candidate.name);
    return {
      ok: false,
      reason: `project "${projectName}" is not in the registry (${known.length ? `known: ${known.join(', ')}` : 'no projects registered'})`,
    };
  }

  // Membership is case-insensitive (mirrors projectForAgent), but pickClaudeAccountsBatch keys its
  // assignment map by the EXACT id string in project.agentIds — so map the requested agent to its
  // canonical registry id before indexing, or a case difference would look like "no seat computed".
  const canonical = project.agentIds.find((id) => id.toLowerCase() === agent.toLowerCase());
  if (!canonical) {
    return {
      ok: false,
      reason: `agent "${agent}" is not in project "${project.name}" (agents: ${project.agentIds.join(', ')})`,
    };
  }

  // Spread the WHOLE project agent set, then read off this agent's assignment — that is what makes the
  // per-agent result a real spread rather than "the single best account for one agent".
  const { assignments } = pickClaudeAccountsBatch(
    caps, accounts, floors, project.agentIds, input.residentsByAccount ?? new Map(), input.weightOf,
  );
  const assignment = assignments[canonical];

  // Defensive: canonical ∈ project.agentIds, so the batch always produced a key for it. Fail loud
  // rather than emit an undefined seat if that invariant is ever broken.
  if (!assignment) {
    return { ok: false, reason: `no seat computed for agent "${canonical}" in project "${project.name}"` };
  }
  if ('refused' in assignment) {
    return { ok: false, reason: `no Claude account seat for "${canonical}" in project "${project.name}": ${assignment.reason}` };
  }
  // A launcher seat MUST be an explicit CLAUDE_CONFIG_DIR. The spread can legitimately place an agent
  // on the default-login account (configDir null) — but a launcher cannot express "the default login"
  // by SETTING CLAUDE_CONFIG_DIR, and silently falling through to the shell's inherited login is the
  // exact incident this command exists to prevent. So a null / unset configDir is a loud no-seat.
  if (assignment.unsetConfigDir || assignment.configDir === null) {
    return {
      ok: false,
      reason: `agent "${canonical}" in project "${project.name}" resolved to ${assignment.account}, which is the default login (no CLAUDE_CONFIG_DIR) — refusing to emit a seat rather than silently fall back to the default login`,
    };
  }
  return { ok: true, configDir: assignment.configDir, account: assignment.account, agent: canonical, reason: assignment.reason };
}
