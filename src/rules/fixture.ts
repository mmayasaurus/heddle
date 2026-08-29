import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { evaluateRules, type EvalContext, type HookPayload } from './evaluate.js';
import { renderMatches } from './render.js';
import { parseRule } from './schema.js';

export interface FixtureResult { name: string; pass: boolean; message: string; stdout: string; stderr: string }
type Expected = { outcome: 'none' | 'nudge' | 'inject' | 'block'; stdout_includes?: string; stderr_includes?: string; permissionDecision?: 'deny' };
type FixtureCase = { name: string; payload: HookPayload; env?: Record<string, unknown>; expect: Expected };
type RenderedOutput = { hookSpecificOutput?: { additionalContext?: string; permissionDecision?: string } };

class FixtureRuleError extends Error {
  constructor(message: string, readonly stderr: string) { super(message); }
}

class FixtureRenderError extends Error {
  constructor(message: string, readonly stdout: string) { super(message); }
}

function template(message: string, payload: HookPayload, agent: string, rule: string): string {
  const values: Record<string, string> = { tool_name: payload.tool_name ?? '', cwd: typeof payload.cwd === 'string' ? payload.cwd : '', agent, rule };
  return message.replace(/{{([^}]+)}}/g, (_all, name: string) => values[name] ?? '');
}

function loadFixtureRule(rulesDir: string, ruleId: string) {
  const parsed = parseRule(parseYaml(readFileSync(join(rulesDir, `${ruleId}.yaml`), 'utf8')), ruleId);
  if (!parsed.ok) throw new FixtureRuleError(parsed.error, `heddle-hook: rule '${ruleId}.yaml' ignored: ${parsed.error}`);
  return parsed.rule;
}

function evaluateFixtureCase(item: FixtureCase, rulesDir: string, ruleId: string): Pick<FixtureResult, 'pass' | 'message' | 'stdout' | 'stderr'> {
  if (!item.payload || typeof item.payload !== 'object' || Array.isArray(item.payload)) throw new Error('payload must be an object');
  const rule = loadFixtureRule(rulesDir, ruleId);
  const event = item.payload.hook_event_name;
  if (typeof event !== 'string') throw new Error('payload hook_event_name must be a string');
  const env = item.env ?? {};
  const agentRole = String(env.HEDDLE_WORKER) === '1' ? 'worker' : 'orchestrator';
  const agent = String(env.HEDDLE_AGENT ?? env.FLEET_AGENT ?? '');
  const isSubagent = Boolean(item.payload.agent_id) || event === 'SubagentStop';
  const matches = evaluateRules([rule], { event, payload: item.payload, isSubagent, agentRole, agent } as EvalContext)
    .filter((outcome) => outcome.verdict === 'match')
    .map(({ rule: matchedRule }) => ({ rule: matchedRule, message: `${matchedRule.action === 'block' && !matchedRule.enforce ? '(would block) ' : ''}${template(matchedRule.message, item.payload, agent, matchedRule.id)}` }));
  const stdout = renderMatches(event, matches);
  let output: RenderedOutput;
  try { output = JSON.parse(stdout) as RenderedOutput; }
  catch (err) { throw new FixtureRenderError(err instanceof Error ? err.message : String(err), stdout); }
  const permissionDecision = output.hookSpecificOutput?.permissionDecision;
  const actual = stdout === '{}' ? 'none' : permissionDecision === 'deny' ? 'block' : permissionDecision ? `unexpected:${permissionDecision}` : rule.action;
  const stderr = '';
  const pass = actual === item.expect.outcome
    && (!item.expect.stdout_includes || stdout.includes(item.expect.stdout_includes))
    && (!item.expect.stderr_includes || stderr.includes(item.expect.stderr_includes))
    && (!item.expect.permissionDecision || permissionDecision === item.expect.permissionDecision);
  return { pass, message: pass ? 'passed' : `expected ${item.expect.outcome}, got ${actual}`, stdout, stderr };
}

function caseResult(line: string, rulesDir: string, ruleId: string): FixtureResult {
  let name = '<invalid fixture>';
  try {
    const item = JSON.parse(line) as FixtureCase;
    name = item.name;
    return { name, ...evaluateFixtureCase(item, rulesDir, ruleId) };
  } catch (err) {
    return { name, pass: false, message: err instanceof Error ? err.message : String(err), stdout: err instanceof FixtureRenderError ? err.stdout : '{}', stderr: err instanceof FixtureRuleError ? err.stderr : '' };
  }
}

export function runFixtureFile(rulesDir: string, ruleId: string, fixturePath: string): FixtureResult[] {
  try { return readFileSync(fixturePath, 'utf8').split(/\r?\n/).filter((line) => line.trim().length > 0).map((line) => caseResult(line, rulesDir, ruleId)); }
  catch (err) { return [{ name: '<fixture file>', pass: false, message: err instanceof Error ? err.message : String(err), stdout: '{}', stderr: '' }]; }
}

export function discoverFixtures(_rulesDir: string, fixturesDir: string): Array<{ ruleId: string; fixturePath: string }> {
  try {
    return readdirSync(fixturesDir, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map((entry) => ({ ruleId: entry.name.slice(0, -'.jsonl'.length), fixturePath: join(fixturesDir, entry.name) }))
      .sort((a, b) => a.ruleId.localeCompare(b.ruleId));
  } catch { return []; }
}
