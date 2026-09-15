import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { accountsStep, runSetup, buildSteps, dryRunGate, selectSteps, summarizeAccounts, type SetupContext } from '../../src/wizard/setup.js';
import { createDoctorStep } from '../../src/wizard/doctor.js';
import { policyPath } from '../../src/wizard/persist.js';
import type { Prompter } from '../../src/wizard/prompt.js';
import { ScriptedPrompter } from '../../src/wizard/prompt.js';
import type { CliRunner } from '../../src/wizard/cli-runner.js';
import type { WizardContext, WizardIO, WizardStep, WizardStepResult } from '../../src/wizard/step.js';
import { useTempResources } from '../helpers.js';

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

/** Seed a minimal rule catalog (one rule) so the rules step has real presets to resolve — mirrors the
 *  fixture in rules-step.test.ts, kept local so this file exercises the rules wire-in hermetically. */
function seedCatalog(root: string): void {
  mkdirSync(join(root, 'tests'), { recursive: true });
  writeFileSync(
    join(root, 'no-rm-recursive-force.yaml'),
    'id: no-rm-recursive-force\nevent: PreToolUse\nmatch:\n  tool: Bash\naction: block\nenforce: false\nsubagent_aware: false\nmessage: Do not recursively force-remove files.\nfail_open: true\n',
  );
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

  it('applies a step\'s published selectedTargetDir to ctx.targetDir before a later step\'s applies() (HED-624)', async () => {
    // The propagation mechanism, hermetically: a step (like pr-automation's offer-to-add-repo) resolves a
    // repo mid-run and publishes it via selectedTargetDir; runSetup writes it to ctx.targetDir (marked
    // derived) BEFORE the next step's applies() runs, so a target-gated step (like cd-automation) runs on it.
    let sawTarget: string | undefined;
    let sawDerived: boolean | undefined;
    let gatedRan = false;
    const publisher: WizardStep = {
      id: 'publisher',
      title: 'PUBLISHER',
      run: async () => ({ id: 'publisher', status: 'done', summary: 'resolved a repo', selectedTargetDir: '/picked/repo' }),
    };
    const targetGated: WizardStep = {
      id: 'consumer',
      title: 'CONSUMER',
      applies: (ctx) => !!ctx.targetDir,
      run: async (ctx) => {
        gatedRan = true;
        sawTarget = ctx.targetDir;
        sawDerived = ctx.targetDirDerived;
        return { id: 'consumer', status: 'done', summary: 'ran on the published target' };
      },
    };
    const results = await runSetup(baseCtx(), makeIO(), [publisher, targetGated]);
    expect(gatedRan).toBe(true);
    expect(sawTarget).toBe('/picked/repo');
    expect(sawDerived).toBe(true); // an offer-entered target is not an explicit --target
    expect(results.map((r) => r.id)).toEqual(['publisher', 'consumer']);
  });

  it('a target-gated step stays skipped when NO earlier step publishes a target (control for HED-624)', async () => {
    // Proves the propagation above is load-bearing: without a published selectedTargetDir, the gate's
    // applies() sees no targetDir and runSetup records it not-applicable — the exact bug the qodo HIGH named.
    let gatedRan = false;
    const noPublish: WizardStep = {
      id: 'no-publish',
      title: 'NO-PUBLISH',
      run: async () => ({ id: 'no-publish', status: 'done', summary: 'resolved nothing new' }),
    };
    const targetGated: WizardStep = {
      id: 'consumer',
      title: 'CONSUMER',
      applies: (ctx) => !!ctx.targetDir,
      run: async () => { gatedRan = true; return { id: 'consumer', status: 'done', summary: 'ran' }; },
    };
    const results = await runSetup(baseCtx(), makeIO(), [noPublish, targetGated]);
    expect(gatedRan).toBe(false);
    expect(results.find((r) => r.id === 'consumer')?.summary).toContain('not applicable');
  });

  it('reports a finish screen that lists every step outcome', async () => {
    const io = makeIO();
    await runSetup(baseCtx(), io, [step('a', { summary: 'a done' }), step('b', { status: 'skipped', summary: 'b skipped' })]);
    const text = io.lines.join('\n');
    expect(text).toContain('Setup complete');
    expect(text).toContain('a done');
    expect(text).toContain('b skipped');
  });

  it('closing guidance says "verified end-to-end" when the doctor step ran and passed (no redundant re-run prompt)', async () => {
    const io = makeIO();
    await runSetup(baseCtx(), io, [step('a'), step('doctor', { status: 'done', summary: 'setup verified' })]);
    const text = io.lines.join('\n');
    expect(text).toContain('verified end-to-end');
    expect(text).not.toContain('Run `heddle doctor`'); // doctor just ran — don't ask to repeat it
  });

  it('closing guidance keeps the "Run `heddle doctor`" prompt when doctor did not run (excluded)', async () => {
    const io = makeIO();
    await runSetup(baseCtx(), io, [step('a')]);
    expect(io.lines.join('\n')).toContain('Run `heddle doctor`');
  });

  it('closing guidance keeps the "Run `heddle doctor`" prompt when doctor was skipped, not done', async () => {
    const io = makeIO();
    await runSetup(baseCtx(), io, [step('a'), step('doctor', { status: 'skipped', summary: 'dry-run' })]);
    const text = io.lines.join('\n');
    expect(text).toContain('Run `heddle doctor`');
    expect(text).not.toContain('verified end-to-end');
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

  it('buildSteps wires the full walkthrough in order with the doctor finish-gate last', () => {
    const runner = {} as CliRunner;
    const ids = buildSteps({ runner }).map((s) => s.id);
    // Walkthrough order (HED-564): canonical → accounts → model-economy → spread → meters → rules → permissions → pr-automation → cd-automation → doctor.
    // buildSteps({ runner }) with no catalogRoot defaults it to resolveCatalogRoot() (the bundled
    // catalog), so this also proves the default path constructs without throwing.
    expect(ids).toEqual(['canonical', 'accounts', 'model-economy', 'spread', 'meters', 'rules', 'permissions', 'pr-automation', 'cd-automation', 'doctor']);
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
  const { tempDir } = useTempResources('hed564-wire-');

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
    // homeDir must be an ISOLATED empty temp dir: canonicalStep reads `${homeDir}/.heddle/canonical.json`
    // BEFORE its dry-run branch, so a shared /tmp/home carrying a stale canonical.json would flip it to
    // `done` and break the pin below. ($HEDDLE_CANONICAL, the other prior-state source it reads, is
    // stripped globally in test/setup.ts's hermetic env list.)
    const results = await runSetup(baseCtx({ dryRun: true, homeDir: tempDir() }), io, buildSteps({ runner }));
    // Every wired step is skipped under --dry-run with no prompts or writes: canonical/model-economy/spread/meters/
    // rules/permissions self-handle dry-run in their own module, doctor via dryRunGate, and pr-automation —
    // which now APPLIES even without a --target so it can offer to add a repo (HED-624) — takes its no-target
    // dry-run branch: it DISCLOSES that a real run would offer a repo path then confirm, and returns skipped
    // without prompting or writing (the exhausted prompter above would throw if it prompted). cd-automation
    // (HED-603) is git-target-gated via applies() and there is no --target here, so runSetup records it
    // 'not applicable in this context' (its dry-run branch is covered by the module's own tests). toEqual pins
    // the exact composed order + shape.
    expect(results).toEqual([
      { id: 'canonical', status: 'skipped', summary: expect.stringContaining('dry-run') },
      { id: 'accounts', status: 'skipped', summary: expect.stringContaining('dry-run') },
      { id: 'model-economy', status: 'skipped', summary: expect.stringContaining('dry-run') },
      { id: 'spread', status: 'skipped', summary: expect.stringContaining('dry-run') },
      { id: 'meters', status: 'skipped', summary: expect.stringContaining('dry-run') },
      { id: 'rules', status: 'skipped', summary: expect.stringContaining('dry-run') },
      { id: 'permissions', status: 'skipped', summary: expect.stringContaining('dry-run') },
      { id: 'pr-automation', status: 'skipped', summary: expect.stringContaining('a real run would offer a path, then confirm') },
      { id: 'cd-automation', status: 'skipped', summary: expect.stringContaining('not applicable') },
      { id: 'doctor', status: 'skipped', summary: expect.stringContaining('dry-run') },
    ]);
    const text = lines.join('\n');
    expect(text).toContain('Setup complete');
    // The doctor preview line stands in for the real probe.
    expect(text).toContain('a real setup would run');
  });

  it('runs the doctor gate under an alternate --home, verifying the re-rooted account registry — HED-596', async () => {
    // HED-596: the doctor module is now home-aware — homePaths re-roots the account registry it verifies
    // under ctx.homeDir — so the composed finish-gate RUNS under `heddle setup --home <dir>` and honestly
    // verifies the --home install; it no longer honest-skips (the old skipDoctorUnderAltHome guard is
    // gone). Inject a doctor runner that CAPTURES the paths it is handed (proving ctx.homeDir was threaded
    // into homePaths) and returns a green report — fast + hermetic, so the real provider probes never run.
    // A stubbed empty env keeps homePaths off any ambient HEDDLE_ACCOUNTS, making the path assertion exact.
    const altHome = '/tmp/definitely-not-the-real-home';
    let seenAccounts: string | undefined;
    const doctor = createDoctorStep({
      doctorDeps: { env: {} },
      runDoctor: async (_opts, partial) => {
        seenAccounts = partial.paths?.accounts;
        return { checks: [], summary: { ok: 5, warn: 0, fail: 0, skipped: 0 }, exitCode: 0 };
      },
    });
    const io = makeIO();
    const ctx: WizardContext = { ...baseCtx({ homeDir: altHome, dryRun: false }), results: new Map() };
    const result = await doctor.run(ctx, io);
    expect(result.status).toBe('done'); // RAN under --home (the old guard would have returned 'skipped')
    expect(result.summary).not.toContain('HED-596'); // no honest-skip line
    expect(seenAccounts).toBe(join(altHome, '.heddle', 'accounts.json')); // re-rooted under ctx.homeDir
  });

  it('plumbs an injected catalogRoot through to the rules step (not swallowed)', async () => {
    // The order test proves the DEFAULT catalogRoot path (resolveCatalogRoot()) constructs; this proves
    // an INJECTED catalogRoot is actually honored — run the composed rules step against a seeded fixture
    // catalog and assert its summary names the seeded rule. Without plumbing, buildSteps would resolve
    // the bundled catalog instead and this seeded id would never appear.
    const catalogRoot = tempDir();
    const homeDir = tempDir();
    seedCatalog(catalogRoot);
    const rules = buildSteps({ runner: {} as CliRunner, catalogRoot }).find((s) => s.id === 'rules');
    if (!rules) throw new Error('rules step missing from buildSteps');
    const ctx: WizardContext = { ...baseCtx({ homeDir }), results: new Map() };
    // minimal preset → accept as-is → save (mirrors rules-step.test.ts's accepted-minimal flow).
    const io: WizardIO = { prompter: new ScriptedPrompter(['minimal', true, true]), report: () => {} };
    const result = await rules.run(ctx, io);
    expect(result.status).toBe('done');
    expect(result.summary).toContain('no-rm-recursive-force');
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
