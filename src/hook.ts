#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { fileURLToPath } from 'node:url';
import { evaluateRules, type HookPayload } from './rules/evaluate.js';
import { loadRules } from './rules/load.js';
import { renderMatches } from './rules/render.js';

const STDIN_IDLE_MS = 1500;
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []; let timer: NodeJS.Timeout | undefined;
    const done = () => { if (timer) clearTimeout(timer); resolve(Buffer.concat(chunks).toString('utf8')); };
    const arm = () => { if (timer) clearTimeout(timer); timer = setTimeout(done, STDIN_IDLE_MS); };
    process.stdin.on('data', (chunk: Buffer) => { chunks.push(chunk); arm(); }); process.stdin.on('end', done); process.stdin.on('error', done); arm();
  });
}
function arg(name: string): string | undefined { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; }
function renderTemplate(message: string, payload: HookPayload, agent: string, rule: string): string {
  const values: Record<string, string> = { tool_name: payload.tool_name ?? '', cwd: typeof payload.cwd === 'string' ? payload.cwd : '', agent, rule };
  return message.replace(/{{([^}]+)}}/g, (_all, name: string) => values[name] ?? '');
}
async function main(): Promise<string> {
  const raw = (await readStdin()).trim();
  const payload: HookPayload = JSON.parse(raw);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('hook payload must be an object');
  const event = payload.hook_event_name;
  if (typeof event !== 'string') throw new Error('payload hook_event_name must be a string');
  if (!['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop'].includes(event)) {
    process.stderr.write(`heddle-hook: unknown event '${event}' — no rules evaluated\n`);
    return '{}';
  }
  const argvEvent = arg('--event'); if (argvEvent && argvEvent !== event) process.stderr.write(`heddle-hook: --event '${argvEvent}' ignored; payload event '${event}' wins\n`);
  const rulesDir = arg('--rules') ?? process.env.HEDDLE_RULES_DIR ?? (process.env.CLAUDE_PROJECT_DIR ? `${process.env.CLAUDE_PROJECT_DIR}/rules` : fileURLToPath(new URL('../rules', import.meta.url)));
  const rules = loadRules(rulesDir);
  const isSubagent = Boolean(payload.agent_id) || event === 'SubagentStop';
  const agentRole = process.env.HEDDLE_WORKER === '1' ? 'worker' : 'orchestrator';
  const agent = process.env.HEDDLE_AGENT ?? process.env.FLEET_AGENT ?? '';
  const matches = evaluateRules(rules, { event, payload, isSubagent, agentRole, agent }).filter((outcome) => outcome.verdict === 'match')
    .map(({ rule }) => ({ rule, message: `${rule.action === 'block' && !rule.enforce ? '(would block) ' : ''}${renderTemplate(rule.message, payload, agent, rule.id)}` }));
  return renderMatches(event, matches);
}
try { process.stdout.write(`${await main()}\n`); }
catch (err) { process.stderr.write(`heddle-hook: FAILED OPEN: ${err instanceof Error ? err.message : String(err)}\n`); process.stdout.write('{}\n'); }
process.exitCode = 0;
process.stdin.destroy();
