#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
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
 *       "command": "node --disable-warning=ExperimentalWarning <heddle>/dist/hook-dispatch-guidance.js" } ] } ] }
 * `HEDDLE_ROUTING` is honored (same loader as the server), so an experiment table is checked too.
 */
/** Claude Code writes the payload and closes stdin; if a host ever left the pipe open, waiting for
 *  EOF would stall the dispatch until the hook timeout. Read until EOF OR this many ms of silence
 *  after the last byte, whichever comes first — fast either way. */
const STDIN_IDLE_MS = 1500;

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let timer: NodeJS.Timeout | undefined;
    const done = () => { if (timer) clearTimeout(timer); resolve(Buffer.concat(chunks).toString('utf8')); };
    const arm = () => { if (timer) clearTimeout(timer); timer = setTimeout(done, STDIN_IDLE_MS); };
    process.stdin.on('data', (c: Buffer) => { chunks.push(c); arm(); });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
    arm();
  });
}

async function main(): Promise<void> {
  const raw = (await readStdin()).trim();
  if (!raw) return;
  const payload: unknown = JSON.parse(raw);
  const out = hookResponse(payload, loadRouting());
  if (out) process.stdout.write(out + '\n');
}

try {
  await main();
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`heddle dispatch-guidance hook: ${msg} (failing open)\n`);
}
// No process.exit(): piped stdout can be asynchronous on some platforms and an early exit could
// truncate the JSON. stdin is consumed and nothing else is pending, so the loop drains and exits 0.
process.exitCode = 0;
// stdin may still be open (idle-timeout path) — drop our reference so the loop can drain and exit.
process.stdin.destroy();
