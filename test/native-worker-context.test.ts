import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
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
import { ensureBuilt, PROJECT_ROOT } from './helpers/build.js';
import { withFileLock } from '../src/matlock.js';

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
  const { tempDir: tempAlias, tempLedger } = useTempResources('heddle-native-worker-context-');
  const tempDir = () => realpathSync(tempAlias());

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

  it('refuses another process while a native context is owned and accepts a clean retry', async () => {
    await ensureBuilt();
    const cwd = tempDir(), path = join(cwd, '.cursor', 'mcp.json');
    const original = install(cwd, 'cursor', path);
    const context = {
      HEDDLE_WORKER: '1', HEDDLE_DISPATCH_ID: '1', HEDDLE_PARENT: 'U',
      HEDDLE_AGENT: 'U.1', FLEET_AGENT: 'U.1', HEDDLE_COMMS_ADDRESS: 'U.1',
    };
    const restore = materializeWorkerMcp(cwd, 'cursor', [], { dispatchId: 1 }, context);
    const active = readFileSync(path, 'utf8');
    const source = `
      import { materializeWorkerMcp } from ${JSON.stringify(pathToFileURL(join(PROJECT_ROOT, 'dist/mcp.js')).href)};
      try {
        const restore = materializeWorkerMcp(${JSON.stringify(cwd)}, 'cursor', [], { dispatchId: 2 },
          ${JSON.stringify({ ...context, HEDDLE_DISPATCH_ID: '2', HEDDLE_AGENT: 'U.2', FLEET_AGENT: 'U.2', HEDDLE_COMMS_ADDRESS: 'U.2' })});
        restore();
        process.stdout.write('restored');
      } catch (error) { process.stdout.write(error.message); }
    `;
    const attempt = () => execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', source], {
      cwd, encoding: 'utf8', timeout: 10_000,
    });
    try {
      expect(attempt()).toMatch(/owned by active dispatch #1/);
      expect(readFileSync(path, 'utf8')).toBe(active);
    } finally { restore(); }
    expect(readFileSync(path, 'utf8')).toBe(original);
    expect(attempt()).toBe('restored');
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  it('required native locks refuse unavailable locks without running the mutation', () => {
    const cwd = tempDir(), lock = join(cwd, 'held.lock');
    mkdirSync(lock);
    let mutations = 0;
    expect(() => withFileLock(lock, () => { mutations++; }, { required: true })).toThrow(/required file lock/);
    expect(() => withFileLock(join(cwd, 'missing', 'lock'), () => { mutations++; }, { required: true })).toThrow();
    expect(mutations).toBe(0);
  });

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

  it('refuses dispatch from a mismatched installation before invoking a native worker or minting a child', async () => {
    const cwd = tempDir(), path = join(cwd, '.cursor', 'mcp.json');
    install(cwd, 'cursor', path);
    const config = JSON.parse(readFileSync(path, 'utf8'));
    config.mcpServers.heddle.args[1] = '/another/heddle/dist/client-mcp.js';
    writeFileSync(path, JSON.stringify(config));
    process.env.HEDDLE_COMMS_DB = join(tempDir(), 'must-not-exist.db');
    let calls = 0;
    const outcome = await dispatch({
      provider: 'cursor', model: 'cursor-grok-4.6-high', cwd, prompt: 'inspect stale config',
      overrideReason: 'Verify stale installation cannot expose parent identity to workers.', identity: IDENTITIES.boundU,
    }, tempLedger(), () => ({
      provider: 'cursor', name: 'must-not-run',
      async dispatch() { calls++; return { ok: true, output: 'unexpected', exitCode: 0 }; },
    }));
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/unverified Heddle MCP entries/);
    expect(calls).toBe(0);
    expect(existsSync(process.env.HEDDLE_COMMS_DB!)).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe(JSON.stringify(config));
  });

  it('refuses strict native dispatch recognition through a config or config-directory symlink', () => {
    const source = tempDir(), sourcePath = join(source, '.cursor', 'mcp.json');
    install(source, 'cursor', sourcePath);
    for (const linkDirectory of [false, true]) {
      const cwd = tempDir();
      if (linkDirectory) symlinkSync(dirname(sourcePath), join(cwd, '.cursor'), 'dir');
      else {
        mkdirSync(join(cwd, '.cursor'));
        symlinkSync(sourcePath, join(cwd, '.cursor', 'mcp.json'));
      }
      expect(() => nativeClientIntegrationInstalled(cwd, 'cursor', true)).toThrow(/unverified Heddle MCP entries/);
      expect(nativeClientIntegrationInstalled(cwd, 'cursor')).toBe(false);
    }
  });

  it('rejects cwd and higher-ancestor aliases even when wrapper ownership resolves to the same directory', () => {
    const parent = tempDir(), cwd = join(parent, 'project');
    mkdirSync(cwd);
    const path = join(cwd, '.cursor', 'mcp.json');
    const original = install(cwd, 'cursor', path);
    expect(nativeClientIntegrationInstalled(cwd, 'cursor', true)).toBe(true);
    const links = tempDir();
    symlinkSync(cwd, join(links, 'cwd-alias'), 'dir');
    symlinkSync(parent, join(links, 'ancestor-alias'), 'dir');
    for (const alias of [join(links, 'cwd-alias'), join(links, 'ancestor-alias', 'project')]) {
      expect(() => nativeClientIntegrationInstalled(alias, 'cursor', true)).toThrow(/unverified Heddle MCP entries/);
      expect(nativeClientIntegrationInstalled(alias, 'cursor')).toBe(false);
    }
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  it('restores parent identity after metadata-only edits to native worker server entries', () => {
    for (const row of clients.filter((row) => row.client !== 'codex')) {
      const cwd = tempDir(), path = join(cwd, row.relative);
      const original = install(cwd, row.client, path);
      const restore = materializeWorkerMcp(cwd, row.provider, [], { dispatchId: 1 }, {
        HEDDLE_WORKER: '1', HEDDLE_DISPATCH_ID: '1', HEDDLE_PARENT: 'U', HEDDLE_COMMS_ADDRESS: 'U.1',
        HEDDLE_AGENT: 'U.1', FLEET_AGENT: 'U.1', HEDDLE_LEDGER_DB: '/worker/ledger.db',
      });
      const config = JSON.parse(readFileSync(path, 'utf8'));
      const servers = config[row.client === 'opencode' ? 'mcp' : 'mcpServers'];
      for (const server of Object.values(servers) as Record<string, unknown>[]) server.description = 'metadata added by client';
      writeFileSync(path, JSON.stringify(config));
      restore();
      const final = JSON.parse(readFileSync(path, 'utf8'));
      const finalServers = final[row.client === 'opencode' ? 'mcp' : 'mcpServers'];
      const originalServers = JSON.parse(original)[row.client === 'opencode' ? 'mcp' : 'mcpServers'];
      for (const name of ['heddle', 'heddle-comms']) {
        expect(finalServers[name]).toEqual({ ...originalServers[name], description: 'metadata added by client' });
      }
      expect(readFileSync(path, 'utf8')).not.toContain('HEDDLE_WORKER');
      expect(readFileSync(path, 'utf8')).not.toContain('/worker/ledger.db');
    }
  });

  it('preserves deliberate command/env edits while clearing unchanged transient identity fields', () => {
    const cwd = tempDir(), path = join(cwd, 'opencode.json');
    install(cwd, 'opencode', path);
    const restore = materializeWorkerMcp(cwd, 'opencode', [], { dispatchId: 1 }, {
      HEDDLE_WORKER: '1', HEDDLE_DISPATCH_ID: '1', HEDDLE_PARENT: 'U', HEDDLE_COMMS_ADDRESS: 'U.1',
      HEDDLE_AGENT: 'U.1', FLEET_AGENT: 'U.1', HEDDLE_LEDGER_DB: '/worker/ledger.db',
    });
    const config = JSON.parse(readFileSync(path, 'utf8'));
    config.mcp.heddle.command = ['operator-selected-server'];
    config.mcp.heddle.environment.HEDDLE_LEDGER_DB = '/operator/selected-ledger.db';
    config.mcp.heddle.environment.CUSTOM_OPTION = 'preserve';
    writeFileSync(path, JSON.stringify(config));
    restore();
    const final = JSON.parse(readFileSync(path, 'utf8'));
    expect(final.mcp.heddle.command).toEqual(['operator-selected-server']);
    expect(final.mcp.heddle.environment).toMatchObject({
      HEDDLE_AGENT: 'installed-parent', FLEET_AGENT: 'installed-parent',
      HEDDLE_LEDGER_DB: '/operator/selected-ledger.db', CUSTOM_OPTION: 'preserve',
    });
    for (const name of ['heddle', 'heddle-comms']) {
      expect(final.mcp[name].environment).not.toHaveProperty('HEDDLE_WORKER');
      expect(final.mcp[name].environment).not.toHaveProperty('HEDDLE_COMMS_ADDRESS');
    }
  });

  it('refuses stale worker identity without its materialization ownership sidecar', () => {
    const cwd = tempDir(), path = join(cwd, '.cursor', 'mcp.json');
    install(cwd, 'cursor', path);
    const config = JSON.parse(readFileSync(path, 'utf8'));
    config.mcpServers.heddle.env.HEDDLE_WORKER = '1';
    config.mcpServers.heddle.env.HEDDLE_AGENT = 'U.1';
    writeFileSync(path, JSON.stringify(config));
    expect(() => nativeClientIntegrationInstalled(cwd, 'cursor', true)).toThrow(/unverified Heddle MCP entries/);
  });

  it('requires both owned wrapper entries before recognizing native initialization', () => {
    const cwd = tempDir(), path = join(cwd, '.cursor', 'mcp.json');
    install(cwd, 'cursor', path);
    const config = JSON.parse(readFileSync(path, 'utf8'));
    config.mcpServers['heddle-comms'].command = 'foreign-server';
    writeFileSync(path, JSON.stringify(config));
    expect(nativeClientIntegrationInstalled(cwd, 'cursor')).toBe(false);
    expect(() => materializeWorkerMcp(cwd, 'cursor', [], { dispatchId: 1 }, { HEDDLE_WORKER: '1' }))
      .toThrow(/unverified Heddle MCP entries/);
    expect(readFileSync(path, 'utf8')).toBe(JSON.stringify(config));
  });
});
