import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { evaluateRules, type EvalContext, type HookPayload } from './evaluate.js';
import { renderMatches } from './render.js';
import { parseRule } from './schema.js';

export interface FixtureResult { name: string; pass: boolean; message: string; stdout: string; stderr: string }
type Expected = { outcome: 'none' | 'nudge' | 'inject' | 'block'; stdout_includes?: string; stderr_includes?: string; permissionDecision?: 'deny' };

function template(message: string, payload: HookPayload, agent: string, rule: string): string {
  const values: Record<string, string> = { tool_name: payload.tool_name ?? '', cwd: typeof payload.cwd === 'string' ? payload.cwd : '', agent, rule };
  return message.replace(/{{([^}]+)}}/g, (_all, name: string) => values[name] ?? '');
}

function caseResult(line: string, rulesDir: string, ruleId: string): FixtureResult {
  let name = '<invalid fixture>';
  let stdout = '{}';
  let stderr = '';
  try {
    const item = JSON.parse(line) as { name: string; payload: HookPayload; env?: Record<string, unknown>; expect: Expected };
    name = item.name;
    if (!item.payload || typeof item.payload !== 'object' || Array.isArray(item.payload)) throw new Error('payload must be an object');
    const rawRule = parseYaml(readFileSync(join(rulesDir, `${ruleId}.yaml`), 'utf8'));
    const parsed = parseRule(rawRule, ruleId);
    if (!parsed.ok) { stderr = `heddle-hook: rule '${ruleId}.yaml' ignored: ${parsed.error}`; throw new Error(parsed.error); }
    const event = item.payload.hook_event_name;
    if (typeof event !== 'string') throw new Error('payload hook_event_name must be a string');
    const env = item.env ?? {};
    const agentRole = env.HEDDLE_WORKER ? 'worker' : 'orchestrator';
    const agent = String(env.HEDDLE_AGENT ?? env.FLEET_AGENT ?? '');
    const isSubagent = Boolean(item.payload.agent_id) || event === 'SubagentStop';
    const matches = evaluateRules([parsed.rule], { event, payload: item.payload, isSubagent, agentRole, agent } as EvalContext)
      .filter((outcome) => outcome.verdict === 'match')
      .map(({ rule }) => ({ rule, message: `${rule.action === 'block' && !rule.enforce ? '(would block) ' : ''}${template(rule.message, item.payload, agent, rule.id)}` }));
    stdout = renderMatches(event, matches);
    const output = JSON.parse(stdout) as { hookSpecificOutput?: { additionalContext?: string; permissionDecision?: string } };
    const actual = stdout === '{}' ? 'none' : output.hookSpecificOutput?.permissionDecision === 'deny' ? 'block' : parsed.rule.action;
    const pass = actual === item.expect.outcome
      && (!item.expect.stdout_includes || stdout.includes(item.expect.stdout_includes))
      && (!item.expect.stderr_includes || stderr.includes(item.expect.stderr_includes))
      && (!item.expect.permissionDecision || output.hookSpecificOutput?.permissionDecision === item.expect.permissionDecision);
    return { name, pass, message: pass ? 'passed' : `expected ${item.expect.outcome}, got ${actual}`, stdout, stderr };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { name, pass: false, message, stdout, stderr };
  }
}

export function runFixtureFile(rulesDir: string, ruleId: string, fixturePath: string): FixtureResult[] {
  try { return readFileSync(fixturePath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => caseResult(line, rulesDir, ruleId)); }
  catch (err) { return [{ name: '<fixture file>', pass: false, message: err instanceof Error ? err.message : String(err), stdout: '{}', stderr: '' }]; }
}

export function discoverFixtures(_rulesDir: string, fixturesDir: string): Array<{ ruleId: string; fixturePath: string }> {
  try {
    return readdirSync(fixturesDir, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map((entry) => ({ ruleId: entry.name.slice(0, -'.jsonl'.length), fixturePath: join(fixturesDir, entry.name) }))
      .sort((a, b) => a.ruleId.localeCompare(b.ruleId));
  } catch { return []; }
}
