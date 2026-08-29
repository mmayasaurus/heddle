import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { discoverFixtures, runFixtureFile } from '../../src/rules/fixture.js';
import { useTempResources } from '../helpers.js';

const yaml = `id: fixture-rule\nevent: PreToolUse\nmatch:\n  tool: Bash\naction: nudge\nenforce: false\nsubagent_aware: false\nmessage: found {{tool_name}}\nfail_open: true\n`;
describe('rule fixtures', () => {
  const { tempDir } = useTempResources('heddle-rule-fixture-');
  it('reports both none and matching fixture cases', () => {
    const d = tempDir(); writeFileSync(join(d, 'fixture-rule.yaml'), yaml);
    const f = join(d, 'fixture-rule.jsonl'); writeFileSync(f, `${JSON.stringify({ name: 'none', payload: { hook_event_name: 'PreToolUse', tool_name: 'Read' }, expect: { outcome: 'none' } })}\n${JSON.stringify({ name: 'match', payload: { hook_event_name: 'PreToolUse', tool_name: 'Bash' }, expect: { outcome: 'nudge', stdout_includes: 'found Bash' } })}\n`);
    expect(runFixtureFile(d, 'fixture-rule', f)).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'none', pass: true }), expect.objectContaining({ name: 'match', pass: true })]));
  });
  it('returns a failed result rather than throwing when a fixture payload is invalid', () => {
    const d = tempDir(); writeFileSync(join(d, 'fixture-rule.yaml'), yaml); const f = join(d, 'bad.jsonl'); writeFileSync(f, JSON.stringify({ name: 'bad payload', payload: null, expect: { outcome: 'none' } }));
    expect(runFixtureFile(d, 'fixture-rule', f)).toEqual([expect.objectContaining({ name: 'bad payload', pass: false })]);
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
