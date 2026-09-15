import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from './helpers/cli.js';

// HED-624: `heddle setup` with no --target auto-derives the project dir from the invocation cwd when it is
// inside a git repo (gitRepositoryFor(cwd).topLevel), flagging it targetDirDerived so the pr-automation step
// confirms before scaffolding. These drive the REAL CLI — runCli spawns dist/cli.js with cwd = the heddle
// checkout, which is itself a git repo — to prove the cli.ts derive→flag→context wiring end to end. --dry-run
// keeps it hermetic: no prompts fire, nothing is written, and the doctor finish-gate is skipped.
interface StepResult { id: string; status: string; summary: string }

const prAutomation = (stdout: string): StepResult | undefined =>
  (JSON.parse(stdout) as StepResult[]).find((step) => step.id === 'pr-automation');

describe('heddle setup — targetDir auto-derive (HED-624)', () => {
  it('no --target inside a git repo: derives the target so pr-automation activates and its dry-run discloses the confirm', async () => {
    const result = await runCli(['setup', '--dry-run', '--json']);
    expect(result.code, result.stderr).toBe(0);
    const pr = prAutomation(result.stdout);
    // Auto-derive activated the step (without a target it would be "no target directory"); the derived flag
    // makes the dry-run disclose that a real run would confirm first (Maya's Option B).
    expect(pr, 'pr-automation step should be present once the target is auto-derived').toBeDefined();
    expect(pr?.status).toBe('skipped'); // dry-run
    expect(pr?.summary).toContain('auto-detected repo, would confirm first');
  });

  it('explicit --target is the silent opt-in: no auto-detected disclosure', async () => {
    const target = mkdtempSync(join(tmpdir(), 'hed624-explicit-'));
    mkdirSync(join(target, '.git')); // applies() needs a .git; an explicit target is never flagged derived
    const result = await runCli(['setup', '--dry-run', '--json', '--target', target]);
    expect(result.code, result.stderr).toBe(0);
    const pr = prAutomation(result.stdout);
    expect(pr?.status).toBe('skipped');
    expect(pr?.summary).not.toContain('auto-detected');
  });
});
