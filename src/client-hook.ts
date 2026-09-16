import { DatabaseSync } from 'node:sqlite';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { clientInbox, evaluateClientHook, renderClientHook, type ClientEvent } from './client-hooks.js';
import { clientStartupInstructions, parseFleetClients } from './client-config.js';
import { resolveCommsIdentity } from './comms/server.js';

const EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']);

function readInput(): Promise<string> {
  return new Promise((resolve, reject) => {
    let input = '';
    const timer = setTimeout(() => reject(new Error('hook input timed out')), 1500);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      input += chunk;
      if (input.length > 1024 * 1024) { clearTimeout(timer); reject(new Error('hook input exceeds 1 MiB')); process.stdin.destroy(); }
    });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(input); });
    process.stdin.on('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

function openState(path: string): DatabaseSync {
  // Receipts contain only hashed session keys and message IDs. Reject observed state symlinks.
  // As in secure-fs, hostile same-user pathname swaps are outside the guarantee: DatabaseSync
  // reopens a pathname and cannot consume the validated descriptor below.
  for (let p = path; ; p = dirname(p)) {
    try { if (lstatSync(p).isSymbolicLink()) throw new Error('symlinked native hook state'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (dirname(p) === p) break;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try { closeSync(openSync(path, 'wx', 0o600)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  // Validate the existing file through a no-follow descriptor too: the path may have changed
  // since the ancestor check. NONBLOCK prevents a substituted FIFO from wedging the hook.
  const fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let db: DatabaseSync;
  try {
    const opened = fstatSync(fd), current = lstatSync(path);
    if (!opened.isFile() || !current.isFile() || opened.dev !== current.dev || opened.ino !== current.ino) {
      throw new Error('native hook state must remain a regular file');
    }
    db = new DatabaseSync(path);
  } finally { closeSync(fd); }
  try {
    db.exec('PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS receipts (session TEXT PRIMARY KEY, last_id INTEGER NOT NULL);');
    return db;
  } catch (error) { db.close(); throw error; }
}

async function main(): Promise<void> {
  const [clientArg, eventArg, cwd, agent] = process.argv.slice(2);
  const clients = parseFleetClients(clientArg ?? '');
  if (clients.length !== 1 || !EVENTS.has(eventArg) || !cwd) throw new Error('usage: client-hook <client> <event> <cwd> [agent]');
  const client = clients[0], event = eventArg as ClientEvent;
  const input = await readInput();
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(input); }
  catch { throw new Error('invalid hook input JSON (contents omitted)'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('hook input must be an object');
  const env: NodeJS.ProcessEnv = { ...process.env, HEDDLE_COMMS_TRANSPORT: 'stdio', ...(agent && process.env.HEDDLE_WORKER !== '1' ? { HEDDLE_AGENT: agent, FLEET_AGENT: agent } : {}) };
  const result = evaluateClientHook(event, raw, cwd, env);
  // These clients support nonblocking context after tools, not in their before-tool response.
  // Re-evaluate nudges with the same arguments; enforced denials remain before-tool only.
  if (event === 'PostToolUse' && (client === 'cursor' || client === 'opencode')) {
    const before = evaluateClientHook('PreToolUse', raw, cwd, env);
    result.context = [before.context, result.context].filter(Boolean).join('\n');
  }
  let db: DatabaseSync | undefined;
  try {
    const session = raw.session_id ?? raw.conversation_id;
    const identity = resolveCommsIdentity(env, cwd, () => {}).identity;
    const canDeliver = event !== 'PreToolUse' && !(event === 'Stop' &&
      (raw.stop_hook_active || Number(raw.loop_count ?? 0) >= 5 || (raw.status !== undefined && raw.status !== 'completed')));
    if (canDeliver && typeof session === 'string' && session && identity) {
      const key = createHash('sha256').update(JSON.stringify([client, cwd, identity, session])).digest('hex');
      db = openState(env.HEDDLE_CLIENT_STATE_DB || join(homedir(), '.heddle', 'client-state.db'));
      db.exec('BEGIN IMMEDIATE');
      const row = db.prepare('SELECT last_id FROM receipts WHERE session=?').get(key) as { last_id: number } | undefined;
      const inbox = clientInbox(cwd, row?.last_id ?? 0, env);
      result.context = [result.context, inbox.context].filter(Boolean).join('\n');
      // This is a notification receipt, never an acknowledgement/read receipt in the broker.
      db.prepare('INSERT INTO receipts VALUES (?,?) ON CONFLICT(session) DO UPDATE SET last_id=max(last_id,excluded.last_id)').run(key, inbox.lastId);
      db.exec('COMMIT');
    }
    if (event === 'SessionStart') result.context = [clientStartupInstructions(), result.context].filter(Boolean).join('\n');
    process.stdout.write(JSON.stringify(renderClientHook(client, event, result, raw)) + '\n');
  } finally { db?.close(); }
}

try { await main(); }
catch (error) {
  // The ratified rules engine is fail-open, matching heddle-hook. Never print payload contents.
  process.stderr.write(`heddle native hook failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
  process.stdout.write('{}\n');
  process.exitCode = 0;
} finally { process.stdin.destroy(); }
