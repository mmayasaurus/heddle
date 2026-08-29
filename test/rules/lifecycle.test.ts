import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadRules } from '../../src/rules/load.js';
import { useTempResources } from '../helpers.js';
import { ensureBuilt, runCli } from '../helpers/cli.js';

const ruleYaml = (id: string, provenance: string | null = 'HED-403') => `id: ${id}\nevent: PreToolUse\nmatch:\n  tool: Bash\naction: nudge\nenforce: false\nsubagent_aware: false\nmessage: avoid destructive commands\nfail_open: true\n${provenance === null ? '' : `provenance: ${provenance}\n`}`;

function passingFixture(): string {
  return `${JSON.stringify({ name: 'matching Bash command', payload: { hook_event_name: 'PreToolUse', tool_name: 'Bash' }, expect: { outcome: 'nudge', stdout_includes: 'avoid destructive commands' } })}\n`;
}

function seedRuleRoot(root: string, id = 'sample-rule', options: { fixture?: 'passing' | 'failing' | 'empty' | 'comment-only' | 'none'; provenance?: string | null; active?: boolean; proposed?: boolean } = {}): void {
  const { fixture = 'passing', provenance = 'HED-403', active = false, proposed = false } = options;
  mkdirSync(join(root, 'tests'), { recursive: true });
  if (active) writeFileSync(join(root, `${id}.yaml`), ruleYaml(id, provenance));
  if (proposed) {
    mkdirSync(join(root, 'proposed'), { recursive: true });
    writeFileSync(join(root, 'proposed', `${id}.yaml`), ruleYaml(id, provenance));
  }
  if (fixture !== 'none') writeFileSync(join(root, 'tests', `${id}.jsonl`), fixture === 'passing' ? passingFixture() : fixture === 'empty' ? ' \n\n' : fixture === 'comment-only' ? '# not a case\n' : `${JSON.stringify({ name: 'red fixture', payload: { hook_event_name: 'PreToolUse', tool_name: 'Bash' }, expect: { outcome: 'none' } })}\n`);
}

function candidatePath(root: string): string {
  const incoming = join(root, 'incoming');
  mkdirSync(incoming, { recursive: true });
  return join(incoming, 'candidate.yaml');
}

