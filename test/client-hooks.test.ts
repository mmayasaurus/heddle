import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { clientToolPayload, evaluateClientHook, renderClientHook } from '../src/client-hooks.js';
import { CommsLog } from '../src/comms/log.js';
import { codexClientFlags, planClientInstall } from '../src/client-config.js';
import { applyInstall } from '../src/init-project.js';
import { useTempResources } from './helpers.js';
import { childEnv, ensureBuilt, PROJECT_ROOT } from './helpers/cli.js';

describe('native hook lifecycle', () => {
  const { tempDir } = useTempResources('heddle-native-hooks-');

  it('preserves foreign hooks, adds all native events, and installs idempotently', () => {
    const dir = realpathSync.native(tempDir());
    mkdirSync(join(dir, '.codex'));
    const original = { hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'user-hook --heddle-fleet-hook' }] }] } };
    writeFileSync(join(dir, '.codex/hooks.json'), JSON.stringify(original));
    mkdirSync(join(dir, '.cursor'));
    writeFileSync(join(dir, '.cursor/hooks.json'), JSON.stringify({ hooks: { preToolUse: [{ command: 'user-hook --heddle-fleet-hook' }] } }));
    const options = { dir, clients: ['codex', 'cursor', 'gemini', 'opencode'] as const, agent: 'codex-test' };
    applyInstall(planClientInstall({ ...options, clients: [...options.clients] }));
    const codex = JSON.parse(readFileSync(join(dir, '.codex/hooks.json'), 'utf8'));
    expect(codex.hooks.PostToolUse[0]).toEqual(original.hooks.PostToolUse[0]);
    expect(JSON.parse(readFileSync(join(dir, '.cursor/hooks.json'), 'utf8')).hooks.preToolUse[0].command).toBe('user-hook --heddle-fleet-hook');
    expect(codex.hooks.Stop[0].hooks[0].command).toContain('--heddle-fleet-hook');
    const gemini = JSON.parse(readFileSync(join(dir, '.gemini/settings.json'), 'utf8'));
    expect(gemini.hooks.AfterAgent[0].hooks[0].timeout).toBe(5000);
    expect(readFileSync(join(dir, '.opencode/plugins/heddle-fleet.js'), 'utf8')).not.toContain('__HEDDLE_');
    const instructions = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    expect(instructions).toContain(join(PROJECT_ROOT, 'dist', 'cli.js'));
    expect(instructions).not.toContain('`heddle dispatch');
    expect(planClientInstall({ ...options, clients: [...options.clients] }).steps.every((s) => s.action === 'ok')).toBe(true);
    const flags = codexClientFlags(dir, 'codex-test');
    expect(flags).toContain('mcp_servers.heddle-comms.tool_timeout_sec=660');
    expect(flags.some((flag) => flag.startsWith('mcp_servers."'))).toBe(false);
  });

  it('applies existing enforced rules through native tool and output names', () => {
    const dir = realpathSync.native(tempDir());
    mkdirSync(join(dir, 'rules'));
    writeFileSync(join(dir, 'rules/test-deny.yaml'), 'id: test-deny\nevent: PreToolUse\nmatch:\n  tool: Bash\n  input:\n    command: forbidden\naction: block\nenforce: true\nmessage: blocked {{tool_name}}\nfail_open: true\n');
    const result = evaluateClientHook('PreToolUse', { tool_name: 'exec_command', tool_input: { cmd: 'forbidden' } }, dir, {});
    expect(result.deny).toBe('blocked Bash');
    expect(renderClientHook('codex', 'PreToolUse', result)).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    expect(renderClientHook('cursor', 'PreToolUse', result)).toMatchObject({ permission: 'deny' });
    expect(renderClientHook('gemini', 'PreToolUse', result)).toMatchObject({ decision: 'deny' });
    expect(renderClientHook('opencode', 'PreToolUse', result)).toMatchObject({ deny: 'blocked Bash' });
    expect(clientToolPayload({ tool_name: 'run_shell_command', tool_input: '{"command":"safe"}' }).tool_name).toBe('Bash');
    expect(evaluateClientHook('PreToolUse', { tool_name: 'spawn_agent' }, dir, { HEDDLE_WORKER: '1' }).deny).toContain('depth-1');
  });

  it('rebinds owned Codex hooks without retaining the previous identity', () => {
    const dir = realpathSync.native(tempDir());
    applyInstall(planClientInstall({ dir, clients: ['codex'], agent: 'codex-before' }));
    applyInstall(planClientInstall({ dir, clients: ['codex'], agent: 'codex-after' }));
    const config = readFileSync(join(dir, '.codex/hooks.json'), 'utf8');
    expect(config).not.toContain('codex-before');
    expect(config).toContain('codex-after');
    expect(JSON.parse(config).hooks.SessionStart).toHaveLength(1);
  });

  it('never restarts interrupted turns or continuation loops', () => {
    expect(renderClientHook('cursor', 'PreToolUse', { context: '' })).toEqual({});
    expect(renderClientHook('cursor', 'PreToolUse', { context: 'nonblocking reminder' })).toEqual({});
    for (const client of ['codex', 'cursor', 'gemini'] as const) {
      for (const payload of [{ stop_hook_active: true }, { status: 'aborted' }, { status: 'error' }, { loop_count: 5 }]) {
        expect(renderClientHook(client, 'Stop', { context: 'new message' }, payload)).toEqual({});
      }
    }
    expect(renderClientHook('cursor', 'Stop', { context: 'new message' })).toEqual({ followup_message: 'new message' });
    expect(renderClientHook('gemini', 'Stop', { context: 'new message' })).toEqual({ decision: 'deny', reason: 'new message' });
  });

  it('OpenCode plugin preserves tool denials and only continues a normally completed session', async () => {
    const dir = realpathSync.native(tempDir()), hook = join(dir, 'hook.mjs');
    writeFileSync(hook, `process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify(process.argv[3]==='PreToolUse'?{deny:'test-denial'}:{context:'test-inbox'})));`);
    const source = readFileSync(join(PROJECT_ROOT, 'assets/opencode-fleet-plugin.js'), 'utf8')
      .replace("'__HEDDLE_NODE__'", () => JSON.stringify(process.execPath))
      .replace("'__HEDDLE_HOOK__'", () => JSON.stringify(hook)).replace("'__HEDDLE_AGENT__'", '"codex-test"');
    const pluginPath = join(dir, 'plugin.mjs'); writeFileSync(pluginPath, source);
    const prompts: unknown[] = [];
    const { HeddleFleet } = await import(/* @vite-ignore */ pathToFileURL(pluginPath).href);
    const plugin = await HeddleFleet({ directory: dir, client: { session: { prompt: async (request: unknown) => { prompts.push(request); } } } });
    const output = { parts: [{ type: 'text', text: 'original' }] };
    await plugin['chat.message']({ sessionID: 'session' }, output);
    expect(output.parts[0].text).toContain('test-inbox');
    await expect(plugin['tool.execute.before']({ sessionID: 'session', tool: 'bash' }, { args: {} })).rejects.toThrow('test-denial');
    const idle = { event: { type: 'session.idle', properties: { sessionID: 'session' } } };
    await plugin.event(idle); expect(prompts).toHaveLength(0);
    await plugin.event({ event: { type: 'message.updated', properties: { info: { role: 'assistant', sessionID: 'session', finish: 'stop' } } } });
    await plugin.event(idle); expect(prompts).toHaveLength(1);
    await plugin.event(idle); expect(prompts).toHaveLength(1);
    await plugin.event({ event: { type: 'session.error', properties: { sessionID: 'session' } } });
    await plugin.event(idle); expect(prompts).toHaveLength(1);
  });

  it('delivers cross-client inbox messages once per session without consuming broker history', async () => {
    await ensureBuilt();
    const dir = realpathSync.native(tempDir());
    const db = join(dir, 'comms.db'), state = join(dir, 'client-state.db');
    const log = new CommsLog(db);
    try {
      log.append({ from: 'claude-test', to: 'codex-test', body: 'native-message-marker' });
      const { env } = childEnv({ home: dir, env: { HEDDLE_COMMS_DB: db, HEDDLE_CLIENT_STATE_DB: state } });
      const invoke = (client: string, session: string, event = 'PostToolUse') => {
        const child = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(PROJECT_ROOT, 'dist/client-hook.js'), client, event, dir, 'codex-test'],
          { input: JSON.stringify({ session_id: session }), env, encoding: 'utf8', timeout: 10000 });
        expect(child.status, child.stderr).toBe(0);
        return JSON.parse(child.stdout);
      };
      for (const client of ['codex', 'cursor', 'gemini', 'opencode']) {
        expect(JSON.stringify(invoke(client, 'session-one'))).toContain('native-message-marker');
        expect(JSON.stringify(invoke(client, 'session-one'))).not.toContain('native-message-marker');
        expect(JSON.stringify(invoke(client, 'session-two'))).toContain('native-message-marker');
      }
      expect(log.transcript({ inbox: 'codex-test' })).toHaveLength(1);
      log.append({ from: 'cursor-test', to: 'codex-test', body: 'arrived-during-turn' });
      expect(invoke('codex', 'session-one', 'Stop')).toMatchObject({ decision: 'block', reason: expect.stringContaining('arrived-during-turn') });
    } finally { log.close(); }
  }, 30000);

  it('delivers shipped nonblocking rule nudges through native after-tool context', async () => {
    await ensureBuilt();
    const dir = realpathSync.native(tempDir());
    const { env } = childEnv({ home: dir, env: { HEDDLE_RULES_DIR: join(PROJECT_ROOT, 'rules') } });
    for (const client of ['cursor', 'opencode']) {
      const child = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(PROJECT_ROOT, 'dist/client-hook.js'), client, 'PostToolUse', dir, 'codex-test'],
        { input: JSON.stringify({ tool_name: client === 'cursor' ? 'Shell' : 'bash', tool_input: { command: 'gh pr create' } }), env, encoding: 'utf8', timeout: 10000 });
      expect(child.status, child.stderr).toBe(0);
      const result = JSON.parse(child.stdout);
      expect(result.additional_context ?? result.context).toContain('PR');
      expect(result.permission).toBeUndefined();
    }
  });

  it('binds native worker hooks to the minted child, ahead of the worktree owner', async () => {
    await ensureBuilt();
    const dir = realpathSync.native(tempDir()), db = join(dir, 'comms.db');
    writeFileSync(join(dir, '.fleet-agent'), 'codex-parent');
    const log = new CommsLog(db);
    try {
      log.append({ from: 'claude-test', to: 'codex-parent', body: 'parent-only-marker' });
      log.append({ from: 'claude-test', to: 'codex-parent.1', body: 'child-only-marker' });
      const { env } = childEnv({ home: dir, env: { HEDDLE_WORKER: '1', HEDDLE_PARENT: 'codex-parent', HEDDLE_COMMS_ADDRESS: 'codex-parent.1', HEDDLE_COMMS_DB: db } });
      const child = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(PROJECT_ROOT, 'dist/client-hook.js'), 'opencode', 'PostToolUse', dir, 'codex-parent'],
        { input: JSON.stringify({ session_id: 'worker-session' }), env, encoding: 'utf8', timeout: 10000 });
      expect(child.status, child.stderr).toBe(0);
      expect(child.stdout).toContain('child-only-marker');
      expect(child.stdout).not.toContain('parent-only-marker');
    } finally { log.close(); }
  });
});
