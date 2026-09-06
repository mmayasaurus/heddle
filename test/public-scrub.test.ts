import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { credentialPatterns, digest, identityPatterns, matchesForbidden, scanFiles } from '../src/release/scrub.js';

const allowlistPath = new URL('./public-scrub.allowlist.txt', import.meta.url);

const placeholderPattern = identityPatterns[1];

describe('regression PR#99 — public scrub rejects placeholder issue keys and exact-line exemptions', () => {
  it('matches forbidden identity fragments while retaining boundary-safe allowed examples', () => {
    const ownerUrl = 'github.com:' + 'ma' + 'ya/heddle';
    const personalDecision = 'ma' + 'ya decided';
    const uppercasePersonal = 'MA' + 'YA';
    const homePath = '/Users/' + 'ma' + 'ya' + '/dev/x';
    const lowercaseHomePath = '/users/' + 'ma' + 'ya' + 'tobi';
    const lowercaseTeam = 's' + 'pi';
    const placeholderIssue = 'S' + 'PI' + '-n';
    const numberedIssue = 'S' + 'PI' + '-712';
    const owner = 'M' + 'ma' + 'ya' + 'saurus';
    const uppercaseTenant = 'SPIN' + 'VENTORY';
    const mixedTenant = 'Vg' + 'Fg';
    const mayan = 'Ma' + 'yan';
    const localUsername = 'ma' + 'ya' + 'tobi';
    const underscoredIssue = 'S' + 'PI_712';
    const underscoredTeam = 'S' + 'PI_TEAM';
    const namedIssue = 'S' + 'PI-foo';
    const spider = 'spider';
    const spin = 'SPIN';
    const otherIssue = 'ACM-123';
    const genericPlaceholder = '<TEAM>-n';
    const otherHome = '/home/user/dev/acme-app';

    expect(matchesForbidden(ownerUrl)).toBe(true);
    expect(matchesForbidden(personalDecision)).toBe(true);
    expect(matchesForbidden(uppercasePersonal)).toBe(true);
    expect(matchesForbidden(homePath)).toBe(true);
    expect(matchesForbidden(lowercaseHomePath)).toBe(true);
    expect(matchesForbidden(lowercaseTeam)).toBe(true);
    expect(matchesForbidden(numberedIssue)).toBe(true);
    expect(matchesForbidden(placeholderIssue)).toBe(true);
    expect(matchesForbidden(owner)).toBe(true);
    expect(matchesForbidden(uppercaseTenant)).toBe(true);
    expect(matchesForbidden(mixedTenant)).toBe(true);
    expect(matchesForbidden(mayan)).toBe(false);
    expect(matchesForbidden(localUsername)).toBe(true);
    expect(matchesForbidden(underscoredIssue)).toBe(true);
    expect(matchesForbidden(underscoredTeam)).toBe(true);
    expect(matchesForbidden(namedIssue)).toBe(true);
    expect(matchesForbidden(spider)).toBe(false);
    expect(matchesForbidden(spin)).toBe(false);
    expect(matchesForbidden(otherIssue)).toBe(false);
    expect(matchesForbidden(genericPlaceholder)).toBe(false);
    expect(matchesForbidden(otherHome)).toBe(false);
    expect(placeholderPattern.test(placeholderIssue)).toBe(true);
  });

  it('rejects malformed allowlist entries with their line number', () => {
    expect(() => parseAllowlist('src/cli.ts:')).toThrow('line 1');
    expect(() => parseAllowlist('src/cli.ts: ')).toThrow('line 1');
    expect(() => parseAllowlist('src/cli.ts:abc')).toThrow('line 1');
    expect(() => parseAllowlist('src/cli.ts')).toThrow('line 1');
    expect(() => parseAllowlist('src/cli.ts:1:not-a-digest')).toThrow('line 1');
  });

  it('reports stale allowlist entries and exempts only their exact line', () => {
    const flagged = 'S' + 'PI';
    const files = [{ path: 'src/example.ts', contents: `${flagged}\nclean` }];

    expect(scanFiles(files, parseAllowlist('src/example.ts:1:60c5158ae188'))).toEqual({ offendingLines: [], staleEntries: [] });
    expect(scanFiles(files, parseAllowlist('src/example.ts:2:60c5158ae188'))).toEqual({
      offendingLines: ['src/example.ts:1:60c5158ae188: ' + flagged],
      staleEntries: ['src/example.ts:2'],
    });
  });

  it('does not let an exemption cover a newly inserted forbidden line', () => {
    const flagged = 'S' + 'PI';
    const files = [{ path: 'src/example.ts', contents: `${flagged}\n${flagged}` }];

    expect(scanFiles(files, parseAllowlist('src/example.ts:1:60c5158ae188'))).toEqual({
      offendingLines: [`src/example.ts:2:60c5158ae188: ${flagged}`],
      staleEntries: [],
    });
  });

  it('reports a changed allowlisted line as stale', () => {
    const flagged = 'S' + 'PI';
    const files = [{ path: 'src/example.ts', contents: `${flagged}_712` }];

    expect(scanFiles(files, parseAllowlist('src/example.ts:1:60c5158ae188'))).toEqual({
      offendingLines: [`src/example.ts:1:211703648620: ${flagged}_712`],
      staleEntries: ['stale allowlist entry src/example.ts:1 (line changed)'],
    });
  });

  it('catches segmented credential shapes and never echoes them', () => {
    const projKey = 'sk-' + 'proj-' + 'abc123def456';
    const antKey = 'sk-' + 'ant-' + 'api03xyz789aa';
    expect(matchesForbidden(projKey)).toBe(true);
    expect(matchesForbidden(antKey)).toBe(true);
    expect(matchesForbidden('sk-fix')).toBe(false);
    expect(matchesForbidden('an sk-and-so aside')).toBe(false);
    const groqKey = 'g' + 'sk_' + 'abc123def456ghi789';
    expect(matchesForbidden(groqKey)).toBe(true);
    expect(matchesForbidden('the g' + 'sk_ prefix documents the shape')).toBe(false);
    expect(matchesForbidden('shape: c' + 'sk-…')).toBe(false);
    const scanned = scanFiles([{ path: 'src/example.ts', contents: projKey }], []);
    expect(scanned.offendingLines).toEqual([
      `src/example.ts:1:${digest(projKey)}: [credential-shaped content redacted]`,
    ]);
    expect(scanned.offendingLines.join('\n')).not.toContain(projKey);
  });

  it('matches credential tails at the 12-character boundary', () => {
    const twelveCharacterTail = 'abc123def456';
    const elevenCharacterTail = 'abc123def45';
    const prefixes = [
      'g' + 'sk_',
      'c' + 'sk-',
      'lin_' + 'api_',
      'lin_' + 'oauth_',
      'gh' + 'p_',
      'github_' + 'pat_',
    ];

    // Fragments shorter than 12 are documentation-scope by design; a real GitHub fine-grained PAT
    // (`github_pat_` + 11 + `_` + 82) still matches because `_` is in its tail class.
    for (const prefix of prefixes) {
      expect(matchesForbidden(prefix + twelveCharacterTail)).toBe(true);
      expect(matchesForbidden(prefix + elevenCharacterTail)).toBe(false);
    }
    expect(matchesForbidden('github_' + 'pat_' + elevenCharacterTail + '_' + 'a'.repeat(82))).toBe(true);
  });

  it('flags a shipped path whose NAME carries a forbidden identifier', () => {
    const badPath = 'test/' + 'spin' + 'ventory' + '-fixture.txt';
    const scanned = scanFiles([{ path: badPath, contents: 'clean contents' }], []);
    expect(scanned.offendingLines).toEqual([`${badPath}: [path name carries a forbidden identifier]`]);
    expect(scanFiles([{ path: 'test/acme-fixture.txt', contents: 'clean contents' }], []).offendingLines).toEqual([]);
  });

  it('scans the allowlist and its comments', () => {
    expect(shippedFiles()).toContain('test/public-scrub.allowlist.txt');
    const tenantComment = '# ' + 'spin' + 'ventory';
    expect(scanFiles([{ path: 'test/public-scrub.allowlist.txt', contents: tenantComment }], [])).toEqual({
      offendingLines: [`test/public-scrub.allowlist.txt:1:${digest(tenantComment)}: ${tenantComment}`],
      staleEntries: [],
    });
  });
});

