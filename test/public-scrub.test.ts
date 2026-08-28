import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const allowlistPath = new URL('./public-scrub.allowlist.txt', import.meta.url);

const forbiddenPatterns = [
  new RegExp('Spin' + 'ventory'),
  new RegExp('spin' + 'ventory'),
  new RegExp('\\bSPI-' + '\\d+'),
  new RegExp('\\bMa' + 'ya\\b'),
  new RegExp('VG' + 'FG'),
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

function shippedFiles(): string[] {
  const output = execFileSync('git', [
    'ls-files', '--', 'src', 'routing', 'skills', 'test', 'README.md', 'package.json',
    'vitest.config.ts', ':(glob)tsconfig*.json',
  ], { encoding: 'utf8' });

  // PR #95 owns this remaining consumer-checkout reference; include it once that lands.
  return output.split('\n').filter((path) => path && path !== 'skills/quality-gate.md');
}

function allowlist(): Array<{ path: string; substring: string }> {
  return readFileSync(allowlistPath, 'utf8')
    .split('\n')
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const separator = line.indexOf(':');
      if (separator < 1) throw new Error(`Invalid public scrub allowlist entry: ${line}`);
      return { path: line.slice(0, separator), substring: line.slice(separator + 1) };
    });
}

describe('public repository scrub', () => {
  it('catches private tenant and credential strings in shipped files', () => {
    const allowed = allowlist();
    const offendingLines: string[] = [];

    for (const path of shippedFiles()) {
      const lines = readFileSync(path, 'utf8').split('\n');
      lines.forEach((line, index) => {
        const exempt = allowed.some((entry) => entry.path === path && line.includes(entry.substring));
        if (!exempt && forbiddenPatterns.some((pattern) => pattern.test(line))) {
          offendingLines.push(`${path}:${index + 1}: ${line}`);
        }
      });
    }

    expect(offendingLines, offendingLines.join('\n')).toEqual([]);
  });
});
