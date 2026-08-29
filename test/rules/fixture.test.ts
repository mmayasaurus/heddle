import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { discoverFixtures, runFixtureFile } from '../../src/rules/fixture.js';
import * as render from '../../src/rules/render.js';
import { useTempResources } from '../helpers.js';

const yaml = `id: fixture-rule\nevent: PreToolUse\nmatch:\n  tool: Bash\naction: nudge\nenforce: false\nsubagent_aware: false\nmessage: found {{tool_name}}\nfail_open: true\n`;
describe('rule fixtures', () => {
  const { tempDir } = useTempResources('heddle-rule-fixture-');
  it('reports both none and matching fixture cases', () => {
    const d = tempDir(); writeFileSync(join(d, 'fixture-rule.yaml'), yaml);
    const f = join(d, 'fixture-rule.jsonl'); writeFileSync(f, `${JSON.stringify({ name: 'none', payload: { hook_event_name: 'PreToolUse', tool_name: 'Read' }, expect: { outcome: 'none' } })}\n${JSON.stringify({ name: 'match', payload: { hook_event_name: 'PreToolUse', tool_name: 'Bash' }, expect: { outcome: 'nudge', stdout_includes: 'found Bash' } })}\n`);
    expect(runFixtureFile(d, 'fixture-rule', f)).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'none', pass: true }), expect.objectContaining({ name: 'match', pass: true })]));
  });
  it('treats HEDDLE_WORKER=0 as an orchestrator in fixture environments', () => {
    const d = tempDir();
    writeFileSync(join(d, 'fixture-rule.yaml'), yaml.replace('  tool: Bash', '  agent_role: orchestrator'));
    const f = join(d, 'orchestrator.jsonl');
    writeFileSync(f, JSON.stringify({ name: 'orchestrator', payload: { hook_event_name: 'PreToolUse' }, env: { HEDDLE_WORKER: '0' }, expect: { outcome: 'nudge', stdout_includes: 'found' } }));
    expect(runFixtureFile(d, 'fixture-rule', f)).toEqual([expect.objectContaining({ name: 'orchestrator', pass: true })]);
  });
  it('returns a failed result rather than throwing when a fixture payload is invalid', () => {
    const d = tempDir(); writeFileSync(join(d, 'fixture-rule.yaml'), yaml); const f = join(d, 'bad.jsonl'); writeFileSync(f, JSON.stringify({ name: 'bad payload', payload: null, expect: { outcome: 'none' } }));
    expect(runFixtureFile(d, 'fixture-rule', f)).toEqual([expect.objectContaining({ name: 'bad payload', pass: false })]);
  });
  it('fails a fixture when rendering returns an unexpected permission decision', () => {
    const d = tempDir(); writeFileSync(join(d, 'fixture-rule.yaml'), yaml); const f = join(d, 'allow.jsonl');
    writeFileSync(f, JSON.stringify({ name: 'unexpected allow', payload: { hook_event_name: 'PreToolUse', tool_name: 'Bash' }, expect: { outcome: 'nudge' } }));
    const spy = vi.spyOn(render, 'renderMatches').mockReturnValue('{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}');
    expect(runFixtureFile(d, 'fixture-rule', f)).toEqual([expect.objectContaining({ name: 'unexpected allow', pass: false, message: 'expected nudge, got unexpected:allow' })]);
    spy.mockRestore();
  });
  it('discovers JSONL fixtures by rule id', () => {
    const d = tempDir(); const fixtures = join(d, 'fixtures');
    mkdirSync(fixtures); writeFileSync(join(d, 'fixture-rule.yaml'), yaml); writeFileSync(join(fixtures, 'fixture-rule.jsonl'), ''); writeFileSync(join(fixtures, 'missing.jsonl'), '');
    expect(discoverFixtures(d, fixtures)).toEqual([
      { ruleId: 'fixture-rule', fixturePath: join(fixtures, 'fixture-rule.jsonl') },
      { ruleId: 'missing', fixturePath: join(fixtures, 'missing.jsonl') },
    ]);
  });
});