describe('heddle rule lifecycle CLI', () => {
  const { tempDir } = useTempResources('heddle-rule-lifecycle-');

  beforeAll(async () => { await ensureBuilt(); }, 120_000);

  it('proposes a valid, fixture-backed rule without making it active', async () => {
    const root = tempDir(); const source = candidatePath(root);
    seedRuleRoot(root, 'candidate'); writeFileSync(source, ruleYaml('candidate'));

    const result = await runCli(['rule', 'propose', source, '--rules', root]);

    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(existsSync(join(root, 'proposed', 'candidate.yaml'))).toBe(true);
    expect(existsSync(join(root, 'candidate.yaml'))).toBe(false);
  }, 30_000);

  it.each([
    ['has no fixture', { fixture: 'none' as const, provenance: 'HED-403' }],
    ['has an empty fixture', { fixture: 'empty' as const, provenance: 'HED-403' }],
    ['has a comment-only fixture', { fixture: 'comment-only' as const, provenance: 'HED-403' }],
    ['has missing provenance', { fixture: 'passing' as const, provenance: null }],
  ])('refuses propose when the candidate %s', async (_description, options) => {
    const root = tempDir(); const source = candidatePath(root);
    seedRuleRoot(root, 'candidate', options); writeFileSync(source, ruleYaml('candidate', options.provenance));
    const result = await runCli(['rule', 'propose', source, '--rules', root]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('refusing');
    expect(existsSync(join(root, 'proposed', 'candidate.yaml'))).toBe(false);
  }, 30_000);

  it.each(['active', 'proposed'] as const)('refuses propose on an existing %s id', async (state) => {
    const root = tempDir(); const source = candidatePath(root);
    seedRuleRoot(root, 'candidate', { [state]: true }); writeFileSync(source, ruleYaml('candidate'));
    const result = await runCli(['rule', 'propose', source, '--rules', root]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('already exists');
  }, 30_000);

  it('refuses a worker ratification and leaves the proposed file inert', async () => {
    const root = tempDir(); seedRuleRoot(root, 'sample-rule', { proposed: true });
    const result = await runCli(['rule', 'ratify', 'sample-rule', '--rules', root], { env: { HEDDLE_WORKER: '1' } });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('worker');
    expect(existsSync(join(root, 'proposed', 'sample-rule.yaml'))).toBe(true);
    expect(existsSync(join(root, 'sample-rule.yaml'))).toBe(false);
  }, 30_000);

  it('refuses red fixtures and leaves the proposed rule inert', async () => {
    const root = tempDir(); seedRuleRoot(root, 'sample-rule', { proposed: true, fixture: 'failing' });
    const result = await runCli(['rule', 'ratify', 'sample-rule', '--rules', root]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('fixture');
    expect(result.stderr).toContain('red fixture');
    expect(existsSync(join(root, 'proposed', 'sample-rule.yaml'))).toBe(true);
  }, 30_000);

  it('refuses an empty fixture and leaves the proposed rule inert', async () => {
    const root = tempDir(); seedRuleRoot(root, 'sample-rule', { proposed: true, fixture: 'empty' });
    const result = await runCli(['rule', 'ratify', 'sample-rule', '--rules', root]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('fixture has no cases');
    expect(existsSync(join(root, 'proposed', 'sample-rule.yaml'))).toBe(true);
    expect(existsSync(join(root, 'sample-rule.yaml'))).toBe(false);
  }, 30_000);

  it('refuses an invalid rule id before it can escape the rules root', async () => {
    const root = tempDir();
    const result = await runCli(['rule', 'ratify', '../evil', '--rules', root]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('invalid rule id');
    expect(existsSync(join(root, '..', 'evil.yaml'))).toBe(false);
    expect(existsSync(join(root, 'proposed', '..', 'evil.yaml'))).toBe(false);
  }, 30_000);

  it('ratifies only after its fixture passes, which makes the rule loadable', async () => {
    const root = tempDir(); seedRuleRoot(root, 'sample-rule', { proposed: true });
    expect(loadRules(root).map((rule) => rule.id)).not.toContain('sample-rule');
    const result = await runCli(['rule', 'ratify', 'sample-rule', '--rules', root]);
    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(existsSync(join(root, 'proposed', 'sample-rule.yaml'))).toBe(false);
    expect(loadRules(root).map((rule) => rule.id)).toContain('sample-rule');
    expect(parseYaml(readFileSync(join(root, 'sample-rule.yaml'), 'utf8'))).toMatchObject({ since: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
  }, 30_000);

  it('preserves comments while stamping since during ratification', async () => {
    const root = tempDir(); seedRuleRoot(root, 'sample-rule', { proposed: true });
    const proposed = join(root, 'proposed', 'sample-rule.yaml');
    writeFileSync(proposed, `# keep me\n${ruleYaml('sample-rule')}`);
    const result = await runCli(['rule', 'ratify', 'sample-rule', '--rules', root]);
    const active = readFileSync(join(root, 'sample-rule.yaml'), 'utf8');
    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(active).toContain('# keep me');
    expect(active).toMatch(/^since:/m);
  }, 30_000);

  it('refuses ratification if an active rule already owns the id', async () => {
    const root = tempDir(); seedRuleRoot(root, 'sample-rule', { active: true, proposed: true });
    const result = await runCli(['rule', 'ratify', 'sample-rule', '--rules', root]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('already exists');
    expect(existsSync(join(root, 'proposed', 'sample-rule.yaml'))).toBe(true);
  }, 30_000);

  it('lists active and proposed rules with their state and active age', async () => {
    const root = tempDir(); seedRuleRoot(root, 'active-rule', { active: true }); seedRuleRoot(root, 'proposed-rule', { proposed: true });
    writeFileSync(join(root, 'active-rule.yaml'), `${ruleYaml('active-rule')}since: 2020-01-01\n`);
    const result = await runCli(['rule', 'list', '--json', '--rules', root]);
    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(result.stdout)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'active-rule', state: 'active', 'age-days': expect.any(Number) }),
      expect.objectContaining({ id: 'proposed-rule', state: 'proposed', 'age-days': '' }),
    ]));
  }, 30_000);

  it.each([
    ['passing', 'passing' as const, 0],
    ['failing', 'failing' as const, 1],
    ['empty', 'empty' as const, 1],
  ])('returns the fixture outcome from rule test for a %s rule', async (_description, fixture, expectedCode) => {
    const root = tempDir(); seedRuleRoot(root, 'sample-rule', { active: true, fixture });
    const result = await runCli(['rule', 'test', 'sample-rule', '--rules', root]);
    expect(result.code).toBe(expectedCode);
    expect(result.stdout).toContain(fixture === 'passing' ? 'passed' : 'FAILED');
  }, 30_000);
});
