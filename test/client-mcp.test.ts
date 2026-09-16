import { join } from 'node:path';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';
import { parse as parseToml } from 'smol-toml';
import { FLEET_CLIENTS, planClientInstall } from '../src/client-config.js';
import { applyInstall } from '../src/init-project.js';
import { useTempResources } from './helpers.js';
import { ensureBuilt, PROJECT_ROOT } from './helpers/cli.js';

describe('mixed CLI fleet over real stdio MCP servers', () => {
  const { tempDir } = useTempResources('heddle-native-mcp-');
  function connections(clientHome: string) {
    const peers: Client[] = [];
    const common = { PATH: process.env.PATH ?? '', HOME: clientHome, USERPROFILE: clientHome, HEDDLE_COMMS_DB: join(clientHome, 'comms.db'), HEDDLE_LEDGER_DB: join(clientHome, 'ledger.db') };
    async function connect(name: string, command: string, args: string[], env: Record<string, string>) {
      const client = new Client({ name, version: '1' });
      peers.push(client);
      const transport = new StdioClientTransport({ command, args, env: { ...common, ...env }, stderr: 'pipe' });
      let stderr = '';
      transport.stderr?.on('data', (chunk) => { stderr += String(chunk); });
      try { await client.connect(transport); }
      catch (error) { throw new Error(`${name} MCP startup failed: ${String(error)} ${stderr}`); }
      return client;
    }
    async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
      try {
        const result = await client.callTool({ name, arguments: args }) as { content: { text: string }[]; isError?: boolean };
        expect(result.isError, result.content[0]?.text).not.toBe(true);
        return JSON.parse(result.content[0].text);
      } catch (error) { throw new Error(`${name} failed: ${String(error)}`); }
    }
    return { peers, connect, call };
  }
  it('all generated clients send and receive across the Claude broker, retain cursors and enforce worker limits', async () => {
    await ensureBuilt();
    const { peers, connect, call } = connections(realpathSync.native(tempDir()));
    try {
      const claude = await connect('claude', process.execPath, ['--disable-warning=ExperimentalWarning', join(PROJECT_ROOT, 'dist/comms/channel-server.js')], { HEDDLE_AGENT: 'claude-test' });
      expect(claude.getServerCapabilities()?.experimental).toHaveProperty('claude/channel');
      expect(claude.getInstructions()).toContain('<channel');
      for (const kind of FLEET_CLIENTS) {
        const dir = realpathSync.native(tempDir()), identity = `${kind}-test`;
        applyInstall(planClientInstall({ dir, clients: [kind], agent: identity }));
        const relative = { codex: '.codex/config.toml', cursor: '.cursor/mcp.json', gemini: '.gemini/settings.json', opencode: 'opencode.json' }[kind];
        const raw = readFileSync(join(dir, relative), 'utf8');
        const config = kind === 'codex' ? parseToml(raw) : JSON.parse(raw);
        const servers = config[kind === 'codex' ? 'mcp_servers' : kind === 'opencode' ? 'mcp' : 'mcpServers'];
        const def = servers['heddle-comms'];
        const command = kind === 'opencode' ? def.command[0] : def.command;
        const args = kind === 'opencode' ? def.command.slice(1) : def.args;
        const env = kind === 'opencode' ? def.environment : def.env;
        const peer = await connect(kind, command, args, { ...env, HEDDLE_COMMS_PUSH: '1' });
        expect(peer.getServerCapabilities()?.experimental).toBeUndefined();
        expect(peer.getInstructions()).toContain('check_inbox');
        expect(await call(peer, 'comms_whoami')).toMatchObject({ identity, pushEnabled: false, pushDelivery: 'off' });
        const sent = await call(claude, 'post_message', { to: identity, body: `hello ${kind}` });
        expect(sent.outcome).not.toBe('refused');
        const inbox = await call(peer, 'check_inbox');
        expect(inbox).toEqual(expect.arrayContaining([expect.objectContaining({ body: `hello ${kind}`, from: 'claude-test', tier: 'agent-message' })]));
        const cursor = Math.max(...inbox.map((m: { id: number }) => m.id));
        expect(await call(peer, 'check_inbox', { since_id: cursor })).toEqual([]);
        const reply = await call(peer, 'post_message', { to: 'claude-test', body: `${kind} replies` });
        expect(reply).not.toHaveProperty('sendMessage');
        expect(await call(claude, 'check_inbox')).toEqual(expect.arrayContaining([expect.objectContaining({ body: `${kind} replies`, from: identity })]));
        const target = peers.find((_p, index) => index === 1);
        if (kind !== 'codex' && target) {
          await call(peer, 'post_message', { to: 'codex-test', body: `${kind} to codex` });
          expect(await call(target, 'check_inbox')).toEqual(expect.arrayContaining([expect.objectContaining({ body: `${kind} to codex` })]));
        }
        const orchestration = servers.heddle;
        const worker = await connect(`${kind}-worker`, kind === 'opencode' ? orchestration.command[0] : orchestration.command,
          kind === 'opencode' ? orchestration.command.slice(1) : orchestration.args,
          { ...(kind === 'opencode' ? orchestration.environment : orchestration.env), HEDDLE_WORKER: '1', HEDDLE_PARENT: identity, HEDDLE_DISPATCH_ID: '1' });
        const denied = await call(worker, 'dispatch_worker', { prompt: 'Must never dispatch another worker', provider: 'codex', model: 'test', override_reason: 'Synthetic regression verifies the worker depth limit.' });
        expect(denied).toMatchObject({ ok: false, refusal: { code: 'depth-1' } });
      }
    } finally {
      await Promise.all(peers.map((peer) => peer.close().catch(() => undefined)));
    }
  }, 60_000);
  it('reuses a no-agent Cursor config for distinct launcher identities and unset file fallback after env sanitization', async () => {
    await ensureBuilt();
    const { peers, connect, call } = connections(realpathSync.native(tempDir()));
    try {
      const dir = realpathSync.native(tempDir());
      writeFileSync(join(dir, '.fleet-agent'), 'file-test');
      applyInstall(planClientInstall({ dir, clients: ['cursor'] }));
      const raw = readFileSync(join(dir, '.cursor/mcp.json'), 'utf8');
      const definition = JSON.parse(raw).mcpServers['heddle-comms'];
      const cases: Array<{ launcher: Record<string, string>; identity: string }> = [
        { launcher: { HEDDLE_AGENT: 'cursor-one', FLEET_AGENT: 'ignored-parent' }, identity: 'cursor-one' },
        { launcher: { FLEET_AGENT: 'cursor-two' }, identity: 'cursor-two' },
        { launcher: {}, identity: 'file-test' },
      ];
      for (const { launcher, identity } of cases) {
        // Native Cursor interpolation (set + unset behavior verified with `mcp list-tools`),
        // then its sanitized subprocess boundary: no ambient launcher env reaches the wrapper.
        const env = Object.fromEntries(Object.entries(definition.env as Record<string, string>).map(([key, value]) =>
          [key, value.replace(/\$\{([A-Z_]+):-\}/g, (_match, name: string) => launcher[name] ?? '')]));
        const peer = await connect(identity, definition.command, definition.args, env);
        expect(await call(peer, 'comms_whoami')).toMatchObject({ identity });
        if (peers.length > 1) {
          await call(peer, 'post_message', { to: 'cursor-one', body: `from ${identity}` });
          expect(await call(peers[0], 'check_inbox')).toEqual(expect.arrayContaining([
            expect.objectContaining({ from: identity, body: `from ${identity}` }),
          ]));
        }
      }
      expect(readFileSync(join(dir, '.cursor/mcp.json'), 'utf8')).toBe(raw);
    } finally {
      await Promise.all(peers.map((peer) => peer.close().catch(() => undefined)));
    }
  });
  it('resolves file identity in the intended workspace even when spawned elsewhere', async () => {
    await ensureBuilt();
    const { peers, connect, call } = connections(realpathSync.native(tempDir()));
    try {
      // No explicit identity still resolves the intended worktree even when spawned elsewhere.
      const dir = realpathSync.native(tempDir());
      writeFileSync(join(dir, '.fleet-agent'), 'file-test');
      const fromFile = await connect('file', process.execPath, [join(PROJECT_ROOT, 'dist/client-mcp.js'), 'heddle-comms', dir], {});
      expect(await call(fromFile, 'comms_whoami')).toMatchObject({ identity: 'file-test', bindingSource: 'fleet-file' });
    } finally {
      await Promise.all(peers.map((peer) => peer.close().catch(() => undefined)));
    }
  });
});
