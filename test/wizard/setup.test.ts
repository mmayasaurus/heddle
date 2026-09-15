import { describe, expect, it } from 'vitest';
import { accountsStep, runSetup, buildSteps, dryRunGate, selectSteps, summarizeAccounts, type SetupContext } from '../../src/wizard/setup.js';
import { policyPath } from '../../src/wizard/persist.js';
import type { Prompter } from '../../src/wizard/prompt.js';
import { ScriptedPrompter } from '../../src/wizard/prompt.js';
import type { CliRunner } from '../../src/wizard/cli-runner.js';
import type { WizardContext, WizardIO, WizardStep, WizardStepResult } from '../../src/wizard/step.js';

// HED-564: the `heddle setup` orchestrator — ordering, fail-soft, applies-gating, prior-result reads,
// dry-run passthrough, and the finish screen, all against SYNTHETIC steps. The full account/rules/etc.
// scenario matrix belongs to each step module's own tests (and W's HED-571 harness), not here.

const noopPrompter = {} as Prompter; // synthetic steps never prompt

function makeIO(): WizardIO & { lines: string[] } {
  const lines: string[] = [];
  return { prompter: noopPrompter, report: (line) => { lines.push(line); }, lines };
}

function baseCtx(overrides: Partial<SetupContext> = {}): SetupContext {
  return { homeDir: '/tmp/home', now: () => new Date('2026-01-01T00:00:00Z'), ...overrides };
}

/** A synthetic step that records when its run() fires; optionally throws or gates itself off. */
function step(id: string, opts: {
  onRun?: (ctx: WizardContext) => void;
  throws?: string;
  applies?: boolean;
  status?: WizardStepResult['status'];
  summary?: string;
} = {}): WizardStep {
  return {
    id,
    title: id.toUpperCase(),
    ...(opts.applies === undefined ? {} : { applies: () => opts.applies! }),
    run: async (ctx) => {
      opts.onRun?.(ctx);
      if (opts.throws) throw new Error(opts.throws);
      return { id, status: opts.status ?? 'done', summary: opts.summary ?? `${id} ok` };
    },
  };
}

