import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { serverDefinitions, type FleetClient } from '../src/client-config.js';
import { dispatch } from '../src/dispatch.js';
import { buildWorkerEnv } from '../src/env.js';
import { CommsLog } from '../src/comms/log.js';
import { materializeWorkerMcp, nativeClientIntegrationInstalled } from '../src/mcp.js';
import type { DispatchOptions, WorkerAdapter } from '../src/types.js';
import { IDENTITIES, useTempResources } from './helpers.js';
import { ensureBuilt } from './helpers/build.js';

const savedEnv = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

const clients = [
  { client: 'codex', provider: 'codex', model: 'gpt-5.6-luna', relative: '.codex/config.toml' },
  { client: 'cursor', provider: 'cursor', model: 'cursor-grok-4.6-high', relative: '.cursor/mcp.json' },
  { client: 'gemini', provider: 'gemini-cli', model: 'gemini-3.1-pro-preview', relative: '.gemini/settings.json' },
  { client: 'opencode', provider: 'opencode', model: 'opencode/nemotron-3-ultra-free', relative: 'opencode.json' },
] as const;

type Definition = { command: string; args: string[]; env: Record<string, string> };
function install(cwd: string, client: FleetClient, path: string): string {
  const definitions = serverDefinitions(cwd, client, 'installed-parent');
  const original = client === 'codex' ? stringifyToml({ mcp_servers: definitions })
    : client === 'opencode' ? JSON.stringify({ mcp: Object.fromEntries(Object.entries(definitions).map(([name, def]) => [name, {
      type: 'local', command: [def.command, ...def.args], environment: def.env, enabled: true,
    }])) }) : JSON.stringify({ mcpServers: definitions });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, original);
  return original;
}

function workerDefinitions(client: FleetClient, path: string, opts: DispatchOptions): Record<string, Definition> {
  if (client === 'codex') {
    // Codex -c uses dotted keys literally (not a TOML table parser). Reject quoted name segments.
    const servers: Record<string, Record<string, unknown>> = {};
    const flags = opts.extraFlags ?? [];
    for (let i = 0; i < flags.length; i++) {
      if (flags[i] !== '-c') continue;
      const match = /^mcp_servers\.(heddle|heddle-comms)\.([\w.]+)=(.*)$/.exec(flags[++i]);
      if (match) {
        const server = servers[match[1]] ??= {};
        const value = parseToml(`value=${match[3]}`).value;
        if (match[2].startsWith('env.')) {
          const env = (server.env ??= {}) as Record<string, unknown>;
          env[match[2].slice(4)] = value;
        } else server[match[2]] = value;
      }
    }
    expect(servers.heddle.default_tools_approval_mode).toBe('approve');
    expect(servers['heddle-comms'].default_tools_approval_mode).toBe('approve');
    return servers as unknown as Record<string, Definition>;
  }
  const config = JSON.parse(readFileSync(path, 'utf8'));
  if (client !== 'opencode') return config.mcpServers;
  return Object.fromEntries(Object.entries(config.mcp as Record<string, { command: string[]; environment: Record<string, string> }>).map(([name, def]) => [name, {
    command: def.command[0], args: def.command.slice(1), env: def.environment,
  }]));
}

