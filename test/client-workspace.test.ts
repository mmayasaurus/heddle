import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import { FLEET_CLIENTS, planClientInstall, type FleetClient } from '../src/client-config.js';
import { clientWorkspaceDirectories, resolveClientWorkspace, sameClientWorkspace } from '../src/client-workspace.js';
import { nativeClientIntegrationInstalled } from '../src/mcp.js';
import { applyInstall } from '../src/init-project.js';
import { useTempResources } from './helpers.js';
import { childEnv, ensureBuilt, PROJECT_ROOT } from './helpers/cli.js';

const files = { codex: '.codex/config.toml', cursor: '.cursor/mcp.json', gemini: '.gemini/settings.json', opencode: 'opencode.json' };
const provider = (client: FleetClient) => client === 'gemini' ? 'gemini-cli' : client;
type NativeServer = { command: string | string[]; args?: string[]; env?: Record<string, string>; environment?: Record<string, string> };
type NativeConfig = Partial<Record<'mcp_servers' | 'mcpServers' | 'mcp', Record<string, NativeServer>>>;

describe('copied native configuration in linked worktrees', () => {
  const { tempDir } = useTempResources('heddle-client-workspace-');
  function fixture(suffix = '') {
    const root = realpathSync(tempDir()), canonical = join(root, 'canonical' + suffix), linked = join(root, 'linked' + suffix);
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
    const config = (client === 'codex' ? parseToml(raw) : JSON.parse(raw)) as NativeConfig;
    return config[client === 'codex' ? 'mcp_servers' : client === 'opencode' ? 'mcp' : 'mcpServers']!;
  }

  it('keeps config ownership at exact linked-family roots, pins workers, and refuses conflicting identity', () => {
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
    expect(resolveClientWorkspace(canonical, [linked], { HEDDLE_AGENT: 'invalid value', FLEET_AGENT: 'linked-seat' })).toBe(linked);
    expect(resolveClientWorkspace(canonical, [linked], { HEDDLE_AGENT: 'operator', FLEET_AGENT: '#room' })).toBe(linked);
    expect(() => resolveClientWorkspace(canonical, [linked], { HEDDLE_COMMS_ADDRESS: 'different-seat' })).toThrow('conflicts');
    expect(() => resolveClientWorkspace(linked, [linked], { HEDDLE_AGENT: 'different-seat' })).toThrow('conflicts');
    for (const client of FLEET_CLIENTS) {
      expect(nativeClientIntegrationInstalled(linked, provider(client), true)).toBe(true);
      const file = join(foreign, files[client]); mkdirSync(join(file, '..'), { recursive: true });
      cpSync(join(canonical, files[client]), file);
      expect(() => nativeClientIntegrationInstalled(foreign, provider(client), true)).toThrow('unverified');
    }
  });

  it('checks the nearest valid in-checkout owner when installed or launched in a subdirectory', () => {
    const { canonical, linked } = fixture();
    const sub = join(linked, 'subdir'), canonicalSub = join(canonical, 'subdir');
    mkdirSync(sub); mkdirSync(canonicalSub);
    for (const configured of [canonical, linked, sub]) {
      expect(() => resolveClientWorkspace(configured, [sub], { HEDDLE_AGENT: 'different-seat' })).toThrow('conflicts');
      expect(resolveClientWorkspace(configured, [sub], { HEDDLE_AGENT: 'linked-seat' })).toBe(sub);
    }
    expect(resolveClientWorkspace(canonicalSub, [canonicalSub], { HEDDLE_AGENT: 'launcher-seat' })).toBe(canonicalSub);
    expect(resolveClientWorkspace(canonical, [canonicalSub], { HEDDLE_AGENT: 'launcher-seat' })).toBe(canonicalSub);
    writeFileSync(join(sub, '.fleet-agent'), '#invalid-room');
    expect(() => resolveClientWorkspace(sub, [], { HEDDLE_AGENT: 'different-seat' })).toThrow('conflicts');
    writeFileSync(join(sub, '.fleet-agent'), 'nested-seat');
    expect(resolveClientWorkspace(sub, [], { HEDDLE_AGENT: 'nested-seat' })).toBe(sub);
    expect(() => resolveClientWorkspace(sub, [], { HEDDLE_AGENT: 'linked-seat' })).toThrow('conflicts');
    writeFileSync(join(sub, '.fleet-agent'), 'x'.repeat(257));
    expect(() => resolveClientWorkspace(sub, [], { HEDDLE_AGENT: 'nested-seat' })).toThrow('owner could not be verified');
  });

  it('does not borrow outer repository identity or policy for a nested repository', () => {
    const { canonical, linked, git } = fixture();
    const nested = join(linked, 'nested'), sub = join(nested, 'subdir');
    mkdirSync(sub, { recursive: true });
    git(nested, ['init', '-q']);
    expect(resolveClientWorkspace(canonical, [sub], {})).toBe(canonical);
    expect(resolveClientWorkspace(canonical, [sub], { HEDDLE_WORKER: '1' }, sub)).toBe(canonical);
    expect(clientWorkspaceDirectories(sub)).toEqual([sub, nested]);
  });

  it('canonicalizes case aliases before bounding the directory walk on case-insensitive filesystems', ({ skip }) => {
    const { canonical, linked, root } = fixture();
    const sub = join(linked, 'SubDir'); mkdirSync(sub);
    const alias = join(root, 'LINKED', 'subdir');
    if (!existsSync(alias)) skip();
    expect(clientWorkspaceDirectories(alias)).toEqual([sub, linked]);
    expect(resolveClientWorkspace(canonical, [alias], { HEDDLE_AGENT: 'linked-seat' })).toBe(sub);
    expect(() => resolveClientWorkspace(alias, [], { HEDDLE_AGENT: 'different-seat' })).toThrow('conflicts');
  });

  it.each(FLEET_CLIENTS)('%s copied configs bind actual stdio with trailing-space paths and invalid env identity without tracked changes', async (client) => {
    await ensureBuilt();
    const { canonical, linked, root, git } = fixture(' ');
    const sub = join(linked, 'subdir'); mkdirSync(sub);
    const before = git(linked, ['status', '--porcelain', '--untracked-files=all']);
    const configBefore = readFileSync(join(linked, files[client]), 'utf8');
    const def = servers(linked, client)['heddle-comms'];
    const env = client === 'opencode' ? def.environment : def.env;
    expect(env).toBeDefined();
    // Cursor's documented empty-default expansion occurs before its sanitized child launch.
    const expanded = Object.fromEntries(Object.entries(env ?? {}).map(([key, value]) => [key, String(value).replace(/\$\{[A-Z_]+:-\}/g, '')]));
    const { env: childEnvironment } = childEnv({ home: root, env: { ...expanded, HEDDLE_AGENT: 'invalid identity', HEDDLE_COMMS_DB: join(root, 'comms.db') } });
    const command = Array.isArray(def.command) ? def.command[0] : def.command;
    const args = Array.isArray(def.command) ? def.command.slice(1) : def.args;
    const peer = new Client({ name: 'linked-test', version: '1' });
    try {
      await peer.connect(new StdioClientTransport({ command, args, env: childEnvironment, cwd: sub, stderr: 'pipe' }));
      const result = await peer.callTool({ name: 'comms_whoami', arguments: {} }) as { content: { text: string }[] };
      expect(JSON.parse(result.content[0].text)).toMatchObject({ identity: 'linked-seat', bindingSource: 'fleet-file' });
    } catch (error) { throw new Error(`linked ${client} stdio failed: ${String(error)}`); }
    finally { await peer.close().catch(() => undefined); }
    const worker = new Client({ name: 'pinned-worker-test', version: '1' });
    try {
      await worker.connect(new StdioClientTransport({ command, args,
        env: { ...childEnvironment, HEDDLE_WORKER: '1' }, cwd: sub, stderr: 'pipe' }));
      const result = await worker.callTool({ name: 'comms_whoami', arguments: {} }) as { content: { text: string }[] };
      expect(JSON.parse(result.content[0].text)).toMatchObject({ identity: 'canonical-seat', bindingSource: 'fleet-file' });
    } catch (error) { throw new Error(`pinned ${client} worker stdio failed: ${String(error)}`); }
    finally { await worker.close().catch(() => undefined); }
    const conflict = spawnSync(process.execPath, [join(PROJECT_ROOT, 'dist/client-mcp.js'), 'heddle-comms', canonical],
      { cwd: sub, env: { ...childEnvironment, HEDDLE_AGENT: 'conflicting-seat' }, encoding: 'utf8', timeout: 10000 });
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
    const sub = join(linked, 'subdir'); mkdirSync(sub);
    writeFileSync(join(sub, 'rules'), 'A regular file must not shadow the worktree rules directory.');
    const { env } = childEnv({ home: root });
    for (const client of FLEET_CLIENTS) {
      const before = readFileSync(join(linked, client === 'codex' || client === 'cursor' ? `.${client}/hooks.json` : files[client]), 'utf8');
      for (const [payloadCwd, selected, worker] of [[linked, linked, false], [sub, sub, false], [root, canonical, false], [linked, canonical, true]] as const) {
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

  it.each(['payload', 'process', 'direct'] as const)('identity conflicts deny PreToolUse for every client via %s cwd without permission or Stop loops', async (mode) => {
    await ensureBuilt();
    const { canonical, linked, root } = fixture();
    for (const dir of [canonical, linked]) {
      mkdirSync(join(dir, 'rules'));
      writeFileSync(join(dir, 'rules/enforced.yaml'), 'id: enforced\nevent: PreToolUse\nmatch:\n  tool: Bash\naction: block\nenforce: true\nmessage: policy denial\nfail_open: true\n');
    }
    const { env } = childEnv({ home: root, env: { HEDDLE_AGENT: 'canonical-seat' } });
    for (const client of FLEET_CLIENTS) {
      for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']) {
        const configured = mode === 'direct' ? linked : canonical;
        const result = spawnSync(process.execPath, [join(PROJECT_ROOT, 'dist/client-hook.js'), client, event, configured], {
          cwd: mode === 'payload' ? canonical : linked, env, encoding: 'utf8', timeout: 10000,
          input: JSON.stringify({ ...(mode === 'payload' ? { cwd: linked } : {}), tool_name: 'exec_command', tool_input: { cmd: 'probe' } }),
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toContain('identity conflicts');
        const output = JSON.parse(result.stdout);
        if (event === 'PreToolUse') {
          if (client === 'codex') expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
          else if (client === 'cursor') expect(output.permission).toBe('deny');
          else if (client === 'gemini') expect(output.decision).toBe('deny');
          else expect(output.deny).toContain('identity conflicts');
        } else if (event === 'Stop') expect(output).toEqual({});
        else {
          expect(result.stdout).toContain('identity conflicts');
          expect(output).not.toHaveProperty('decision');
          expect(output).not.toHaveProperty('permission');
          expect(output).not.toHaveProperty('deny');
          expect(output.hookSpecificOutput ?? {}).not.toHaveProperty('permissionDecision');
        }
      }
    }
  });

  it.each(FLEET_CLIENTS)('%s denies unsafe worktree owner metadata instead of failing open or timing out', async (client) => {
    await ensureBuilt();
    const { canonical, linked, root } = fixture();
    const owner = join(linked, '.fleet-agent');
    renameSync(owner, owner + '.preserved');
    const { env } = childEnv({ home: root, env: { HEDDLE_AGENT: 'canonical-seat' } });
    const kinds = ['symlink', 'directory', 'oversized', ...(process.platform === 'win32' ? [] : ['fifo'])];
    for (const kind of kinds) {
      if (kind === 'symlink') symlinkSync(owner + '.preserved', owner);
      else if (kind === 'directory') mkdirSync(owner);
      else if (kind === 'oversized') writeFileSync(owner, 'x'.repeat(257));
      else execFileSync('mkfifo', [owner]);
      for (const configured of [canonical, linked]) {
        const result = spawnSync(process.execPath, [join(PROJECT_ROOT, 'dist/client-hook.js'), client, 'PreToolUse', configured], {
          cwd: linked, env, encoding: 'utf8', timeout: 5000,
          input: JSON.stringify({ tool_name: 'exec_command', tool_input: { cmd: 'probe' } }),
        });
        expect(result.status, `${kind}: ${result.stderr}`).toBe(0);
        expect(result.error).toBeUndefined();
        expect(result.stderr).toContain('owner could not be verified');
        const output = JSON.parse(result.stdout);
        if (client === 'codex') expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
        else if (client === 'cursor') expect(output.permission).toBe('deny');
        else if (client === 'gemini') expect(output.decision).toBe('deny');
        else expect(output.deny).toContain('owner could not be verified');
      }
      renameSync(owner, owner + '.' + kind);
    }
  });

  it('worker hooks use actual linked process cwd and ignore payload redirection to another worktree', async () => {
    await ensureBuilt();
    const { canonical, linked, root, git } = fixture();
    const other = join(root, 'other');
    git(canonical, ['worktree', 'add', '-qb', 'other', other]);
    for (const [dir, label] of [[canonical, 'canonical-policy'], [linked, 'linked-policy'], [other, 'other-policy']]) {
      mkdirSync(join(dir, 'rules'));
      writeFileSync(join(dir, 'rules/worker-cwd.yaml'), `id: worker-cwd\nevent: PreToolUse\nmatch:\n  tool: Bash\naction: block\nenforce: true\nmessage: ${label} {{cwd}} {{agent}}\nfail_open: true\n`);
    }
    const { env } = childEnv({ home: root, env: { HEDDLE_WORKER: '1', HEDDLE_AGENT: 'linked-seat.1', HEDDLE_PARENT: 'linked-seat' } });
    const sub = join(linked, 'subdir'); mkdirSync(sub);
    for (const client of FLEET_CLIENTS) {
      for (const [actualCwd, payloadCwd] of [[linked, canonical], [sub, linked], [sub, other]]) {
        const result = spawnSync(process.execPath, [join(PROJECT_ROOT, 'dist/client-hook.js'), client, 'PreToolUse', canonical, 'canonical-seat'], {
          cwd: actualCwd, env, encoding: 'utf8', timeout: 10000,
          input: JSON.stringify({ cwd: payloadCwd, tool_name: 'exec_command', tool_input: { cmd: 'probe' } }),
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout, result.stderr).toContain(`linked-policy ${actualCwd} linked-seat.1`);
        expect(result.stdout).not.toContain('canonical-policy');
        expect(result.stdout).not.toContain('other-policy');
      }
    }
    // MCP callers do not supply a hook invocation cwd: their materialized arguments stay pinned.
    expect(resolveClientWorkspace(canonical, [linked, other], env)).toBe(canonical);
  });

  it('uses explicit rule overrides and nearest subdirectory rules without losing the actual cwd', async () => {
    await ensureBuilt();
    const { canonical, linked, root } = fixture();
    const sub = join(linked, 'subdir'); mkdirSync(sub);
    for (const [dir, label] of [[linked, 'root'], [sub, 'nested'], [root, 'override']]) {
      mkdirSync(join(dir, 'rules'));
      writeFileSync(join(dir, 'rules/selection.yaml'), `id: selection\nevent: PreToolUse\nmatch:\n  tool: Bash\naction: block\nenforce: true\nmessage: ${label} {{cwd}}\nfail_open: true\n`);
    }
    const { env } = childEnv({ home: root });
    for (const override of [false, true]) {
      const result = spawnSync(process.execPath, [join(PROJECT_ROOT, 'dist/client-hook.js'), 'codex', 'PreToolUse', canonical], {
        cwd: sub, env: { ...env, ...(override ? { HEDDLE_RULES_DIR: join(root, 'rules') } : {}) }, encoding: 'utf8', timeout: 10000,
        input: JSON.stringify({ tool_name: 'exec_command', tool_input: { cmd: 'probe' } }),
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).hookSpecificOutput).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: `${override ? 'override' : 'nested'} ${sub}` });
    }
  });

  it('keeps generated-entry verification strict for foreign commands, worker copies and symlinks', () => {
    const { canonical, linked } = fixture();
    for (const client of FLEET_CLIENTS) {
      const file = join(linked, files[client]), raw = readFileSync(file, 'utf8');
      const config = (client === 'codex' ? parseToml(raw) : JSON.parse(raw)) as NativeConfig;
      const serialize = (value: NativeConfig) => client === 'codex' ? stringifyToml(value) : JSON.stringify(value);
      const key = client === 'codex' ? 'mcp_servers' : client === 'opencode' ? 'mcp' : 'mcpServers';
      const envKey = client === 'opencode' ? 'environment' : 'env';
      config[key]!.heddle[envKey]!.HEDDLE_WORKER = '1';
      writeFileSync(file, serialize(config));
      expect(() => nativeClientIntegrationInstalled(linked, provider(client), true)).toThrow('unverified');
      const modified = (client === 'codex' ? parseToml(raw) : JSON.parse(raw)) as NativeConfig;
      modified[key]!.heddle.command = client === 'opencode' ? ['foreign'] : 'foreign';
      writeFileSync(file, serialize(modified));
      expect(() => nativeClientIntegrationInstalled(linked, provider(client), true)).toThrow('unverified');
      writeFileSync(file, raw);
      renameSync(file, file + '.preserved'); symlinkSync(join(canonical, files[client]), file);
      expect(() => nativeClientIntegrationInstalled(linked, provider(client), true)).toThrow('unverified');
    }
  });
});
