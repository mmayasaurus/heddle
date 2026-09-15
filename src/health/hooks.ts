import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { result, sanitize, type CheckResult } from './probe.js';
import type { Definition, DoctorContext } from './checks.js';

type HookEntry = { type?: unknown; command?: unknown; args?: unknown; timeout?: unknown };
type HookGroup = { hooks?: unknown };

const defaultTimeoutSeconds = (event: string): number => {
  if (event === 'UserPromptSubmit') return 30;
  if (event === 'SessionEnd') return 1.5;
  // Claude Code hook timeout defaults are 600s except UserPromptSubmit (30s) and SessionEnd (1.5s).
  return 600;
};

function commandName(command: string): string {
  const token = command.trim().split(/\s+/)[0] ?? command;
  return basename(token.replace(/^['"]|['"]$/g, '')) || token;
}

function sessionId(): string {
  return `heddle-doctor-probe-${Math.floor(Math.random() * 0x1_0000_0000).toString(16).padStart(8, '0')}`;
}

function synthPayload(event: string, projectDir: string, id: string): string {
  const payload: Record<string, unknown> = {
    session_id: id,
    cwd: projectDir,
    hook_event_name: event,
    transcript_path: join(tmpdir(), `heddle-doctor-probe-nonexistent-${id}.jsonl`),
    permission_mode: 'default',
  };
  if (event === 'PreToolUse' || event === 'PermissionRequest') {
    Object.assign(payload, { tool_name: 'Bash', tool_input: { command: 'true' }, tool_use_id: 'toolu_probe' });
  } else if (event === 'PostToolUse') {
    Object.assign(payload, {
      tool_name: 'Bash', tool_input: { command: 'true' }, tool_use_id: 'toolu_probe',
      tool_response: { stdout: '', exit_code: 0 },
    });
  } else if (event === 'UserPromptSubmit') {
    payload.prompt = '[heddle doctor hook probe]';
  } else if (event === 'Stop' || event === 'SubagentStop') {
    payload.stop_hook_active = false;
  } else if (event === 'SessionStart') {
    payload.source = 'startup';
  } else if (event === 'Notification') {
    Object.assign(payload, { message: '[probe]', notification_type: 'idle_prompt' });
  }
  return JSON.stringify(payload);
}

function settingsFailure(id: string, detail: string): Definition {
  return { id, kind: 'hooks', run: async () => result('fail', `unparseable settings: ${detail}`) };
}

function readHooks(bytes: Uint8Array): Record<string, HookGroup[]> | undefined {
  const parsed: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('settings root is not an object');
  const hooks = (parsed as { hooks?: unknown }).hooks;
  if (hooks === undefined) return undefined;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) throw new Error('hooks is not an object');
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) throw new Error(`hooks.${event} is not an array`);
    groups.forEach((group, groupIndex) => {
      if (!group || typeof group !== 'object' || !Array.isArray((group as HookGroup).hooks)) {
        throw new Error(`hooks.${event}[${groupIndex}].hooks is not an array`);
      }
    });
  }
  return hooks as Record<string, HookGroup[]>;
}

