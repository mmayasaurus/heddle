import { describe, expect, it } from 'vitest';
import { parseRule } from '../../src/rules/schema.js';

const valid = { id: 'safe-search', event: 'PreToolUse', match: {}, action: 'nudge', enforce: false, subagent_aware: false, message: 'Use {{tool_name}}', fail_open: true };

describe('rule schema', () => {
  it('accepts a valid rule', () => expect(parseRule(valid, 'safe-search')).toMatchObject({ ok: true }));
  it('rejects fail_open false', () => expect(parseRule({ ...valid, fail_open: false }, 'safe-search')).toMatchObject({ ok: false }));
  it('rejects an unknown event', () => expect(parseRule({ ...valid, event: 'Unknown' }, 'safe-search')).toMatchObject({ ok: false }));
  it('rejects a bad action', () => expect(parseRule({ ...valid, action: 'warn' }, 'safe-search')).toMatchObject({ ok: false }));
  it('accepts PreToolUse block rules', () => expect(parseRule({ ...valid, action: 'block', enforce: true }, 'safe-search')).toMatchObject({ ok: true }));
  it('rejects Stop blocks pending a verified contract', () => {
    expect(parseRule({ ...valid, event: 'Stop', action: 'block' }, 'safe-search')).toMatchObject({ ok: false, error: expect.stringContaining('DEFERRED') });
  });
  it.each(['Stop', 'SubagentStop'])('defers %s rules pending the continuation-safe output contract', (event) => {
    expect(parseRule({ ...valid, event }, 'safe-search')).toMatchObject({ ok: false, error: expect.stringContaining('Stop/SubagentStop rules are deferred in v1 pending a doc-verified continuation-safe output contract (HED-403 follow-up)') });
  });
  it('rejects SessionStart blocks', () => expect(parseRule({ ...valid, event: 'SessionStart', action: 'block' }, 'safe-search')).toMatchObject({ ok: false }));
  it('rejects invalid input regexes at load time', () => expect(parseRule({ ...valid, match: { input: { command: '[' } } }, 'safe-search')).toMatchObject({ ok: false }));
});
