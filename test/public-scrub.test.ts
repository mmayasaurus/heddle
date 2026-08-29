import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const allowlistPath = new URL('./public-scrub.allowlist.txt', import.meta.url);

const forbiddenPatterns = [
  new RegExp('spin' + 'ventory', 'i'),
  new RegExp('\\b' + 'S' + 'PI-n\\b'),
  new RegExp('\\b' + 'S' + 'PI-' + '\\d+'),
  new RegExp('\\b' + 'S' + 'PI\\b'),
  new RegExp('\\bMa' + 'ya\\b'),
  new RegExp('vg' + 'fg', 'i'),
  new RegExp('/Users/' + 'mayatobi'),
  new RegExp('mmaya' + 'saurus'),
  new RegExp('\\bsk-' + '[A-Za-z0-9]{8,}'),
  new RegExp('g' + 'sk_'),
  new RegExp('c' + 'sk-'),
  new RegExp('lin_' + 'api_'),
  new RegExp('lin_' + 'oauth_'),
  new RegExp('gh' + 'p_'),
  new RegExp('github_' + 'pat_'),
];

describe('regression PR#99 — public scrub rejects placeholder issue keys and empty exemptions', () => {
  it('matches forbidden identity fragments while retaining boundary-safe allowed examples', () => {
    const placeholderIssue = 'S' + 'PI' + '-n';
    const bareTeam = 'S' + 'PI';
    const uppercaseTenant = 'SPIN' + 'VENTORY';
    const mixedTenant = 'Vg' + 'Fg';
    const allowed = ['Ma' + 'yan', 'maya' + 'tobi', 'A' + 'S' + 'PI', 'S' + 'PIKE', 'normal text'];

    expect([placeholderIssue, bareTeam, uppercaseTenant, mixedTenant].every(matchesForbidden)).toBe(true);
    expect(allowed.some(matchesForbidden)).toBe(false);
  });

  it('rejects allowlist entries with an empty substring', () => {
    expect(() => parseAllowlist('src/cli.ts:')).toThrow('line 1');
  });
});

function shippedFiles(): string[] {
  const output = execFileSync('git', [
    'ls-files', '--', 'src', 'routing', 'skills', 'test', 'README.md', 'package.json',
    'vitest.config.ts', ':(glob)tsconfig*.json',
  ], { encoding: 'utf8' });

  // Remaining tenant strings are the HED-389 gate map, allowlisted pending HED-439.
  return output.split('\n').filter((path) => path && path !== 'test/public-scrub.allowlist.txt');
}

function parseAllowlist(contents: string): Array<{ path: string; substring: string }> {
  return contents
    .split('\n')
    .map((line, index) => ({ line, lineNumber: index + 1 }))
    .filter(({ line }) => line && !line.startsWith('#'))
    .map(({ line, lineNumber }) => {
      const separator = line.indexOf(':');
      const substring = line.slice(separator + 1);
      if (separator < 1 || !substring) {
        throw new Error(`Invalid public scrub allowlist entry at line ${lineNumber}: ${line}`);
      }
      return { path: line.slice(0, separator), substring };
    });
}

function allowlist(): Array<{ path: string; substring: string }> {
  return parseAllowlist(readFileSync(allowlistPath, 'utf8'));
}

function matchesForbidden(line: string): boolean {
  return forbiddenPatterns.some((pattern) => pattern.test(line));
}

describe('public repository scrub', () => {
  it('catches private tenant and credential strings in shipped files', () => {
    const allowed = allowlist();
    const offendingLines: string[] = [];

    for (const path of shippedFiles()) {
      const lines = readFileSync(path, 'utf8').split('\n');
      lines.forEach((line, index) => {
        const exempt = allowed.some((entry) => entry.path === path && line.includes(entry.substring));
        if (!exempt && matchesForbidden(line)) {
          offendingLines.push(`${path}:${index + 1}: ${line}`);
        }
      });
    }

    expect(offendingLines, offendingLines.join('\n')).toEqual([]);
  });
});
