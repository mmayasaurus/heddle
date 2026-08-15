#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createCommsServer, initOperatorToken } from './server.js';

/**
 * heddle-comms bin — the comms broker as a Claude Code channel MCP server. All behaviour lives in
 * src/comms/server.ts (testable in-process); this file wires stdio, argv and signals.
 *
 *   heddle-comms                          run (spawned by Claude Code from .mcp.json)
 *   heddle-comms --init-operator-token    create ~/.heddle/operator.token once (0600); prints the path only
 *   heddle-comms --init-operator-token --rotate   replace it (the old token stops working immediately)
 */

if (process.argv.includes('--init-operator-token')) {
  const r = initOperatorToken(process.env, { rotate: process.argv.includes('--rotate') });
  process.stdout.write(
    `operator token ${r.action}: ${r.path}\n` +
    (r.action === 'kept' ? '(already existed — pass --rotate to replace it)\n' : '') +
    "Put in the operator session's .mcp.json env: HEDDLE_COMMS_ROLE=operator and HEDDLE_COMMS_OPERATOR_TOKEN=<contents of that file>. Never paste the value anywhere else.\n",
  );
  process.exit(0);
}

const server = createCommsServer({ env: process.env });
const bye = () => { void server.stop().finally(() => process.exit(0)); };
process.on('SIGTERM', bye); process.on('SIGINT', bye); process.stdin.on('close', bye);
await server.start(new StdioServerTransport());