function hookDefinition(
  ctx: DoctorContext,
  projectDir: string,
  id: string,
  event: string,
  entry: HookEntry,
  state: { elapsedTotal: number; completed: number },
): Definition {
  return {
    id,
    kind: 'hooks',
    run: async () => {
      if (state.elapsedTotal >= ctx.budgets.hooksMs) {
        return result('skipped', `hooks sweep budget exhausted after ${state.completed} hooks`);
      }
      if (entry.type !== 'command') return result('skipped', `non-command hook (${String(entry.type)}) — not latency-probed`);
      if (typeof entry.command !== 'string' || !entry.command.trim()) return result('fail', 'command hook has no command string');
      const args = Array.isArray(entry.args) && entry.args.every((arg) => typeof arg === 'string')
        ? entry.args as string[]
        : undefined;
      const timeoutSeconds = typeof entry.timeout === 'number' && Number.isFinite(entry.timeout)
        ? entry.timeout : defaultTimeoutSeconds(event);
      const timeoutMs = timeoutSeconds * 1_000;
      const idForPayload = sessionId();
      const execHook = ctx.deps.execHook;
      if (!execHook) return result('fail', 'could not execute: hook probe unavailable');
      const start = ctx.deps.now().getTime();
      const probe = await execHook(entry.command, args, {
        cwd: projectDir,
        env: { ...ctx.deps.env, HEDDLE_DOCTOR_PROBE: '1', HEDDLE_DOCTOR_PROBE_SESSION: idForPayload },
        stdin: synthPayload(event, projectDir, idForPayload),
        timeoutMs,
      });
      const elapsed = ctx.deps.now().getTime() - start;
      state.elapsedTotal += elapsed;
      state.completed += 1;
      const name = commandName(entry.command);
      const slow = elapsed > timeoutMs * 0.75;
      if (probe.timedOut) return result('fail', `perma-timeout: no exit within ${timeoutSeconds}s (${name})`, 'hook never returned — likely the cause of prompt/turn stalls');
      if (probe.exitCode === 0) {
        return slow
          ? result('warn', `slow: ${elapsed}ms — >75% of the ${timeoutSeconds}s budget (${name})`, 'hook exceeds 75% of its timeout budget — profile it')
          : result('ok', `${elapsed}ms (${name})`);
      }
      if (probe.exitCode === 2) {
        return slow
          ? result('warn', `slow: blocking decision (hook engaged) — ${elapsed}ms (${name})`, 'hook exceeds 75% of its timeout budget — profile it')
          : result('ok', `blocking decision (hook engaged) — ${elapsed}ms (${name})`);
      }
      if (probe.exitCode === 127) return result('fail', `missing: command not found (exit 127) — ${entry.command.trim().split(/\s+/)[0]}`);
      if (probe.exitCode !== null) {
        const tail = sanitize(probe.stderr.slice(-120)) || 'no stderr';
        return result('warn', `errored (exit ${probe.exitCode}) — ${elapsed}ms (${name}): ${tail}`);
      }
      return result('fail', `could not execute: ${sanitize(probe.stderr) || 'spawn error'} (${name})`);
    },
  };
}

export async function hooksChecks(ctx: DoctorContext, projectDir: string): Promise<Definition[]> {
  const configDir = ctx.deps.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  const sources = [
    ['user', join(configDir, 'settings.json')],
    ['user-local', join(configDir, 'settings.local.json')],
    ['project', join(projectDir, '.claude', 'settings.json')],
    ['project-local', join(projectDir, '.claude', 'settings.local.json')],
  ] as const;
  const definitions: Definition[] = [];
  const state = { elapsedTotal: 0, completed: 0 };
  for (const [label, path] of sources) {
    let bytes: Uint8Array | undefined;
    try {
      bytes = await ctx.deps.readFileBytes(path);
    } catch (error) {
      definitions.push(settingsFailure(`hooks:${label}:settings`, error instanceof Error ? error.message : String(error)));
      continue;
    }
    if (!bytes) continue;
    let hooks: Record<string, HookGroup[]> | undefined;
    try {
      hooks = readHooks(bytes);
    } catch (error) {
      definitions.push(settingsFailure(`hooks:${label}:settings`, error instanceof Error ? error.message : String(error)));
      continue;
    }
    if (!hooks) continue;
    for (const [event, groups] of Object.entries(hooks)) {
      groups.forEach((group, groupIndex) => {
        (group.hooks as unknown[]).forEach((entry, hookIndex) => {
          const hook = entry && typeof entry === 'object' ? entry as HookEntry : {};
          definitions.push(hookDefinition(ctx, projectDir, `hooks:${label}:${event}:${groupIndex}.${hookIndex}`, event, hook, state));
        });
      });
    }
  }
  return definitions;
}
