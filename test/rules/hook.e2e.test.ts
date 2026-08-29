import { beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureBuilt, PROJECT_ROOT } from '../helpers/cli.js';
import { useTempResources } from '../helpers.js';

const rule = (id: string, event: string, action: string, enforce: boolean, message: string) => `id: ${id}\nevent: ${event}\nmatch: {}\naction: ${action}\nenforce: ${enforce}\nsubagent_aware: false\nmessage: ${message}\nfail_open: true\n`;
async function runHook(rules: string, stdin: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'dist/hook.js', '--rules', rules], { cwd: PROJECT_ROOT, env: { PATH: process.env.PATH ?? '' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (s) => { stdout += s; }); child.stderr.on('data', (s) => { stderr += s; });
    child.once('error', reject); child.once('close', (code) => resolve({ stdout, stderr, code: code ?? 1 })); child.stdin.end(stdin);
  });
}
describe('heddle-hook bin', () => {
  const { tempDir } = useTempResources('heddle-hook-e2e-');
  beforeAll(async () => { await ensureBuilt(); }, 120_000);
  it('denies a matching enforced PreToolUse rule', async () => { const d = tempDir(); writeFileSync(join(d, 'deny.yaml'), rule('deny', 'PreToolUse', 'block', true, 'denied')); const r = await runHook(d, JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash' })); expect(r.code).toBe(0); expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny'); });
  it('injects context for a matching SessionStart rule', async () => { const d = tempDir(); writeFileSync(join(d, 'welcome.yaml'), rule('welcome', 'SessionStart', 'inject', false, 'welcome')); const r = await runHook(d, JSON.stringify({ hook_event_name: 'SessionStart' })); expect(r.code).toBe(0); expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toContain('welcome'); });
  it('fails open for junk stdin', async () => { const r = await runHook(tempDir(), 'not json'); expect(r).toMatchObject({ code: 0 }); expect(r.stdout.trim()).toBe('{}'); expect(r.stderr).toContain('FAILED OPEN'); });
  it('does not deny when tool_name is missing for a tool-matched rule', async () => { const d = tempDir(); writeFileSync(join(d, 'tool.yaml'), rule('tool', 'PreToolUse', 'nudge', false, 'x').replace('match: {}', 'match:\n  tool: Bash')); const r = await runHook(d, JSON.stringify({ hook_event_name: 'PreToolUse' })); expect(r).toMatchObject({ code: 0 }); expect(r.stdout.trim()).toBe('{}'); expect(r.stdout).not.toContain('deny'); expect(r.stderr).not.toContain('FAILED OPEN'); });
  it('renders no matches for a non-string cwd', async () => { const d = tempDir(); writeFileSync(join(d, 'cwd.yaml'), rule('cwd', 'PreToolUse', 'nudge', false, 'x').replace('match: {}', 'match:\n  cwd: /a')); const r = await runHook(d, JSON.stringify({ hook_event_name: 'PreToolUse', cwd: 2 })); expect(r).toMatchObject({ code: 0 }); expect(r.stdout.trim()).toBe('{}'); expect(r.stderr).not.toContain('FAILED OPEN'); });
  it('renders no matches for an unknown event', async () => { const r = await runHook(tempDir(), JSON.stringify({ hook_event_name: 'FutureEvent' })); expect(r).toMatchObject({ code: 0 }); expect(r.stdout.trim()).toBe('{}'); expect(r.stderr).not.toContain('FAILED OPEN'); });
  it('preserves an earned deny when a sibling tool-matched rule cannot match a missing tool_name', async () => { const d = tempDir(); writeFileSync(join(d, 'deny.yaml'), rule('deny', 'PreToolUse', 'block', true, 'denied')); writeFileSync(join(d, 'tool.yaml'), rule('tool', 'PreToolUse', 'nudge', false, 'x').replace('match: {}', 'match:\n  tool: Bash')); const r = await runHook(d, JSON.stringify({ hook_event_name: 'PreToolUse' })); expect(r.code).toBe(0); expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny'); });
  it('does not deny when the rules directory has malformed yaml', async () => { const d = tempDir(); writeFileSync(join(d, 'bad.yaml'), 'id: ['); const r = await runHook(d, JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash' })); expect(r).toMatchObject({ code: 0 }); expect(r.stdout.trim()).toBe('{}'); expect(r.stderr).toContain("rule 'bad.yaml' ignored"); expect(r.stdout).not.toContain('deny'); });
  it('renders an empty object for a Stop payload when no rule targets Stop', async () => { const d = tempDir(); writeFileSync(join(d, 'other.yaml'), rule('other', 'SessionStart', 'inject', false, 'welcome')); const r = await runHook(d, JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: true })); expect(r).toMatchObject({ code: 0 }); expect(r.stdout.trim()).toBe('{}'); });
  it('prints an empty object for an empty rules directory', async () => { const r = await runHook(tempDir(), JSON.stringify({ hook_event_name: 'Stop' })); expect(r).toMatchObject({ code: 0 }); expect(r.stdout.trim()).toBe('{}'); });
});
