#!/usr/bin/env node
/**
 * Post one watcher message through heddle's canonical broker write path.
 * Any local process can run this helper and post as R at agent-message tier; this is residual
 * risk. If that becomes a problem, add an environment-token gate before permitting invocation.
 */
import { CommsLog } from '/Users/mayatobi/Developer/heddle/dist/comms/log.js';
import { Broker } from '/Users/mayatobi/Developer/heddle/dist/comms/broker.js';
import { ChannelTransport } from '/Users/mayatobi/Developer/heddle/dist/comms/bridge.js';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { classifyResult, validateArgs } from './comms-post-lib.mjs';

function usage(exitCode = 0) {
  const stream = exitCode ? process.stderr : process.stdout;
  stream.write('Usage: comms-post.mjs --to <KEY> --kind <KIND> --issue <IDENTIFIER> --body <TEXT>\n');
  process.exit(exitCode);
}

if (process.argv.slice(2).includes('--help') || process.argv.slice(2).includes('-h')) usage();
let credentials;
try {
  credentials = JSON.parse(readFileSync(
    `${homedir()}/.claude/spinventory-fleet/linear-agents.json`, 'utf8'));
} catch (error) {
  process.stderr.write(`comms-post: cannot read fleet agent credentials: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}
const validation = validateArgs(process.argv.slice(2), credentials.agents);
if (!validation.ok) {
  process.stderr.write(`${validation.error}\n`);
  process.exit(2);
}
const { values } = validation;

let log;
try {
  // address.js has no non-agent system identity: it accepts agent/child/operator senders only.
  // Bind the watcher as fleet orchestrator R; no operator credential is used.
  log = new CommsLog();
  log.ensureDefaultRooms();
  const broker = new Broker({ log, transport: new ChannelTransport(log) });
  const result = await broker.post({
    from: 'R', to: values.to, body: values.body, kind: values.kind,
    requestedTier: 'agent-message', issue: values.issue, meta: { transport: 'heddle-comms' },
  });
  const classification = classifyResult(result);
  if (!classification.deliverable) throw new Error(classification.error);
  process.stdout.write(JSON.stringify({ ...result, outcome: classification.outcome }) + '\n');
} catch (error) {
  process.stderr.write(`comms-post: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  try { log?.close(); } catch { /* preserve the original post result */ }
}
