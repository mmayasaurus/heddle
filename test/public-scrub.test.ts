import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

const allowlistPath = new URL('./public-scrub.allowlist.txt', import.meta.url);

// This scanner is a regression guard against accidental identity leaks.
// Deliberate encodings are out of scope.
// Reviewers remain responsible for detecting them.
const tenantPattern = new RegExp('spin' + 'ventory', 'i');
const placeholderPattern = new RegExp('\\b' + 'S' + 'PI-n\\b', 'i');
const issuePattern = new RegExp('\\b' + 'S' + 'PI-' + '\\d+', 'i');
const teamPattern = new RegExp('\\b' + 'S' + 'PI' + '(?:[-_][A-Za-z0-9]+)?\\b', 'i');
const personalNamePattern = new RegExp('\\b' + 'ma' + 'ya\\b', 'i');
const localUsernamePattern = new RegExp('\\b' + 'ma' + 'ya' + 'tobi\\b', 'i');
const companyPattern = new RegExp('vg' + 'fg', 'i');
const homePathPattern = new RegExp('/Users/' + 'ma' + 'ya' + '(?:tobi)?\\b', 'i');
const ownerPattern = new RegExp('mmaya' + 'saurus', 'i');

const forbiddenPatterns = [
  tenantPattern,
  placeholderPattern,
  issuePattern,
  teamPattern,
  personalNamePattern,
  localUsernamePattern,
  companyPattern,
  homePathPattern,
  ownerPattern,
  new RegExp('\\bsk-' + '[A-Za-z0-9]{8,}'),
  new RegExp('g' + 'sk_'),
  new RegExp('c' + 'sk-'),
  new RegExp('lin_' + 'api_'),
  new RegExp('lin_' + 'oauth_'),
  new RegExp('gh' + 'p_'),
  new RegExp('github_' + 'pat_'),
];

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
    'ls-files', '--', 'src', 'routing', 'skills', 'test', 'README.md', 'package.json',
    'vitest.config.ts', ':(glob)tsconfig*.json',
  ], { encoding: 'utf8' });

  return output.split('\n').filter(Boolean);
}

function digest(line: string): string {
  return createHash('sha256').update(line).digest('hex').slice(0, 12);
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

function matchesForbidden(line: string): boolean {
  return forbiddenPatterns.some((pattern) => pattern.test(line));
}

function scanFiles(files: Array<{ path: string; contents: string }>, allowed: Array<{ path: string; lineNumber: number; digest: string }>) {
  const flaggedEntries = new Set<string>();
  const offendingLines: string[] = [];

  for (const { path, contents } of files) {
    contents.split('\n').forEach((line, index) => {
      if (!matchesForbidden(line)) return;
      const entry = `${path}:${index + 1}`;
      const lineDigest = digest(line);
      const allowedEntry = allowed.find((candidate) => candidate.path === path && candidate.lineNumber === index + 1);
      if (allowedEntry?.digest === lineDigest) {
        flaggedEntries.add(`${entry}:${lineDigest}`);
      } else {
        offendingLines.push(`${entry}:${lineDigest}: ${line}`);
      }
    });
  }

  return {
    offendingLines,
    staleEntries: allowed
      .map(({ path, lineNumber, digest: entryDigest }) => ({ entry: `${path}:${lineNumber}:${entryDigest}`, path, lineNumber }))
      .filter(({ entry }) => !flaggedEntries.has(entry))
      .map(({ entry, path, lineNumber }) => {
        const line = files.find((file) => file.path === path)?.contents.split('\n')[lineNumber - 1];
        return line !== undefined && matchesForbidden(line) ? `stale allowlist entry ${path}:${lineNumber} (line changed)` : `${path}:${lineNumber}`;
      }),
  };
}

describe('public repository scrub', () => {
  it('catches private tenant and credential strings in shipped files', () => {
    const allowed = allowlist();
    const files = shippedFiles().map((path) => ({ path, contents: readFileSync(path, 'utf8') }));
    const { offendingLines, staleEntries } = scanFiles(files, allowed);

    expect(offendingLines, offendingLines.join('\n')).toEqual([]);
    expect(staleEntries, staleEntries.map((entry) => `stale allowlist entry ${entry}`).join('\n')).toEqual([]);
  });
});
