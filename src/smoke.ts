import { CodexAdapter } from './adapters/codex.js';
import { CursorAdapter } from './adapters/cursor.js';
import type { WorkerAdapter } from './types.js';

/**
 * Manual smoke runner: `node dist/smoke.js <codex|cursor> "<prompt>" [model]`
 * Uses cheap defaults (gpt-5.6-luna / kimi-k3-high) and read-only-ish behavior; requires the
 * target CLI to be logged in.
 */
const [, , which, prompt, modelArg] = process.argv;

if (!which || !prompt) {
  console.error('usage: node dist/smoke.js <codex|cursor> "<prompt>" [model]');
  process.exit(2);
}

let adapter: WorkerAdapter;
let model: string;
if (which === 'codex') {
  adapter = new CodexAdapter('codex', 'read-only');
  model = modelArg ?? 'gpt-5.6-luna';
} else if (which === 'cursor') {
  adapter = new CursorAdapter();
  model = modelArg ?? 'kimi-k3-high';
} else {
  console.error(`unknown adapter: ${which}`);
  process.exit(2);
}

const res = await adapter.dispatch(prompt, { model, cwd: process.cwd(), timeoutMs: 180_000 });
const { raw, ...summary } = res;
console.log(JSON.stringify(summary, null, 2));
process.exit(res.ok ? 0 : 1);
