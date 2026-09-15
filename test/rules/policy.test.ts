import { describe, expect, it } from 'vitest';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyPolicy, loadRulesPolicy, type RulesPolicy } from '../../src/rules/policy.js';
import { parseRule, type Rule } from '../../src/rules/schema.js';
import { useTempResources } from '../helpers.js';

function rule(id: string, enforce: boolean): Rule {
  const parsed = parseRule({
    id,
    event: 'PreToolUse',
    match: {},
    action: 'block',
    enforce,
    subagent_aware: false,
    message: id,
    fail_open: true,
  }, id);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.rule;
}

function policy(rules: RulesPolicy['rules']): RulesPolicy {
  return { schemaVersion: 1, rules };
}

describe('applyPolicy', () => {
  it('downgrades catalog enforcement when the selected policy rule is not enforced', () => {
    expect(applyPolicy([rule('sample-block', true)], policy([{ id: 'sample-block', enforce: false }]))[0]?.enforce).toBe(false);
  });

  it('downgrades an unselected catalog rule without removing it', () => {
    const source = rule('sample-block', true);
    const result = applyPolicy([source], policy([]));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 'sample-block', enforce: false });
  });

  it('preserves enforcement selected by both catalog and policy', () => {
    expect(applyPolicy([rule('sample-block', true)], policy([{ id: 'sample-block', enforce: true }]))[0]?.enforce).toBe(true);
  });

  it('caps a policy up-dial when catalog enforcement is false', () => {
    expect(applyPolicy([rule('sample-block', false)], policy([{ id: 'sample-block', enforce: true }]))[0]?.enforce).toBe(false);
  });

  it('preserves catalog order and does not mutate source rules', () => {
    const source = [rule('first-rule', true), rule('second-rule', true)];
    const result = applyPolicy(source, policy([{ id: 'second-rule', enforce: true }]));
    expect(result.map(({ id }) => id)).toEqual(['first-rule', 'second-rule']);
    expect(result.map(({ enforce }) => enforce)).toEqual([false, true]);
    expect(source.map(({ enforce }) => enforce)).toEqual([true, true]);
  });
});

describe('loadRulesPolicy', () => {
  const { tempDir } = useTempResources('heddle-policy-');

  // tempDir() is a mkdtemp 0700 dir; a 0600 file inside it satisfies secureReadFile (owner-only file,
  // non-group/other-writable parent), so this writes a policy the secure read path will actually accept.
  function writePolicyFile(body: string, mode = 0o600): string {
    const path = join(tempDir(), 'rules.json');
    writeFileSync(path, body, { mode });
    return path;
  }

  it('reports a securely-readable v1 policy', () => {
    const path = writePolicyFile(JSON.stringify({ schemaVersion: 1, rules: [{ id: 'sample-block', enforce: false }] }));
    const result = loadRulesPolicy(path);
    expect(result.policy?.rules).toEqual([{ id: 'sample-block', enforce: false }]);
    expect(result.warning).toBeUndefined();
    expect(result.absent).toBeUndefined();
  });

  it('fails open SILENTLY (absent, no warning) when no policy file exists', () => {
    // R convergence item 1: an ABSENT policy is the normal "operator never configured one" case — fall back
    // to catalog enforcement WITHOUT a warning (a warning would cry wolf on every per-tool-call hook run).
    // secureReadFile bubbles ENOENT unchanged; we map exactly that code to { absent: true }.
    const result = loadRulesPolicy(join(tempDir(), 'rules.json')); // never created
    expect(result.absent).toBe(true);
    expect(result.warning).toBeUndefined();
    expect(result.policy).toBeUndefined();
  });

  it('fails open LOUDLY for invalid JSON WITHOUT echoing the file content (no log/terminal injection)', () => {
    // The invalid-JSON warning must name the PATH but never the file CONTENT: JSON.parse's message echoes a
    // snippet of the raw bytes, so a same-uid-planted policy could inject terminal escapes / spoofed text
    // into the hook's stderr (PR #237 qodo HIGH). The content starts at char 0 with a distinctive marker, so
    // any parser snippet would carry it — this FAILS if the fix is reverted to interpolate the parser detail.
    const marker = 'INJECT3D_MARKER_ZZZ';
    const path = writePolicyFile(`${marker} not json`);
    const result = loadRulesPolicy(path);
    expect(result.warning).toContain(path);
    expect(result.warning).toContain('not valid JSON');
    expect(result.warning).not.toContain('INJECT3D'); // raw file content must not reach the warning/stderr
    expect(result.policy).toBeUndefined();
    expect(result.absent).toBeUndefined();
  });

  it('fails open LOUDLY for a non-v1 policy object', () => {
    const path = writePolicyFile(JSON.stringify({ schemaVersion: 2, rules: [] }));
    const result = loadRulesPolicy(path);
    expect(result.warning).toContain(path);
    expect(result.warning).toContain('not a valid v1 policy');
    expect(result.policy).toBeUndefined();
  });

  it('fails open LOUDLY when the policy file is group/other-readable (secure-fs refuses it)', () => {
    // R convergence item 2: the policy is read via secure-fs secureReadFile, so a rules.json that is NOT
    // owner-only (chmod'd to 0644 here, umask-independent) is REFUSED — the hook warns + falls back to
    // catalog. This is the ONLY test that fails if the read path is reverted to a bare readFileSync, so it
    // is what pins the operator-domain (owner-only, no-symlink, TOCTOU-safe) read contract.
    const path = writePolicyFile(JSON.stringify({ schemaVersion: 1, rules: [] }));
    chmodSync(path, 0o644);
    const result = loadRulesPolicy(path);
    expect(result.warning).toContain(path);
    expect(result.warning).toContain('could not be securely read');
    expect(result.policy).toBeUndefined();
  });

  it('fails open (never hangs) on a non-regular policy file', () => {
    // /dev/zero is an endless char device — a bare readFileSync would read forever. secureReadFile opens it
    // O_NOFOLLOW and rejects it at the fstat-on-the-fd isFile() check (secure-fs.ts) BEFORE any read, so we
    // get a fast warning + catalog fallback, never a hang (vitest would otherwise time out).
    const result = loadRulesPolicy('/dev/zero');
    expect(result.warning).toBeDefined();
    expect(result.policy).toBeUndefined();
  });
});
