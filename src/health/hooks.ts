import { randomBytes } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { result, sanitize, type CheckResult, type ProbeResult } from './probe.js';
import type { Definition, DoctorContext } from './checks.js';

// 30s is UserPromptSubmit's default timeout, used here as a conservative "hung" floor: when the sweep
// budget caps a probe below its declared timeout and the probe still times out, we report it hung (fail)
// only if it ran at least this long, else merely unverified (warn). A hook that cannot return within 30s
// is broken for interactive use whatever its declared ceiling. (Some events default lower — MessageDisplay
// 10s, SessionEnd 1.5s — so this floor is deliberately conservative, not the minimum.)
const HUNG_FLOOR_MS = 30_000;

type HookEntry = { type?: unknown; command?: unknown; args?: unknown; timeout?: unknown };
type HookGroup = { hooks?: unknown; matcher?: unknown };

const defaultTimeoutSeconds = (event: string): number => {
  // Claude Code lowers the command/http/mcp_tool default (600s) on some events
  // (https://code.claude.com/docs/en/hooks): 30s on UserPromptSubmit, PreModelSwitch, and
  // PostModelSwitch; 10s on MessageDisplay; SessionEnd hooks share a 1.5s budget.
  if (event === 'UserPromptSubmit' || event === 'PreModelSwitch' || event === 'PostModelSwitch') return 30;
  if (event === 'MessageDisplay') return 10;
  if (event === 'SessionEnd') return 1.5;
  return 600;
};

