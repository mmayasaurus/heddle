import { afterAll, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { childEnv, ensureBuilt, withTempHome, PROJECT_ROOT, type ChildOptions } from './cli.js';

export interface McpHarness {
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  listTools(): Promise<string[]>;
  stderr(): string;
  close(): Promise<void>;
}

export type McpOptions = ChildOptions;

const closers = new Set<() => Promise<void>>();

async function cleanup(): Promise<void> {
  // Take and clear the set FIRST, and settle rather than race: a close() that rejects must not fail
  // the afterEach hook (which would surface as a teardown error on an unrelated test, hiding whatever
  // actually went wrong) and must not leave a stale closer behind to be called again next time.
  const pending = [...closers];
  closers.clear();
  const outcomes = await Promise.allSettled(pending.map((close) => close()));
  for (const outcome of outcomes) {
    if (outcome.status === 'rejected') {
      // Report it — a server that would not shut down is worth knowing about, just not worth
      // failing an unrelated test over.
      process.stderr.write(`heddle test harness: MCP client close failed: ${String(outcome.reason)}\n`);
    }
  }
}

afterEach(cleanup);
afterAll(cleanup);

export async function startMcp(opts: McpOptions = {}): Promise<McpHarness> {
  await ensureBuilt();
  const { home, env } = childEnv({ ...opts, home: opts.home ?? withTempHome() });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['dist/mcp-server.js'],
    // PROJECT_ROOT, not `new URL(...).pathname`: a file URL's pathname stays percent-encoded, so a
    // checkout under a path containing a space would spawn the server in a directory that does not exist.
    cwd: PROJECT_ROOT,
    env,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'heddle-test-client', version: '0.0.1' });
  let serverStderr = '';
  const stderr = transport.stderr;
  stderr?.on('data', (chunk: Buffer | string) => {
    // The server logs its orphan sweep to stderr. Drain it to prevent pipe backpressure, while
    // retaining enough recent context for failures without allowing an unbounded test buffer.
    serverStderr = `${serverStderr}${chunk.toString()}`.slice(-8 * 1024);
  });
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    closers.delete(close);
    try {
      await client.close();
    } finally {
      // Client.close owns its transport, but call transport.close as a backstop for a connection
      // interrupted during initialization so a timed-out test cannot leave a server behind.
      await transport.close().catch(() => undefined);
    }
  };
  closers.add(close);
  try {
    await client.connect(transport);
  } catch (error) {
    await close();
    throw error;
  }
  return {
    async callTool(name, args) {
      const result = await client.callTool({ name, arguments: args });
      if (!('content' in result)) throw new Error(`MCP tool ${name} returned a task response, not a tool result`);
      return result as CallToolResult;
    },
    async listTools() {
      return (await client.listTools()).tools.map((tool) => tool.name);
    },
    stderr: () => serverStderr,
    close,
  };
}
