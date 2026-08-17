import { AgyAdapter } from './adapters/agy.js';
import { CodexAdapter } from './adapters/codex.js';
import { CursorAdapter } from './adapters/cursor.js';
import { isCursorNativeModel } from './capaware.js';
import type { WorkerAdapter } from './types.js';

/**
 * Manual smoke runner: `node dist/smoke.js <codex|cursor|agy> "<prompt>" [model] [resumeId]`
 * Requires the target CLI to be logged in.
 *
 * Defaults are SUBSCRIPTION-POOL models only (gpt-5.6-luna / composer-2.5 / gemini-3.6-flash-low).
 * HED-27: the cursor default used to be kimi-k3-high, which bills the metered "Other Models" pool —
 * the same dollar pool Cursor PR review draws on — and because this runner calls adapters DIRECTLY
 * it bypasses both the routing table's opt-in gate and the ledger. Following the README was enough
 * to spend real money. composer-2.5 is Cursor-native and the fastest verified model in the catalog
 * (1.8s vs kimi's 74s), so the safe default is also the better one. A metered model can still be
 * run deliberately — pass it explicitly WITH --opt-in.
 */
const [, , which, prompt, modelArg, resumeArg] = process.argv;

if (!which || !prompt) {
  console.error('usage: node dist/smoke.js <codex|cursor|agy> "<prompt>" [model] [resumeId]');
  process.exit(2);
}

let adapter: WorkerAdapter;
let model: string;
if (which === 'codex') {
  adapter = new CodexAdapter('codex', 'read-only');
  model = modelArg ?? 'gpt-5.6-luna';
} else if (which === 'cursor') {
  adapter = new CursorAdapter();
  model = modelArg ?? 'composer-2.5';
  // Explicitly naming a metered model is allowed, but never silently: this runner has no routing
  // table behind it, so the opt-in gate has to live here.
  if (!isCursorNativeModel(model) && !process.argv.includes('--opt-in')) {
    console.error(
      `refusing to smoke-test cursor model "${model}": it bills the metered "Other Models" pool ` +
      `shared with Cursor PR review. Use a Cursor-native model (composer-2.5, cursor-grok-*, auto), ` +
      `or pass --opt-in if spending the metered pool is what you intend.`,
    );
    process.exit(2);
  }
} else if (which === 'agy') {
  adapter = new AgyAdapter();
  model = modelArg ?? 'gemini-3.6-flash-low';
} else {
  console.error(`unknown adapter: ${which}`);
  process.exit(2);
}

const res = await adapter.dispatch(prompt, {
  model,
  cwd: process.cwd(),
  timeoutMs: 180_000,
  resume: resumeArg || undefined,
});
const { raw, ...summary } = res;
console.log(JSON.stringify(summary, null, 2));
process.exit(res.ok ? 0 : 1);
