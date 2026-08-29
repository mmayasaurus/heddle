import type { Rule } from './schema.js';

export interface HookPayload { hook_event_name?: string; tool_name?: string; tool_input?: Record<string, unknown>; cwd?: unknown; agent_id?: unknown; agent_type?: unknown; stop_hook_active?: unknown }
export interface EvalContext { event: string; payload: HookPayload; isSubagent: boolean; agentRole: 'orchestrator' | 'worker'; agent: string }
export type RuleOutcome = { rule: Rule; verdict: 'match' | 'no-match' | 'skip-event' | 'skip-subagent' | 'skip-role' };

function oneOf(value: string, matcher: string | string[]): boolean { return (Array.isArray(matcher) ? matcher : [matcher]).includes(value); }
function cwdMatches(cwd: string, prefixes: string | string[]): boolean {
  return (Array.isArray(prefixes) ? prefixes : [prefixes]).some((prefix) => cwd === prefix || cwd.startsWith(`${prefix}/`));
}

export function evaluateRules(rules: Rule[], ctx: EvalContext): RuleOutcome[] {
  return rules.map((rule) => {
    if (rule.event !== ctx.event) return { rule, verdict: 'skip-event' };
    if (ctx.isSubagent && !rule.subagent_aware) return { rule, verdict: 'skip-subagent' };
    if (rule.match.agent_role !== 'any' && rule.match.agent_role !== ctx.agentRole) return { rule, verdict: 'skip-role' };
    if (rule.match.tool && (!ctx.payload.tool_name || !oneOf(ctx.payload.tool_name, rule.match.tool))) return { rule, verdict: 'no-match' };
    if (rule.match.input) {
      if (!ctx.payload.tool_input || !Object.entries(rule.match.input).every(([key]) => {
        const regex = rule.inputRegexes.get(key);
        if (!regex) return false;
        regex.lastIndex = 0;
        return regex.test(String(ctx.payload.tool_input![key]));
      })) return { rule, verdict: 'no-match' };
    }
    if (rule.match.cwd && (typeof ctx.payload.cwd !== 'string' || !cwdMatches(ctx.payload.cwd, rule.match.cwd))) return { rule, verdict: 'no-match' };
    return { rule, verdict: 'match' };
  });
}
