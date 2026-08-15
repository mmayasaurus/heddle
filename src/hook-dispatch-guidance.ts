#!/usr/bin/env -S node --no-warnings=ExperimentalWarning
import { loadRouting } from './routing.js';
import { hookResponse } from './guidance.js';

/**
 * heddle dispatch-guidance hook — a Claude Code PreToolUse hook on `mcp__heddle__dispatch_worker`.
 *
 * Reads the hook payload on stdin, and when the dispatch trips a guidance rule (see guidance.ts)
 * prints the JSON that adds a warning to the orchestrator's context + a one-line systemMessage for
 * the operator. It never blocks and it FAILS OPEN: any error → note on stderr, exit 0, no stdout,
 * so a broken hook can never stall a dispatch fleet-wide.
 *
 * Register (user or project settings.json — same node + dist path pattern as the heddle MCP entry
 * in ~/.claude.json):
 *   "hooks": { "PreToolUse": [ { "matcher": "mcp__heddle__dispatch_worker",
 *     "hooks": [ { "type": "command", "timeout": 10,
 *       "command": "node --no-warnings=ExperimentalWarning <heddle>/dist/hook-dispatch-guidance.js" } ] } ] }
 * `HEDDLE_ROUTING` is honored (same loader as the server), so an experiment table is checked too.
 */
async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return;
  const payload: unknown = JSON.parse(raw);
  const out = hookResponse(payload, loadRouting());
  if (out) process.stdout.write(out + '\n');
}

try {
  await main();
} catch (err) {
  process.stderr.write(`heddle dispatch-guidance hook: ${(err as Error).message ?? String(err)} (failing open)\n`);
}
// No process.exit(): piped stdout can be asynchronous on some platforms and an early exit could
// truncate the JSON. stdin is consumed and nothing else is pending, so the loop drains and exits 0.
process.exitCode = 0;