describe('runSetup orchestrator', () => {
  it('runs steps in array order and returns results in run order', async () => {
    const order: string[] = [];
    const steps = [
      step('a', { onRun: () => order.push('a') }),
      step('b', { onRun: () => order.push('b') }),
      step('c', { onRun: () => order.push('c') }),
    ];
    const results = await runSetup(baseCtx(), makeIO(), steps);
    expect(order).toEqual(['a', 'b', 'c']);
    expect(results.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('is fail-soft: a throwing step is recorded failed AND every later step still runs', async () => {
    const ran: string[] = [];
    const steps = [
      step('first', { onRun: () => ran.push('first') }),
      step('boom', { onRun: () => ran.push('boom'), throws: 'kaboom' }),
      step('after', { onRun: () => ran.push('after') }),
    ];
    const results = await runSetup(baseCtx(), makeIO(), steps);
    // The property: the throw does not abort the walkthrough — the later step still ran.
    expect(ran).toEqual(['first', 'boom', 'after']);
    const boom = results.find((r) => r.id === 'boom');
    expect(boom?.status).toBe('failed');
    expect(boom?.summary).toContain('kaboom');
    expect(results.find((r) => r.id === 'after')?.status).toBe('done');
  });

  it('is fail-soft when applies() throws: records the step failed AND later steps still run', async () => {
    const ran: string[] = [];
    const throwingGate: WizardStep = {
      id: 'gate',
      title: 'GATE',
      applies: () => { throw new Error('gate predicate boom'); },
      run: async () => { ran.push('gate-run'); return { id: 'gate', status: 'done', summary: 'gate ran' }; },
    };
    const io = makeIO();
    const results = await runSetup(baseCtx(), io, [throwingGate, step('after', { onRun: () => ran.push('after') })]);
    // The throwing predicate is caught: run() never fired for the gate, but the walkthrough did NOT abort.
    expect(ran).toEqual(['after']);
    const gate = results.find((r) => r.id === 'gate');
    expect(gate?.status).toBe('failed');
    expect(gate?.summary).toContain('gate predicate boom');
    expect(results.find((r) => r.id === 'after')?.status).toBe('done');
    // The finish screen still renders — it would be skipped entirely if the throw had escaped runSetup.
    expect(io.lines.join('\n')).toContain('Setup complete');
  });

  it('throws a clear composition error on duplicate step ids, before running any step', async () => {
    const ran: string[] = [];
    const dup = [step('dup', { onRun: () => ran.push('a') }), step('dup', { onRun: () => ran.push('b') })];
    await expect(runSetup(baseCtx(), makeIO(), dup)).rejects.toThrow(/duplicate step id 'dup'/);
    expect(ran).toEqual([]); // guarded before either step ran
  });

  it('skips a step whose applies() returns false without calling run()', async () => {
    let ran = false;
    const steps = [step('skipme', { applies: false, onRun: () => { ran = true; } })];
    const results = await runSetup(baseCtx(), makeIO(), steps);
    expect(ran).toBe(false);
    expect(results[0]?.status).toBe('skipped');
  });

  it('exposes each prior result to later steps through the read-only ctx.results view', async () => {
    let seen: string | undefined;
    const steps = [
      step('first', { summary: 'from-first' }),
      step('second', { onRun: (ctx) => { seen = ctx.results.get('first')?.summary; } }),
    ];
    await runSetup(baseCtx(), makeIO(), steps);
    expect(seen).toBe('from-first');
  });

  it('passes ctx.dryRun through to steps', async () => {
    let sawDryRun: boolean | undefined;
    const steps = [step('dr', { onRun: (ctx) => { sawDryRun = ctx.dryRun; } })];
    await runSetup(baseCtx({ dryRun: true }), makeIO(), steps);
    expect(sawDryRun).toBe(true);
  });

  it('reports a finish screen that lists every step outcome', async () => {
    const io = makeIO();
    await runSetup(baseCtx(), io, [step('a', { summary: 'a done' }), step('b', { status: 'skipped', summary: 'b skipped' })]);
    const text = io.lines.join('\n');
    expect(text).toContain('Setup complete');
    expect(text).toContain('a done');
    expect(text).toContain('b skipped');
  });
});

describe('accountsStep adapter', () => {
  it('under --dry-run performs no prompts, logins, or writes and returns skipped', async () => {
    // The runner throws if touched → proves dry-run never logs in or probes.
    const runner: CliRunner = {
      login() { throw new Error('dry-run must not log in'); },
      status() { throw new Error('dry-run must not probe status'); },
    };
    // An exhausted scripted prompter throws if any question is asked → proves dry-run never prompts.
    const io: WizardIO = { prompter: new ScriptedPrompter([]), report: () => {} };
    const ctx: WizardContext = { ...baseCtx({ dryRun: true }), results: new Map() };
    const result = await accountsStep(runner).run(ctx, io);
    expect(result.status).toBe('skipped');
    expect(result.summary.toLowerCase()).toContain('dry-run');
  });

  it('buildSteps wires accounts first and the doctor finish-gate last', () => {
    const runner = {} as CliRunner;
    const ids = buildSteps({ runner }).map((s) => s.id);
    expect(ids).toEqual(['accounts', 'doctor']);
    // Doctor is the finish gate — it must ALWAYS be last so it verifies AFTER every write-step ran.
    expect(ids[ids.length - 1]).toBe('doctor');
  });
});

describe('policyPath', () => {
  it('resolves a wizard policy object under <home>/.heddle/policy/<id>.json', () => {
    expect(policyPath('/home/op', 'meters')).toBe('/home/op/.heddle/policy/meters.json');
    expect(policyPath('/home/op', 'model-economy')).toBe('/home/op/.heddle/policy/model-economy.json');
  });
});

describe('composed walkthrough (buildSteps -> runSetup)', () => {
  it('runs the wired step set end-to-end under --dry-run with no prompts, logins, writes, or doctor probe', async () => {
    // Throwing runner + exhausted prompter → any login or prompt fails the test. The doctor step is
    // dry-run-gated in buildSteps, so real runDoctor is never reached under --dry-run — that is what
    // keeps this composed test hermetic without injecting a canned doctor (no ~/.heddle read, no
    // binary spawn). A fresh box previewing setup must NOT be reported as "failing verification".
    const runner: CliRunner = {
      login() { throw new Error('dry-run must not log in'); },
      status() { throw new Error('dry-run must not probe status'); },
    };
    const lines: string[] = [];
    const io: WizardIO = { prompter: new ScriptedPrompter([]), report: (line) => { lines.push(line); } };
    const results = await runSetup(baseCtx({ dryRun: true }), io, buildSteps({ runner }));
    expect(results).toEqual([
      { id: 'accounts', status: 'skipped', summary: expect.stringContaining('dry-run') },
      { id: 'doctor', status: 'skipped', summary: expect.stringContaining('dry-run') },
    ]);
    const text = lines.join('\n');
    expect(text).toContain('Setup complete');
    // The doctor preview line stands in for the real probe.
    expect(text).toContain('a real setup would run');
  });
});

describe('dryRunGate (doctor finish-gate composition)', () => {
  it('when NOT dry-run, delegates to the wrapped step and returns its result unchanged', async () => {
    // This is the guard that proves production runs the REAL step (the real doctor probe), not a stub.
    let ran = false;
    const inner = step('inner', { onRun: () => { ran = true; }, summary: 'inner did real work' });
    const gated = dryRunGate(inner, 'WOULD (preview only)');
    const io = makeIO();
    const result = await gated.run({ ...baseCtx(), results: new Map() }, io);
    expect(ran).toBe(true);
    expect(result).toEqual({ id: 'inner', status: 'done', summary: 'inner did real work' });
    expect(io.lines).not.toContain('WOULD (preview only)'); // the preview line is dry-run-only
  });

  it('under --dry-run, skips the wrapped step (run never fires) and reports the preview line', async () => {
    let ran = false;
    const inner = step('inner', { onRun: () => { ran = true; } });
    const gated = dryRunGate(inner, 'WOULD verify the environment');
    const io = makeIO();
    const result = await gated.run({ ...baseCtx({ dryRun: true }), results: new Map() }, io);
    expect(ran).toBe(false);
    expect(result.id).toBe('inner');
    expect(result.status).toBe('skipped');
    expect(io.lines).toContain('WOULD verify the environment');
  });

  it('preserves the wrapped step id and title', () => {
    const gated = dryRunGate(step('doctor'), 'x');
    expect(gated.id).toBe('doctor');
    expect(gated.title).toBe('DOCTOR');
  });
});

describe('summarizeAccounts', () => {
  it("reports 'failed' when ANY account failed, so setup exits non-zero (even with some added)", () => {
    expect(summarizeAccounts({ added: ['claude-1'], failed: ['codex-1'], skipped: [] }).status).toBe('failed');
  });
  it("reports 'failed' when every attempted account failed", () => {
    expect(summarizeAccounts({ added: [], failed: ['claude-1'], skipped: [] }).status).toBe('failed');
  });
  it("reports 'done' when something was added and nothing failed", () => {
    expect(summarizeAccounts({ added: ['claude-1'], failed: [], skipped: ['codex'] }).status).toBe('done');
  });
  it("reports 'skipped' when the operator declined every account (nothing added, nothing failed)", () => {
    expect(summarizeAccounts({ added: [], failed: [], skipped: ['claude', 'codex', 'cursor'] }).status).toBe('skipped');
  });
  it('echoes added/failed counts in the summary', () => {
    const s = summarizeAccounts({ added: ['a'], failed: ['b'], skipped: ['cursor'] }).summary;
    expect(s).toContain('1 added');
    expect(s).toContain('1 failed');
  });
});

describe('selectSteps', () => {
  const steps = (): WizardStep[] => [step('a'), step('b'), step('c')];
  it('returns all steps when neither --only nor --skip is given', () => {
    expect(selectSteps(steps()).map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });
  it('keeps only the --only ids, in original order', () => {
    expect(selectSteps(steps(), ['c', 'a']).map((s) => s.id)).toEqual(['a', 'c']);
  });
  it('drops the --skip ids', () => {
    expect(selectSteps(steps(), undefined, ['b']).map((s) => s.id)).toEqual(['a', 'c']);
  });
  it('throws on an unknown id', () => {
    expect(() => selectSteps(steps(), ['nope'])).toThrow(/unknown step id/);
  });
  it('throws when both --only and --skip are given', () => {
    expect(() => selectSteps(steps(), ['a'], ['b'])).toThrow(/only or --skip, not both/);
  });
});
