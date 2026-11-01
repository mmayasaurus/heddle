import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureBuilt, PROJECT_ROOT } from '../helpers/cli.js';
import { useTempResources } from '../helpers.js';

const rule = (id: string, event: string, action: string, enforce: boolean, message: string) => `id: ${id}\nevent: ${event}\nmatch: {}\naction: ${action}\nenforce: ${enforce}\nsubagent_aware: false\nmessage: ${message}\nfail_open: true\n`;
function writePolicy(home: string, policy: unknown, mode = 0o600): void {
  const dir = join(home, '.heddle', 'policy');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'rules.json');
  writeFileSync(path, typeof policy === 'string' ? policy : JSON.stringify(policy));
  // Exact mode, umask-independent: 0600 satisfies secureReadFile (owner-only); 0644 exercises its refusal.
  chmodSync(path, mode);
}
async function runHook(rules: string, stdin: string, env: Record<string, string> = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  // Mirror HOME into USERPROFILE: homedir() reads USERPROFILE on Windows, so a HOME-only env would let the
  // hook resolve the policy from the REAL operator home there. Matches test/helpers/cli.ts cleanEnv. (The
  // hook is POSIX-only in practice — shebang + secure-fs geteuid — so this is isolation hygiene, not a
  // Windows correctness claim.) — cursor #237
  const home = env.HOME ?? join(rules, '.home');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'dist/hook.js', '--rules', rules], { cwd: PROJECT_ROOT, env: { PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (s) => { stdout += s; }); child.stderr.on('data', (s) => { stderr += s; });
    child.once('error', reject); child.once('close', (code) => resolve({ stdout, stderr, code: code ?? 1 })); child.stdin.end(stdin);
  });
}
describe('heddle-hook bin', () => {
  const { tempDir } = useTempResources('heddle-hook-e2e-');
  beforeAll(async () => { await ensureBuilt(); }, 120_000);
  it('denies a matching enforced PreToolUse rule', async () => { const d = tempDir(); writeFileSync(join(d, 'deny.yaml'), rule('deny', 'PreToolUse', 'block', true, 'denied')); const r = await runHook(d, JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash' })); expect(r.code).toBe(0); expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny'); });
  it('downgrades a selected catalog block when policy enforcement is false', async () => {
    const rules = tempDir(); const home = tempDir();
    writeFileSync(join(rules, 'sample-block.yaml'), rule('sample-block', 'PreToolUse', 'block', true, 'denied'));
    writePolicy(home, { schemaVersion: 1, rules: [{ id: 'sample-block', enforce: false }] });
    const r = await runHook(rules, JSON.stringify({ hook_event_name: 'PreToolUse' }), { HOME: home });
    const output = JSON.parse(r.stdout);
    expect(output.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(output.hookSpecificOutput.additionalContext).toContain('(would block) denied');
  });
  it('downgrades an unselected catalog block without dropping its warning', async () => {
    const rules = tempDir(); const home = tempDir();
    writeFileSync(join(rules, 'sample-block.yaml'), rule('sample-block', 'PreToolUse', 'block', true, 'denied'));
    writePolicy(home, { schemaVersion: 1, rules: [] });
    const r = await runHook(rules, JSON.stringify({ hook_event_name: 'PreToolUse' }), { HOME: home });
    const output = JSON.parse(r.stdout);
    expect(output.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(output.hookSpecificOutput.additionalContext).toContain('(would block) denied');
  });
  it('preserves an enforced catalog block selected for enforcement', async () => {
    const rules = tempDir(); const home = tempDir();
    writeFileSync(join(rules, 'sample-block.yaml'), rule('sample-block', 'PreToolUse', 'block', true, 'denied'));
    writePolicy(home, { schemaVersion: 1, rules: [{ id: 'sample-block', enforce: true }] });
    const r = await runHook(rules, JSON.stringify({ hook_event_name: 'PreToolUse' }), { HOME: home });
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });
  it('caps a policy enforcement up-dial at the catalog warning level', async () => {
    const rules = tempDir(); const home = tempDir();
    writeFileSync(join(rules, 'sample-block.yaml'), rule('sample-block', 'PreToolUse', 'block', false, 'denied'));
    writePolicy(home, { schemaVersion: 1, rules: [{ id: 'sample-block', enforce: true }] });
    const r = await runHook(rules, JSON.stringify({ hook_event_name: 'PreToolUse' }), { HOME: home });
    const output = JSON.parse(r.stdout);
    expect(output.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(output.hookSpecificOutput.additionalContext).toContain('(would block) denied');
  });
  it('fails open SILENTLY (no warning) when no policy file exists', async () => {
    // R convergence item 1 through the real binary: an ABSENT policy warns NOTHING and preserves catalog
    // enforcement (the wizard-never-ran case must not print a warning on every per-tool-call hook run).
    const rules = tempDir(); const home = tempDir();
    writeFileSync(join(rules, 'sample-block.yaml'), rule('sample-block', 'PreToolUse', 'block', true, 'denied'));
    const r = await runHook(rules, JSON.stringify({ hook_event_name: 'PreToolUse' }), { HOME: home });
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    expect(r.stderr).not.toContain('rules policy');
    expect(r.stderr).not.toContain('FAILED OPEN');
  });
  it.each([
    ['invalid JSON', '{'],
    ['non-v1', { schemaVersion: 2, rules: [{ id: 'sample-block', enforce: false }] }],
  ])('warns LOUDLY for a present-but-unusable (%s) policy and preserves catalog enforcement', async (_name, policy) => {
    const rules = tempDir(); const home = tempDir();
    writeFileSync(join(rules, 'sample-block.yaml'), rule('sample-block', 'PreToolUse', 'block', true, 'denied'));
    writePolicy(home, policy);
    const r = await runHook(rules, JSON.stringify({ hook_event_name: 'PreToolUse' }), { HOME: home });
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    expect(r.stderr).toContain('rules policy');
    expect(r.stderr).not.toContain('FAILED OPEN');
  });
  it('warns LOUDLY for a group/other-readable policy (secure-fs refuses it) and preserves catalog enforcement', async () => {
    // R convergence item 2 through the real binary: a rules.json that is not owner-only (0644) is refused by
    // secureReadFile → the hook warns + falls back to catalog. Fails if the read path reverts to bare fs.
    const rules = tempDir(); const home = tempDir();
    writeFileSync(join(rules, 'sample-block.yaml'), rule('sample-block', 'PreToolUse', 'block', true, 'denied'));
    writePolicy(home, { schemaVersion: 1, rules: [{ id: 'sample-block', enforce: false }] }, 0o644);
    const r = await runHook(rules, JSON.stringify({ hook_event_name: 'PreToolUse' }), { HOME: home });
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    expect(r.stderr).toContain('rules policy');
    expect(r.stderr).not.toContain('FAILED OPEN');
  });
  it('does NOT hang and warns LOUDLY when the policy path is a FIFO (secure-fs O_NONBLOCK guard)', async () => {
    // Round-3 adversarial HIGH: a FIFO at rules.json would block secureReadFile in open() (waiting for a
    // writer) WITHOUT O_NONBLOCK, hanging the hook on EVERY tool call. Assert the hook returns FAST (the
    // kill-timer FAILS this test if it hangs AND reaps the child, so a regression leaves no orphan blocked
    // in open()), warns loudly (present-but-unusable), and still denies (catalog enforcement preserved).
    const rules = tempDir(); const home = tempDir();
    writeFileSync(join(rules, 'sample-block.yaml'), rule('sample-block', 'PreToolUse', 'block', true, 'denied'));
    const policyDir = join(home, '.heddle', 'policy');
    mkdirSync(policyDir, { recursive: true, mode: 0o700 });
    execFileSync('mkfifo', [join(policyDir, 'rules.json')]); // Node has no mkfifo
    const r = await new Promise<{ stdout: string; stderr: string; code: number; timedOut: boolean }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'dist/hook.js', '--rules', rules], { cwd: PROJECT_ROOT, env: { PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home }, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = ''; child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', (s) => { stdout += s; }); child.stderr.on('data', (s) => { stderr += s; });
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ stdout, stderr, code: -1, timedOut: true }); }, 4000);
      child.once('error', (e) => { clearTimeout(timer); reject(e); });
      child.once('close', (code) => { clearTimeout(timer); resolve({ stdout, stderr, code: code ?? 1, timedOut: false }); });
      child.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse' }));
    });
    expect(r.timedOut).toBe(false); // the hook must NOT hang on the FIFO policy path
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    expect(r.stderr).toContain('rules policy');
    expect(r.stderr).not.toContain('FAILED OPEN');
  });
  it('does NOT echo invalid-policy file content into stderr (no log/terminal injection)', async () => {
    // PR #237 qodo HIGH regression pin, through the REAL binary: a planted invalid policy whose content
    // carries a distinctive marker must NOT surface in the hook's stderr — the warning names the path only.
    // A revert that re-interpolated JSON.parse's message (which echoes the raw bytes) would leak the marker.
    const rules = tempDir(); const home = tempDir();
    writeFileSync(join(rules, 'sample-block.yaml'), rule('sample-block', 'PreToolUse', 'block', true, 'denied'));
    writePolicy(home, 'INJECT3D_MARKER_ZZZ not json'); // raw invalid-JSON string, written 0600 (starts at char 0)
    const r = await runHook(rules, JSON.stringify({ hook_event_name: 'PreToolUse' }), { HOME: home });
    expect(r.stderr).toContain('rules policy'); // loud: present-but-unusable
    expect(r.stderr).not.toContain('INJECT3D'); // raw file content must NOT leak into stderr
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny'); // catalog preserved
    expect(r.stderr).not.toContain('FAILED OPEN');
  });
  it('treats HEDDLE_WORKER=0 as an orchestrator for role-matched rules', async () => {
    const d = tempDir();
    writeFileSync(join(d, 'orchestrator.yaml'), rule('orchestrator', 'PreToolUse', 'nudge', false, 'orchestrator rule').replace('match: {}', 'match:\n  agent_role: orchestrator'));
    const r = await runHook(d, JSON.stringify({ hook_event_name: 'PreToolUse' }), { HEDDLE_WORKER: '0' });
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toContain('orchestrator rule');
  });
  it('injects context for a matching SessionStart rule', async () => { const d = tempDir(); writeFileSync(join(d, 'welcome.yaml'), rule('welcome', 'SessionStart', 'inject', false, 'welcome')); const r = await runHook(d, JSON.stringify({ hook_event_name: 'SessionStart' })); expect(r.code).toBe(0); expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toContain('welcome'); });
  it('fails open for junk stdin', async () => { const r = await runHook(tempDir(), 'not json'); expect(r).toMatchObject({ code: 0 }); expect(r.stdout.trim()).toBe('{}'); expect(r.stderr).toContain('FAILED OPEN'); });
  it('does not deny when tool_name is missing for a tool-matched rule', async () => { const d = tempDir(); writeFileSync(join(d, 'tool.yaml'), rule('tool', 'PreToolUse', 'nudge', false, 'x').replace('match: {}', 'match:\n  tool: Bash')); const r = await runHook(d, JSON.stringify({ hook_event_name: 'PreToolUse' })); expect(r).toMatchObject({ code: 0 }); expect(r.stdout.trim()).toBe('{}'); expect(r.stdout).not.toContain('deny'); expect(r.stderr).not.toContain('FAILED OPEN'); });
  it('renders no matches for a non-string cwd', async () => { const d = tempDir(); writeFileSync(join(d, 'cwd.yaml'), rule('cwd', 'PreToolUse', 'nudge', false, 'x').replace('match: {}', 'match:\n  cwd: /a')); const r = await runHook(d, JSON.stringify({ hook_event_name: 'PreToolUse', cwd: 2 })); expect(r).toMatchObject({ code: 0 }); expect(r.stdout.trim()).toBe('{}'); expect(r.stderr).not.toContain('FAILED OPEN'); });
  it('renders no matches for an unknown event', async () => { const r = await runHook(tempDir(), JSON.stringify({ hook_event_name: 'FutureEvent' })); expect(r).toMatchObject({ code: 0 }); expect(r.stdout.trim()).toBe('{}'); expect(r.stderr).not.toContain('FAILED OPEN'); });
  it('preserves an earned deny when a sibling tool-matched rule cannot match a missing tool_name', async () => { const d = tempDir(); writeFileSync(join(d, 'deny.yaml'), rule('deny', 'PreToolUse', 'block', true, 'denied')); writeFileSync(join(d, 'tool.yaml'), rule('tool', 'PreToolUse', 'nudge', false, 'x').replace('match: {}', 'match:\n  tool: Bash')); const r = await runHook(d, JSON.stringify({ hook_event_name: 'PreToolUse' })); expect(r.code).toBe(0); expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny'); });
  it('preserves an earned deny when a sibling input-matched rule receives non-object input', async () => { const d = tempDir(); writeFileSync(join(d, 'deny.yaml'), rule('deny', 'PreToolUse', 'block', true, 'denied')); writeFileSync(join(d, 'input.yaml'), rule('input', 'PreToolUse', 'nudge', false, 'x').replace('match: {}', 'match:\n  input:\n    command: ".*"')); const r = await runHook(d, JSON.stringify({ hook_event_name: 'PreToolUse', tool_input: 1 })); expect(r.code).toBe(0); expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny'); });
  it('does not deny when the rules directory has malformed yaml', async () => { const d = tempDir(); writeFileSync(join(d, 'bad.yaml'), 'id: ['); const r = await runHook(d, JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash' })); expect(r).toMatchObject({ code: 0 }); expect(r.stdout.trim()).toBe('{}'); expect(r.stderr).toContain("rule 'bad.yaml' ignored"); expect(r.stdout).not.toContain('deny'); });
  it('renders an empty object for a Stop payload when no rule targets Stop', async () => { const d = tempDir(); writeFileSync(join(d, 'other.yaml'), rule('other', 'SessionStart', 'inject', false, 'welcome')); const r = await runHook(d, JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: true })); expect(r).toMatchObject({ code: 0 }); expect(r.stdout.trim()).toBe('{}'); });
  it('prints an empty object for an empty rules directory', async () => { const r = await runHook(tempDir(), JSON.stringify({ hook_event_name: 'Stop' })); expect(r).toMatchObject({ code: 0 }); expect(r.stdout.trim()).toBe('{}'); });
});