function commandName(command: string): string {
  const token = command.trim().split(/\s+/)[0] ?? command;
  return basename(token.replace(/^['"]|['"]$/g, '')) || token;
}

function sessionId(): string {
  return `heddle-doctor-probe-${randomBytes(4).toString('hex')}`;
}

function toolNameForMatcher(matcher: string | undefined): string {
  if (!matcher || matcher === '*' || matcher === '.*') return 'Bash';
  const first = (matcher.split('|')[0]?.trim() ?? '').replace(/\[([A-Za-z0-9_])[^\]]*\]/g, '$1');
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(first)) return first;
  // Best-effort — a synthetic probe cannot satisfy every possible matcher regex; this derives a representative concrete tool name.
  const collapsed = first.replace(/\.\*|\.\+/g, 'probe').replace(/[^A-Za-z0-9_-]/g, '');
  return collapsed || 'Bash';
}

function synthPayload(event: string, projectDir: string, id: string, matcher?: string): string {
  const payload: Record<string, unknown> = {
    session_id: id,
    cwd: projectDir,
    hook_event_name: event,
    transcript_path: join(tmpdir(), `heddle-doctor-probe-nonexistent-${id}.jsonl`),
    permission_mode: 'default',
  };
  if (event === 'PreToolUse' || event === 'PermissionRequest') {
    Object.assign(payload, { tool_name: toolNameForMatcher(matcher), tool_input: { command: 'true' }, tool_use_id: 'toolu_probe' });
  } else if (event === 'PostToolUse') {
    Object.assign(payload, {
      tool_name: toolNameForMatcher(matcher), tool_input: { command: 'true' }, tool_use_id: 'toolu_probe',
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

function settingsFailure(id: string, detail: string, kind: 'unreadable' | 'unparseable'): Definition {
  const label = kind === 'unreadable' ? 'unreadable settings' : 'unparseable settings';
  return { id, kind: 'hooks', run: async () => result('fail', `${label}: ${detail}`) };
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

function classifyHookProbe(
  probe: ProbeResult,
  ctx: {
    elapsed: number; timeoutMs: number; timeoutSeconds: number; name: string; command: string;
    budgetBound: boolean; deadlineMs: number; timeoutNote: string;
  },
): Omit<CheckResult, 'id' | 'kind' | 'provider'> {
  const withTimeoutNote = (detail: string) => `${detail}${ctx.timeoutNote}`;
  const slow = ctx.elapsed > ctx.timeoutMs * 0.75;
  if (probe.timedOut) {
    if (!ctx.budgetBound) {
      return result('fail', `perma-timeout: no exit within ${ctx.timeoutSeconds}s (${ctx.name})`, 'hook never returned — likely the cause of prompt/turn stalls');
    }
    const windowSec = Math.round(ctx.deadlineMs / 1_000);
    if (ctx.deadlineMs >= HUNG_FLOOR_MS) {
      return result('fail', `hung: no exit within the ${windowSec}s sweep window (declared ${ctx.timeoutSeconds}s) (${ctx.name})`, `hook did not return in ${windowSec}s — re-run with --hooks-budget ${ctx.timeoutSeconds} to verify against its full timeout`);
    }
    return result('warn', `only ${windowSec}s of sweep budget remained — latency unverified (declared ${ctx.timeoutSeconds}s) (${ctx.name})`, 'raise --hooks-budget to give this hook room to run');
  }
  if (probe.exitCode === 0) {
    return slow
      ? result('warn', withTimeoutNote(`slow: ${ctx.elapsed}ms — >75% of the ${ctx.timeoutSeconds}s budget (${ctx.name})`), 'hook exceeds 75% of its timeout budget — profile it')
      : result('ok', withTimeoutNote(`${ctx.elapsed}ms (${ctx.name})`));
  }
  if (probe.exitCode === 2) {
    return slow
      ? result('warn', withTimeoutNote(`slow: blocking decision (hook engaged) — ${ctx.elapsed}ms (${ctx.name})`), 'hook exceeds 75% of its timeout budget — profile it')
      : result('ok', withTimeoutNote(`blocking decision (hook engaged) — ${ctx.elapsed}ms (${ctx.name})`));
  }
  if (probe.exitCode === 127) return result('fail', `missing: command not found (exit 127) — ${ctx.command.trim().split(/\s+/)[0]}`);
  if (probe.exitCode !== null) {
    const tail = sanitize(probe.stderr.slice(-120)) || 'no stderr';
    return result('warn', withTimeoutNote(`errored (exit ${probe.exitCode}) — ${ctx.elapsed}ms (${ctx.name}): ${tail}`));
  }
  return result('fail', `could not execute: ${sanitize(probe.stderr) || 'spawn error'} (${ctx.name})`);
}

function hookDefinition(
  ctx: DoctorContext,
  projectDir: string,
  id: string,
  event: string,
  entry: HookEntry,
  matcher: string | undefined,
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
      const declared = entry.timeout;
      const declaredValid = typeof declared === 'number' && Number.isFinite(declared)
        && declared > 0 && declared * 1_000 <= 2_147_483_647;
      const timeoutSeconds = declaredValid ? declared : defaultTimeoutSeconds(event);
      const timeoutSubstituted = declared !== undefined && !declaredValid;
      const timeoutMs = timeoutSeconds * 1_000;
      const remaining = ctx.budgets.hooksMs - state.elapsedTotal;
      const deadlineMs = Math.min(timeoutMs, remaining);
      const budgetBound = remaining < timeoutMs;
      const idForPayload = sessionId();
      const execHook = ctx.deps.execHook;
      if (!execHook) return result('fail', 'could not execute: hook probe unavailable');
      const start = ctx.deps.now().getTime();
      const probe = await execHook(entry.command, args, {
        cwd: projectDir,
        env: { ...ctx.deps.env, HEDDLE_DOCTOR_PROBE: '1', HEDDLE_DOCTOR_PROBE_SESSION: idForPayload },
        stdin: synthPayload(event, projectDir, idForPayload, matcher),
        timeoutMs: deadlineMs,
      });
      const elapsed = ctx.deps.now().getTime() - start;
      state.elapsedTotal += elapsed;
      state.completed += 1;
      const timeoutNote = timeoutSubstituted
        ? ` [declared timeout ${String(declared)} invalid — used ${timeoutSeconds}s default]`
        : '';
      return classifyHookProbe(probe, {
        elapsed,
        timeoutMs,
        timeoutSeconds,
        name: commandName(entry.command),
        command: entry.command,
        budgetBound,
        deadlineMs,
        timeoutNote,
      });
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
  const read = ctx.deps.readSettingsBytes ?? ctx.deps.readFileBytes;
  for (const [label, path] of sources) {
    let bytes: Uint8Array | undefined;
    try {
      bytes = await read(path);
    } catch (error) {
      definitions.push(settingsFailure(`hooks:${label}:settings`, error instanceof Error ? error.message : String(error), 'unreadable'));
      continue;
    }
    if (!bytes) continue;
    let hooks: Record<string, HookGroup[]> | undefined;
    try {
      hooks = readHooks(bytes);
    } catch (error) {
      definitions.push(settingsFailure(`hooks:${label}:settings`, error instanceof Error ? error.message : String(error), 'unparseable'));
      continue;
    }
    if (!hooks) continue;
    for (const [event, groups] of Object.entries(hooks)) {
      groups.forEach((group, groupIndex) => {
        (group.hooks as unknown[]).forEach((entry, hookIndex) => {
          const hook = entry && typeof entry === 'object' ? entry as HookEntry : {};
          const matcher = typeof group.matcher === 'string' ? group.matcher : undefined;
          definitions.push(hookDefinition(ctx, projectDir, `hooks:${label}:${event}:${groupIndex}.${hookIndex}`, event, hook, matcher, state));
        });
      });
    }
  }
  return definitions;
}
