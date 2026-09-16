#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// Native clients start stdio servers with different cwd/env conventions. Bind the workspace before
// importing either existing server (both resolve process identity at startup).
import { resolveClientWorkspace } from './client-workspace.js';

try {
  const [server, cwd, ...extra] = process.argv.slice(2);
  if (!cwd || extra.length || !['heddle', 'heddle-comms'].includes(server)) {
    throw new Error('usage: client-mcp <heddle|heddle-comms> <workspace>');
  }
  process.chdir(resolveClientWorkspace(cwd, [process.cwd()]));
  process.env.HEDDLE_COMMS_TRANSPORT = 'stdio';
  process.env.HEDDLE_COMMS_PUSH = '0';
  // Do not erase HEDDLE_WORKER/parent/dispatch identity: nested dispatch restrictions still apply.
  if (server === 'heddle') await import('./mcp-server.js');
  else await import('./comms/channel-server.js');
} catch (error) {
  process.stderr.write(`heddle client MCP: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
