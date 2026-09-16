import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import { FLEET_CLIENTS, planClientInstall, type FleetClient } from '../src/client-config.js';
import { resolveClientWorkspace, sameClientWorkspace } from '../src/client-workspace.js';
import { nativeClientIntegrationInstalled } from '../src/mcp.js';
import { applyInstall } from '../src/init-project.js';
import { useTempResources } from './helpers.js';
import { childEnv, ensureBuilt, PROJECT_ROOT } from './helpers/cli.js';

const files = { codex: '.codex/config.toml', cursor: '.cursor/mcp.json', gemini: '.gemini/settings.json', opencode: 'opencode.json' };
const provider = (client: FleetClient) => client === 'gemini' ? 'gemini-cli' : client;

describe('copied native configuration in linked worktrees', () => {
  const { tempDir } = useTempResources('heddle-client-workspace-');
  function fixture() {
    const root = realpathSync(tempDir()), canonical = join(root, 'canonical'), linked = join(root, 'linked');
    mkdirSync(canonical);
    const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git(canonical, ['init', '-q']);
    applyInstall(planClientInstall({ dir: canonical, clients: [...FLEET_CLIENTS] }));
    const codex = join(canonical, files.codex);
    writeFileSync(codex, readFileSync(codex, 'utf8').replace('[mcp_servers.heddle]', '[mcp_servers.heddle]\ndefault_tools_approval_mode = "approve"'));
    writeFileSync(join(canonical, '.gitignore'), '.fleet-agent\n');
    git(canonical, ['add', '.']);
    git(canonical, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'native config']);
    git(canonical, ['worktree', 'add', '-qb', 'linked', linked]);
    writeFileSync(join(canonical, '.fleet-agent'), 'canonical-seat');
    writeFileSync(join(linked, '.fleet-agent'), 'linked-seat');
    return { root, canonical, linked, git };
  }
  function servers(dir: string, client: FleetClient) {
    const raw = readFileSync(join(dir, files[client]), 'utf8');
    const config = client === 'codex' ? parseToml(raw) : JSON.parse(raw);
    return config[client === 'codex' ? 'mcp_servers' : client === 'opencode' ? 'mcp' : 'mcpServers'] as Record<string, any>;
  }

  it('accepts only exact linked-family roots, pins workers, and refuses conflicting identity', () => {
    const { canonical, linked, root } = fixture();
    const foreign = join(root, 'foreign'); mkdirSync(foreign);
    execFileSync('git', ['init', '-q'], { cwd: foreign });
    mkdirSync(join(linked, 'subdir'));
    expect(sameClientWorkspace(canonical, linked)).toBe(true);
    expect(sameClientWorkspace(canonical, foreign)).toBe(false);
    expect(sameClientWorkspace(canonical, join(linked, 'subdir'))).toBe(false);
    expect(resolveClientWorkspace(canonical, [foreign], {})).toBe(canonical);
    expect(resolveClientWorkspace(canonical, [canonical], { HEDDLE_AGENT: 'launcher-seat' })).toBe(canonical);
    expect(resolveClientWorkspace(canonical, [linked], { HEDDLE_WORKER: '1', HEDDLE_AGENT: 'worker.1' })).toBe(canonical);
    expect(() => resolveClientWorkspace(canonical, [linked], { HEDDLE_AGENT: 'different-seat' })).toThrow('conflicts');
    for (const client of FLEET_CLIENTS) {
      expect(nativeClientIntegrationInstalled(linked, provider(client), true)).toBe(true);
      const file = join(foreign, files[client]); mkdirSync(join(file, '..'), { recursive: true });
      cpSync(join(canonical, files[client]), file);
      expect(() => nativeClientIntegrationInstalled(foreign, provider(client), true)).toThrow('unverified');
    }
  });

  it.each(FLEET_CLIENTS)('%s copied configs bind actual stdio to linked cwd without any tracked changes', async (client) => {
    await ensureBuilt();
    const { canonical, linked, root, git } = fixture();
    const before = git(linked, ['status', '--porcelain', '--untracked-files=all']);
    const configBefore = readFileSync(join(linked, files[client]), 'utf8');
    const def = servers(linked, client)['heddle-comms'];
    const env = client === 'opencode' ? def.environment : def.env;
    // Cursor's documented empty-default expansion occurs before its sanitized child launch.
    const expanded = Object.fromEntries(Object.entries(env).map(([key, value]) => [key, String(value).replace(/\$\{[A-Z_]+:-\}/g, '')]));
    const { env: childEnvironment } = childEnv({ home: root, env: { ...expanded, HEDDLE_COMMS_DB: join(root, 'comms.db') } });
    const peer = new Client({ name: 'linked-test', version: '1' });
    try {
      await peer.connect(new StdioClientTransport({ command: client === 'opencode' ? def.command[0] : def.command,
        args: client === 'opencode' ? def.command.slice(1) : def.args, env: childEnvironment, cwd: linked, stderr: 'pipe' }));
      const result = await peer.callTool({ name: 'comms_whoami', arguments: {} }) as { content: { text: string }[] };
      expect(JSON.parse(result.content[0].text)).toMatchObject({ identity: 'linked-seat', bindingSource: 'fleet-file' });
    } catch (error) { throw new Error(`linked ${client} stdio failed: ${String(error)}`); }
    finally { await peer.close().catch(() => undefined); }
    const conflict = spawnSync(process.execPath, [join(PROJECT_ROOT, 'dist/client-mcp.js'), 'heddle-comms', canonical],
      { cwd: linked, env: { ...childEnvironment, HEDDLE_AGENT: 'conflicting-seat' }, encoding: 'utf8', timeout: 10000 });
    expect(conflict.status).toBe(1);
    expect(conflict.stderr).toContain('identity conflicts');
    expect(readFileSync(join(linked, files[client]), 'utf8')).toBe(configBefore);
    expect(git(linked, ['status', '--porcelain', '--untracked-files=all'])).toBe(before);
    expect(parseToml(readFileSync(join(linked, files.codex), 'utf8'))).toMatchObject({ mcp_servers: { heddle: { default_tools_approval_mode: 'approve' } } });
    expect(readFileSync(join(canonical, files[client]), 'utf8')).toBe(configBefore);
  });

  it('scopes native hook payload cwd to the linked family while preserving copied hook bytes', async () => {
    await ensureBuilt();
    const { canonical, linked, root } = fixture();
    for (const dir of [canonical, linked]) {
      mkdirSync(join(dir, 'rules'));
      writeFileSync(join(dir, 'rules/cwd-check.yaml'), 'id: cwd-check\nevent: PreToolUse\nmatch:\n  tool: Bash\naction: block\nenforce: true\nmessage: selected {{cwd}}\nfail_open: true\n');
    }
    const { env } = childEnv({ home: root });
    for (const client of FLEET_CLIENTS) {
      const before = readFileSync(join(linked, client === 'codex' || client === 'cursor' ? `.${client}/hooks.json` : files[client]), 'utf8');
      for (const [payloadCwd, selected, worker] of [[linked, linked, false], [root, canonical, false], [linked, canonical, true]] as const) {
        const result = spawnSync(process.execPath, [join(PROJECT_ROOT, 'dist/client-hook.js'), client, 'PreToolUse', canonical], {
          cwd: canonical, env: { ...env, ...(worker ? { HEDDLE_WORKER: '1' } : {}) }, encoding: 'utf8', timeout: 10000,
          input: JSON.stringify({ cwd: payloadCwd, tool_name: 'exec_command', tool_input: { cmd: 'probe' } }),
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout, result.stderr).toContain(`selected ${selected}`);
      }
      expect(readFileSync(join(linked, client === 'codex' || client === 'cursor' ? `.${client}/hooks.json` : files[client]), 'utf8')).toBe(before);
    }
  });

  it('worker hooks use actual linked process cwd and ignore payload redirection to another worktree', async () => {
    await ensureBuilt();
    const { canonical, linked, root, git } = fixture();
    const other = join(root, 'other');
    git(canonical, ['worktree', 'add', '-qb', 'other', other]);
    for (const [dir, label] of [[canonical, 'canonical-policy'], [linked, 'linked-policy'], [other, 'other-policy']]) {
      mkdirSync(join(dir, 'rules'));
      writeFileSync(join(dir, 'rules/worker-cwd.yaml'), `id: worker-cwd\nevent: PreToolUse\nmatch:\n  tool: Bash\naction: block\nenforce: true\nmessage: ${label} {{cwd}}\nfail_open: true\n`);
    }
    const { env } = childEnv({ home: root, env: { HEDDLE_WORKER: '1', HEDDLE_AGENT: 'linked-seat.1', HEDDLE_PARENT: 'linked-seat' } });
    for (const client of FLEET_CLIENTS) {
      for (const payloadCwd of [canonical, linked, other]) {
        const result = spawnSync(process.execPath, [join(PROJECT_ROOT, 'dist/client-hook.js'), client, 'PreToolUse', canonical, 'canonical-seat'], {
          cwd: linked, env, encoding: 'utf8', timeout: 10000,
          input: JSON.stringify({ cwd: payloadCwd, tool_name: 'exec_command', tool_input: { cmd: 'probe' } }),
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout, result.stderr).toContain(`linked-policy ${linked}`);
        expect(result.stdout).not.toContain('canonical-policy');
        expect(result.stdout).not.toContain('other-policy');
      }
    }
    // MCP callers do not supply a hook invocation cwd: their materialized arguments stay pinned.
    expect(resolveClientWorkspace(canonical, [linked, other], env)).toBe(canonical);
  });

  it('keeps generated-entry verification strict for foreign commands, worker copies and symlinks', () => {
    const { canonical, linked } = fixture();
    for (const client of FLEET_CLIENTS) {
      const file = join(linked, files[client]), raw = readFileSync(file, 'utf8'), config = client === 'codex' ? parseToml(raw) : JSON.parse(raw);
      const serialize = (value: any) => client === 'codex' ? stringifyToml(value) : JSON.stringify(value);
      const key = client === 'codex' ? 'mcp_servers' : client === 'opencode' ? 'mcp' : 'mcpServers';
      const envKey = client === 'opencode' ? 'environment' : 'env';
      config[key].heddle[envKey].HEDDLE_WORKER = '1';
      writeFileSync(file, serialize(config));
      expect(() => nativeClientIntegrationInstalled(linked, provider(client), true)).toThrow('unverified');
      const modified = client === 'codex' ? parseToml(raw) : JSON.parse(raw);
      modified[key].heddle.command = client === 'opencode' ? ['foreign'] : 'foreign';
      writeFileSync(file, serialize(modified));
      expect(() => nativeClientIntegrationInstalled(linked, provider(client), true)).toThrow('unverified');
      writeFileSync(file, raw);
      renameSync(file, file + '.preserved'); symlinkSync(join(canonical, files[client]), file);
      expect(() => nativeClientIntegrationInstalled(linked, provider(client), true)).toThrow('unverified');
    }
  });
});
