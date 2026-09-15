import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createDoctorStep } from '../../src/wizard/doctor.js';
import { runDoctor as realRunDoctor, formatDoctorReport, type DoctorReport, type DoctorDeps } from '../../src/doctor.js';
import { ScriptedPrompter } from '../../src/wizard/prompt.js';
import type { WizardContext, WizardIO } from '../../src/wizard/step.js';
import { useTempResources } from '../helpers.js';
import { fakeDeps } from '../doctor-fixtures.js';

const FIXED = new Date('2026-09-14T00:00:00.000Z');

/** A canned DoctorReport with the given summary counts (checks empty — the step reads summary + formats). */
function report(summary: Partial<DoctorReport['summary']>): DoctorReport {
  const s = { ok: 0, warn: 0, fail: 0, skipped: 0, ...summary };
  return { checks: [], summary: s, exitCode: s.fail > 0 ? 1 : 0 };
}

function makeCtx(homeDir: string): WizardContext {
  return { homeDir, now: () => FIXED, results: new Map() };
}

function makeIO(): { io: WizardIO; lines: string[] } {
  const lines: string[] = [];
  return {
    io: { prompter: new ScriptedPrompter([]), report: (line) => { lines.push(line); } },
    lines,
  };
}

describe('createDoctorStep (HED-476 wizard finish = read-only `heddle doctor`)', () => {
  const { tempDir } = useTempResources('heddle-wizard-doctor-');

  it('reports done and echoes the count when every check passes', async () => {
    const rep = report({ ok: 5 });
    const step = createDoctorStep({ runDoctor: async () => rep });
    const { io, lines } = makeIO();
    const result = await step.run(makeCtx(tempDir()), io);
    expect(result).toMatchObject({ id: 'doctor', status: 'done' });
    expect(result.summary).toBe('setup verified — all 5 checks pass');
    // report() is a per-LINE progress sink, so the formatted table is emitted row-by-row (not one
    // blob); the full text is still returned intact as detail.
    expect(lines).toEqual(formatDoctorReport(rep).split('\n'));
    expect(result.detail).toBe(formatDoctorReport(rep));
  });

  it('reports failed ("setup NOT proven") on any failing check', async () => {
    const rep = report({ ok: 4, warn: 1, fail: 2 });
    const step = createDoctorStep({ runDoctor: async () => rep });
    const result = await step.run(makeCtx(tempDir()), makeIO().io);
    expect(result.status).toBe('failed');
    expect(result.summary).toContain('setup NOT proven');
    expect(result.summary).toContain('2 check(s) failing');
  });

  it('surfaces warnings without failing — warn is advisory, matching doctor exitCode 0', async () => {
    const rep = report({ ok: 3, warn: 2 });
    const step = createDoctorStep({ runDoctor: async () => rep });
    const result = await step.run(makeCtx(tempDir()), makeIO().io);
    expect(result.status).toBe('done');
    expect(result.summary).toBe('setup verified with 2 warning(s) (3 ok, 0 skipped)');
  });

  it('drops "all" and shows the skipped count when checks passed but some were skipped (F2)', async () => {
    // A full sweep always includes skipped checks (e.g. login:gemini has no login harness; artifact
    // drift skips without a dashboard dir). "all N pass" would hide them — cursor F2.
    const rep = report({ ok: 3, skipped: 2 });
    const step = createDoctorStep({ runDoctor: async () => rep });
    const result = await step.run(makeCtx(tempDir()), makeIO().io);
    expect(result.status).toBe('done');
    expect(result.summary).toBe('setup verified — 3 checks pass (2 skipped)');
    expect(result.summary).not.toContain('all '); // never "all N pass" when checks were skipped
  });

  it('maps ran===0 (all-skipped) to FAILED — a status-keyed finish screen must not paint hollow green (F3)', async () => {
    // fail=0 but nothing was actually verified. done would let a status-keyed UI show success for a
    // vacuous run — the hollow-green case HED-476 exists to stop.
    const rep = report({ skipped: 3 });
    const step = createDoctorStep({ runDoctor: async () => rep });
    const result = await step.run(makeCtx(tempDir()), makeIO().io);
    expect(result.status).toBe('failed');
    expect(result.summary).toBe('setup NOT verified — no checks ran (3 skipped)');
  });

  it('maps an empty report (nothing ran, nothing skipped) to FAILED with no skipped suffix (F6)', async () => {
    // The all-zero report is the other ran===0 shape; the suffix must be absent, not "(0 skipped)".
    const rep = report({});
    const step = createDoctorStep({ runDoctor: async () => rep });
    const result = await step.run(makeCtx(tempDir()), makeIO().io);
    expect(result.status).toBe('failed');
    expect(result.summary).toBe('setup NOT verified — no checks ran');
  });

  it('runs a FULL sweep (no provider filter) with the wizard clock, imposing no path overrides (F1/F7)', async () => {
    const spy = vi.fn(async (_opts: { provider?: string }, _partial: Partial<DoctorDeps>) => report({ ok: 1 }));
    const step = createDoctorStep({ runDoctor: spy });
    await step.run(makeCtx(tempDir()), makeIO().io);
    expect(spy).toHaveBeenCalledTimes(1);
    const [opts, partial] = spy.mock.calls[0];
    expect(opts).toEqual({}); // full sweep — no {provider} filter (cursor F7)
    expect(partial.now?.()).toEqual(FIXED); // the wizard's clock reaches the runner
    expect(partial.paths).toBeUndefined(); // the step imposes NO path relocation (cursor F1)
  });

  it('threads injected doctorDeps into the runner, while ctx stays authoritative for the clock', async () => {
    const env = { HEDDLE_ROUTING: '/fixture/routing.yaml' } as NodeJS.ProcessEnv;
    const gitBehindOriginMain = async () => 7;
    const strayNow = () => new Date('2000-01-01T00:00:00.000Z');
    const paths = { accounts: '/fixture/accounts.json' };
    const spy = vi.fn(async (_opts: { provider?: string }, _partial: Partial<DoctorDeps>) => report({ ok: 1 }));
    const step = createDoctorStep({
      runDoctor: spy,
      doctorDeps: { env, gitBehindOriginMain, now: strayNow, paths },
    });
    await step.run(makeCtx(tempDir()), makeIO().io);
    const [, partial] = spy.mock.calls[0];
    // a hermetic test's injected deps thread straight through
    expect(partial.env).toBe(env);
    expect(partial.gitBehindOriginMain).toBe(gitBehindOriginMain);
    expect(partial.paths).toBe(paths); // the step adds none of its own; the injected tree passes through
    // ctx.now is spread AFTER doctorDeps, so the wizard's clock beats any injected now
    expect(partial.now?.()).toEqual(FIXED);
    expect(partial.now?.()).not.toEqual(strayNow());
  });

  it('returns failed (never throws) when the doctor runner rejects', async () => {
    const step = createDoctorStep({ runDoctor: async () => { throw new Error('probe exploded'); } });
    const result = await step.run(makeCtx(tempDir()), makeIO().io);
    expect(result.status).toBe('failed');
    expect(result.summary).toContain('verification could not run');
    expect(result.detail).toContain('probe exploded');
  });

  it('the step wrapper itself writes nothing (read-only verification is runDoctor\'s own contract)', async () => {
    // With a faked runner this pins that the WRAPPER adds no filesystem writes of its own — the
    // regression it guards. It does NOT re-prove runDoctor's read-only-ness (that is doctor.ts's
    // contract); the hermetic integration test below exercises the real runDoctor.
    const home = tempDir();
    mkdirSync(join(home, '.heddle'), { recursive: true });
    const before = treeSnapshot(home);
    const step = createDoctorStep({ runDoctor: async () => report({ ok: 2 }) });
    await step.run(makeCtx(home), makeIO().io);
    expect(treeSnapshot(home)).toEqual(before);
  });

  it('maps a REAL runDoctor report end-to-end on fully hermetic deps, touching no real ~/.heddle state (F5)', async () => {
    // Exercise the actual runDoctor (not a canned report) through the step. fakeDeps() relocates the
    // config tree and fakes execFile/readFileBytes/git, but leaves paths.secrets unset — so we set it
    // too (cursor r4), or freshnessCheck would readFileSync the operator's real ~/.heddle/secrets.env.
    // With that, the sweep touches no real ~/.heddle path and spawns no binary. Capture the real
    // report and assert the MAPPING against it (robust to check-count drift); pin read-only-ness via
    // the files runDoctor could otherwise create — the probed comms.db (schema-migration-on-open) and
    // the secrets path — staying absent. (runDoctor's broader read-only-ness is doctor.ts's own
    // contract, covered by its suite; the wrapper-adds-no-writes regression is the faked-runner test.)
    const base = fakeDeps();
    const secretsPath = join(tempDir(), 'secrets.env');
    const deps = { ...base, paths: { ...base.paths, secrets: secretsPath } };
    const commsPath = deps.paths.comms!;
    expect(existsSync(commsPath)).toBe(false); // precondition: fixtures point comms at an absent path
    expect(existsSync(secretsPath)).toBe(false); // precondition: secrets relocated to an absent temp path
    let rep: DoctorReport | undefined;
    const step = createDoctorStep({
      runDoctor: async (o, p) => (rep = await realRunDoctor(o, p)),
      doctorDeps: deps,
    });
    const { io, lines } = makeIO();
    const result = await step.run(makeCtx(tempDir()), io);

    expect(rep).toBeDefined();
    const { ok, warn, fail } = rep!.summary;
    const ran = ok + warn + fail;
    expect(ran).toBeGreaterThan(0); // a real sweep always runs config checks → not the ran===0 branch
    expect(result.id).toBe('doctor');
    expect(result.status).toBe(fail > 0 || ran === 0 ? 'failed' : 'done');
    expect(result.detail).toBe(formatDoctorReport(rep!));
    expect(lines).toEqual(formatDoctorReport(rep!).split('\n'));
    expect(existsSync(commsPath)).toBe(false); // read-only sweep created no comms.db (no migration)
    expect(existsSync(secretsPath)).toBe(false); // read the relocated (absent) secrets, created none
  });

  it('returns failed (never throws) even when the runner rejects with a non-Error throwable', async () => {
    // The "never aborts the wizard" guarantee must hold for ANY throwable — a null-prototype object
    // makes String() itself throw, so the catch's stringify is defensively wrapped (codex r2 LOW).
    const step = createDoctorStep({ runDoctor: async () => { throw Object.create(null); } });
    const result = await step.run(makeCtx(tempDir()), makeIO().io);
    expect(result.status).toBe('failed');
    expect(result.summary).toContain('verification could not run');
    expect(result.detail).toBe('a non-Error value was thrown');
  });

  it('still returns the verified result when io.report throws — progress output is best-effort (gemini r3)', async () => {
    // A throwing reporter (e.g. broken stderr) must NOT be misattributed as "verification could not
    // run": verification succeeded, so the real result stands and the wizard is not aborted.
    const rep = report({ ok: 5 });
    const step = createDoctorStep({ runDoctor: async () => rep });
    const throwingIO: WizardIO = {
      prompter: new ScriptedPrompter([]),
      report: () => { throw new Error('stderr broken'); },
    };
    const result = await step.run(makeCtx(tempDir()), throwingIO);
    expect(result.status).toBe('done');
    expect(result.summary).toBe('setup verified — all 5 checks pass');
    expect(result.detail).toBe(formatDoctorReport(rep));
  });
});

/** Sorted `relative-path:size` list — proves no file was created, modified, or removed. */
function treeSnapshot(root: string): string[] {
  const walk = (dir: string, prefix: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const rel = join(prefix, entry.name);
      const abs = join(dir, entry.name);
      return entry.isDirectory() ? walk(abs, rel) : [`${rel}:${statSync(abs).size}`];
    });
  return walk(root, '').sort();
}