function shippedFiles(): string[] {
  const output = execFileSync('git', [
    'ls-files', '--', 'src', 'routing', 'skills', 'test', 'docs', ':(exclude)docs/fleet/**', 'README.md', 'package.json',
    'vitest.config.ts', ':(glob)tsconfig*.json',
  ], { encoding: 'utf8' });

  return output.split('\n').filter(Boolean);
}

function parseAllowlist(contents: string): Array<{ path: string; lineNumber: number; digest: string }> {
  return contents
    .split('\n')
    .map((line, index) => ({ line, lineNumber: index + 1 }))
    .filter(({ line }) => line && !line.startsWith('#'))
    .map(({ line, lineNumber }) => {
      const match = /^(.*):([1-9]\d*):([a-f0-9]{12})$/.exec(line);
      if (!match || !match[1]) {
        throw new Error(`Invalid public scrub allowlist entry at line ${lineNumber}: ${line}`);
      }
      return { path: match[1], lineNumber: Number(match[2]), digest: match[3] };
    });
}

function allowlist(): Array<{ path: string; lineNumber: number; digest: string }> {
  return parseAllowlist(readFileSync(allowlistPath, 'utf8'));
}

describe('public repository scrub', () => {
  it('ships the specification while excluding fleet operations documentation', () => {
    expect(shippedFiles()).toContain('docs/SPEC.md');
    expect(shippedFiles()).not.toContain('docs/fleet/DASHBOARD.md');
  });

  it('catches private tenant and credential strings in shipped files', () => {
    const allowed = allowlist();
    const files = shippedFiles()
      .map((path) => ({ path, contents: readFileSync(path, 'utf8') }));
    const { offendingLines, staleEntries } = scanFiles(files, allowed);

    expect(offendingLines, offendingLines.join('\n')).toEqual([]);
    expect(staleEntries, staleEntries.map((entry) => `stale allowlist entry ${entry}`).join('\n')).toEqual([]);
  });
});
