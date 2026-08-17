import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describeTaskClasses, isCodeEditingClass, listTaskClasses, loadRouting, resolveRoute } from '../src/routing.js';
import { withMandatoryPacks } from '../src/skillpacks.js';

const here = dirname(fileURLToPath(import.meta.url));
const table = loadRouting(join(here, '..', 'routing', 'routing.v0.yaml'));
const classes = listTaskClasses(table);
const codeEditing = ['deep-implementation', 'implementation', 'scaffold', 'bulk-mechanical'];

describe('routing.v0.yaml — shipped dispatch guidance', () => {
  it('gives every task class a non-empty explanation of why it routes there', () => {
    for (const taskClass of classes) expect(resolveRoute(table, taskClass).why, taskClass).toEqual(expect.any(String));
    for (const taskClass of classes) expect(resolveRoute(table, taskClass).why!.length, taskClass).toBeGreaterThan(0);
  });

  it('declares a skills array for every class and worker-role for every delegated class', () => {
    for (const taskClass of classes) {
      const skills = (table.taskClasses[taskClass] as { skills?: unknown }).skills;
      expect(Array.isArray(skills), taskClass).toBe(true);
      if (taskClass !== 'orchestration') expect(skills).toContain('worker-role');
    }
  });

  it('classifies exactly the four shipped code-editing task classes as editing code', () => {
    for (const taskClass of codeEditing) expect(isCodeEditingClass(table, taskClass), taskClass).toBe(true);
    for (const taskClass of classes.filter((taskClass) => !codeEditing.includes(taskClass))) {
      expect(isCodeEditingClass(table, taskClass), taskClass).toBe(false);
    }
  });

  it('does not classify unknown or direct routes as code-editing classes', () => {
    expect(isCodeEditingClass(table, 'no-such-class')).toBe(false);
    expect(isCodeEditingClass(table, 'direct:codex/gpt-5.6-luna')).toBe(false);
  });

  it('assigns quality-gate to every code-editing class in the shipped YAML', () => {
    for (const taskClass of codeEditing) {
      expect((table.taskClasses[taskClass] as { skills: string[] }).skills, taskClass).toContain('quality-gate');
    }
  });

  it('describes each class in routing order and exposes the complete implementation route details', () => {
    const descriptions = describeTaskClasses(table, withMandatoryPacks);
    expect(descriptions).toHaveLength(classes.length);
    expect(descriptions.map((row) => row.task_class)).toEqual(classes);
    expect(descriptions.find((row) => row.task_class === 'implementation')).toMatchObject({
      provider: 'claude', model: 'sonnet', execution: 'headless', effort: null,
      fallback: 'codex/gpt-5.6-terra', opt_in_required: false, edits_code: true,
      mcp: ['memtrace'], skills: ['worker-role', 'worker-hygiene', 'code-discovery', 'quality-gate'],
    });
    expect(descriptions.find((row) => row.task_class === 'implementation')!.why).toEqual(expect.any(String));
    expect(descriptions.find((row) => row.task_class === 'implementation')!.why!.length).toBeGreaterThan(0);
  });

  it('exposes opt-in, review-cost, and effort guidance for the relevant shipped classes', () => {
    const descriptions = describeTaskClasses(table, withMandatoryPacks);
    const hard = descriptions.find((row) => row.task_class === 'second-opinion-hard')!;
    const bulk = descriptions.find((row) => row.task_class === 'bulk-mechanical')!;
    expect(hard.opt_in_required).toBe(true);
    expect(hard.note).toContain('PR review');
    expect(hard.edits_code).toBe(false);
    expect(bulk.effort).toBe('low');
    expect(bulk.edits_code).toBe(true);
  });

  it('leaves raw skills unchanged without a union function and adds worker-role only to DISPATCHABLE classes', () => {
    const raw = describeTaskClasses(table).find((row) => row.task_class === 'documentation')!;
    const unioned = describeTaskClasses(table, withMandatoryPacks).find((row) => row.task_class === 'documentation')!;
    expect(raw.skills).toEqual(['worker-role']);
    expect(unioned.skills).toEqual(['worker-role', 'worker-hygiene']);
    // orchestration is dispatchable:false — never a worker, so no mandatory pack even with the union
    const orch = describeTaskClasses(table, withMandatoryPacks).find((row) => row.task_class === 'orchestration')!;
    expect(orch.dispatchable).toBe(false);
    expect(orch.skills).toEqual([]);
    expect(describeTaskClasses(table, withMandatoryPacks).filter((r) => r.task_class !== 'orchestration').every((r) => r.dispatchable && r.skills[0] === 'worker-role')).toBe(true);
  });
});
