import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createDoctorStep } from '../../src/wizard/doctor.js';
import { formatDoctorReport, type DoctorReport, type DoctorDeps } from '../../src/doctor.js';
import { ScriptedPrompter } from '../../src/wizard/prompt.js';
import type { WizardContext, WizardIO } from '../../src/wizard/step.js';
import { useTempResources } from '../helpers.js';

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
    // the full report is both reported (progress) and returned as detail
    expect(lines).toEqual([formatDoctorReport(rep)]);
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

  it('passes ctx.now and the homeDir-derived .heddle path into the doctor runner (behavioral wiring)', async () => {
    const home = tempDir();
    const spy = vi.fn(async (_opts: { provider?: string }, _partial: Partial<DoctorDeps>) => report({ ok: 1 }));
    const step = createDoctorStep({ runDoctor: spy });
    await step.run(makeCtx(home), makeIO().io);
    expect(spy).toHaveBeenCalledTimes(1);
    const [, partial] = spy.mock.calls[0];
    expect(partial.now?.()).toEqual(FIXED);
    expect(partial.paths?.heddle).toBe(join(home, '.heddle'));
  });

  it('returns failed (never throws) when the doctor runner rejects', async () => {
    const step = createDoctorStep({ runDoctor: async () => { throw new Error('probe exploded'); } });
    const result = await step.run(makeCtx(tempDir()), makeIO().io);
    expect(result.status).toBe('failed');
    expect(result.summary).toContain('verification could not run');
    expect(result.detail).toContain('probe exploded');
  });

  it('writes nothing — the finish step is read-only verification', async () => {
    const home = tempDir();
    mkdirSync(join(home, '.heddle'), { recursive: true });
    const before = treeSnapshot(home);
    const step = createDoctorStep({ runDoctor: async () => report({ ok: 2 }) });
    await step.run(makeCtx(home), makeIO().io);
    expect(treeSnapshot(home)).toEqual(before);
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