async function withMcp<T>(definition: Definition, home: string, action: (peer: Client) => Promise<T>): Promise<T> {
  const peer = new Client({ name: 'native-worker-regression', version: '1' });
  // Simulate a client such as Cursor dropping every ambient Heddle variable. Only configured env
  // plus an unrelated temporary HOME is available to the real MCP subprocess.
  const transport = new StdioClientTransport({
    command: definition.command, args: definition.args,
    env: { PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home, ...definition.env }, stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  try {
    await peer.connect(transport);
    return await action(peer);
  } catch (error) {
    throw new Error(`Worker MCP failed: ${String(error)} ${stderr}`);
  } finally {
    await peer.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
}

async function call(peer: Client, name: string, args: Record<string, unknown> = {}) {
  try {
    const response = await peer.callTool({ name, arguments: args }) as { content: { text: string }[]; isError?: boolean };
    expect(response.isError, response.content[0]?.text).not.toBe(true);
    return JSON.parse(response.content[0].text);
  } catch (error) { throw new Error(`${name}: ${String(error)}`); }
}

describe('native worker context through actual MCP subprocesses', () => {
  const { tempDir, tempLedger } = useTempResources('heddle-native-worker-context-');

  for (const row of clients) {
    it(`${row.provider} overrides installed parent identity, shares the broker/ledger, and refuses nesting`, async () => {
      await ensureBuilt();
      const cwd = tempDir(), home = tempDir(), commsDb = join(tempDir(), 'comms.db');
      process.env.HEDDLE_COMMS_DB = commsDb;
      process.env.HEDDLE_PROJECTS = join(tempDir(), 'projects.json');
      process.env.HEDDLE_AGENT = 'ambient-parent';
      process.env.FLEET_AGENT = 'ambient-parent';
      const ledger = tempLedger();
      // The passed ledger is authoritative, even if ambient configuration points elsewhere.
      process.env.HEDDLE_LEDGER_DB = join(tempDir(), 'wrong-ledger.db');
      const path = join(cwd, row.relative);
      const original = install(cwd, row.client, path);
      writeFileSync(join(cwd, '.fleet-agent'), 'file-parent');
      let inspected = false;
      const adapter: WorkerAdapter = {
        name: 'native-context-probe', provider: row.provider,
        async dispatch(_prompt, opts) {
          try {
            const definitions = workerDefinitions(row.client, path, opts);
            const cliEnv = buildWorkerEnv({ overrides: opts.env }).env;
            expect(cliEnv.HEDDLE_AGENT).toBeUndefined();
            expect(cliEnv.FLEET_AGENT).toBeUndefined();
            const hookContext = JSON.parse(execFileSync(process.execPath, ['-e',
              'process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k])=>["HEDDLE_WORKER","HEDDLE_DISPATCH_ID","HEDDLE_PARENT","HEDDLE_COMMS_ADDRESS","HEDDLE_COMMS_DB","HEDDLE_LEDGER_DB","HEDDLE_PROJECTS"].includes(k)))))',
            ], { cwd, env: cliEnv, encoding: 'utf8' }));
            expect(hookContext).toMatchObject({
              HEDDLE_WORKER: '1', HEDDLE_PARENT: 'U', HEDDLE_COMMS_ADDRESS: 'U.1',
              HEDDLE_LEDGER_DB: ledger.path, HEDDLE_COMMS_DB: commsDb,
              HEDDLE_PROJECTS: process.env.HEDDLE_PROJECTS,
            });
            for (const definition of Object.values(definitions)) expect(definition.env).toMatchObject({
              ...hookContext, HEDDLE_AGENT: 'U.1', FLEET_AGENT: 'U.1',
            });
            if (row.client === 'cursor') expect(opts.extraFlags).toEqual(expect.arrayContaining(['--force', '--approve-mcps']));
            await withMcp(definitions['heddle-comms'], home, async (peer) => {
              expect(await call(peer, 'comms_whoami')).toMatchObject({ identity: 'U.1', worker: true });
              const sent = await call(peer, 'post_message', { to: 'U', body: `${row.provider} worker report` });
              expect(sent.outcome).not.toBe('refused');
            });
            await withMcp(definitions.heddle, home, async (peer) => {
              const denied = await call(peer, 'dispatch_worker', { prompt: 'nested must refuse', provider: 'codex', model: 'test' });
              expect(denied).toMatchObject({ ok: false, refusal: { code: 'depth-1' } });
              expect(ledger.getWithOutput(denied.ledgerId)).toMatchObject({ refusal: 'depth-1', orchestrator: 'U' });
            });
            inspected = true;
            return { ok: true, output: 'verified worker context', exitCode: 0 };
          } catch (error) { throw new Error(`Native worker probe: ${String(error)}`); }
        },
      };
      const outcome = await dispatch({
        provider: row.provider, model: row.model, cwd, prompt: 'inspect native context',
        overrideReason: 'Synthetic subprocess verifies native worker communication lineage.', identity: IDENTITIES.boundU,
      }, ledger, () => adapter);
      expect(outcome.ok, outcome.error).toBe(true);
      expect(inspected).toBe(true);
      expect(readFileSync(path, 'utf8')).toBe(original);
      expect(existsSync(join(home, '.heddle', 'ledger.db'))).toBe(false);
      expect(existsSync(join(home, '.heddle', 'comms.db'))).toBe(false);
      expect(existsSync(process.env.HEDDLE_LEDGER_DB!)).toBe(false);
      const log = new CommsLog(commsDb, { readOnly: true });
      try { expect(log.participant('U.1')).toMatchObject({ parent: 'U', dispatchId: outcome.ledgerId }); }
      finally { log.close(); }
    });
  }

  it('does not create a comms database in a generic uninitialized workspace', async () => {
    for (const row of clients) {
      const cwd = tempDir();
      process.env.HEDDLE_COMMS_DB = join(tempDir(), 'must-not-exist.db');
      const outcome = await dispatch({
        provider: row.provider, model: row.model, cwd, prompt: 'ordinary synthetic worker',
        overrideReason: 'Verify native provider alone does not initialize communication state.', identity: IDENTITIES.boundU,
      }, tempLedger(), () => ({
        name: 'generic', provider: row.provider,
        async dispatch(_prompt, opts) {
          expect(opts.env).not.toHaveProperty('HEDDLE_COMMS_ADDRESS');
          return { ok: true, output: 'ordinary worker', exitCode: 0 };
        },
      }));
      expect(outcome.ok, outcome.error).toBe(true);
      expect(existsSync(process.env.HEDDLE_COMMS_DB!)).toBe(false);
    }
  });

  it('requires both owned wrapper entries before recognizing native initialization', () => {
    const cwd = tempDir(), path = join(cwd, '.cursor', 'mcp.json');
    install(cwd, 'cursor', path);
    const config = JSON.parse(readFileSync(path, 'utf8'));
    config.mcpServers['heddle-comms'].command = 'foreign-server';
    writeFileSync(path, JSON.stringify(config));
    expect(nativeClientIntegrationInstalled(cwd, 'cursor')).toBe(false);
    const restore = materializeWorkerMcp(cwd, 'cursor', [], { dispatchId: 1 }, { HEDDLE_WORKER: '1' });
    expect(readFileSync(path, 'utf8')).toBe(JSON.stringify(config));
    restore();
  });
});
