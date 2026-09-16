#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// Native clients start stdio servers with different cwd/env conventions. Bind the workspace before
// importing either existing server (both resolve process identity at startup).
import { resolveClientWorkspace } from './client-workspace.js';
import { parseAddress } from './comms/address.js';
import { resolveFleetIdentity } from './comms/server.js';
import { resolveIdentity } from './identity.js';

try {
  const [server, cwd, ...extra] = process.argv.slice(2);
  if (!cwd || extra.length || !['heddle', 'heddle-comms'].includes(server)) {
    throw new Error('usage: client-mcp <heddle|heddle-comms> <workspace>');
  }
  // Both native entrypoints must see the same validated agent/child environment chain.
  for (const key of ['HEDDLE_AGENT', 'FLEET_AGENT', 'HEDDLE_COMMS_ADDRESS']) {
    const kind = parseAddress(process.env[key]?.trim() ?? '')?.kind;
    if (kind !== 'agent' && kind !== 'child') delete process.env[key];
  }
  // The legacy resolver does not understand COMMS_ADDRESS; bridge its validated env fallback
  // before invoking it, so a valid explicit identity never triggers an unnecessary file walk.
  if (!process.env.HEDDLE_AGENT && !process.env.FLEET_AGENT && process.env.HEDDLE_COMMS_ADDRESS) {
    process.env.HEDDLE_AGENT = process.env.HEDDLE_COMMS_ADDRESS;
  }
  process.chdir(resolveClientWorkspace(cwd, [process.cwd()]));
  const accepted = resolveFleetIdentity(process.env, process.cwd(), () => {}, undefined, { allowPidBridge: false });
  if (resolveIdentity().agent !== accepted) {
    if (!accepted) throw new Error('native client has no valid fleet identity; repair its identity configuration');
    // The orchestration resolver does not recognize COMMS_ADDRESS. Preserve file attribution
    // when the resolvers already agree, and bridge only a validated fallback when they differ.
    process.env.HEDDLE_AGENT = accepted;
  }
  process.env.HEDDLE_COMMS_TRANSPORT = 'stdio';
  process.env.HEDDLE_COMMS_PUSH = '0';
  // Do not erase HEDDLE_WORKER/parent/dispatch identity: nested dispatch restrictions still apply.
  if (server === 'heddle') await import('./mcp-server.js');
  else await import('./comms/channel-server.js');
} catch (error) {
  process.stderr.write(`heddle client MCP: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
