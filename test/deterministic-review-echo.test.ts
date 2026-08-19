import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { useTempResources } from './helpers.js';

const workflow = readFileSync(
  join(process.cwd(), '.github/workflows/deterministic-review.yml'),
  'utf8',
);

function jobBlock(job: string): string {
  const startMarker = `  ${job}:\n`;
  const start = workflow.indexOf(startMarker);
  if (start < 0) throw new Error(`workflow job ${job} was not found`);
  const nextJob = workflow.slice(start + startMarker.length).search(/^  [a-z0-9-]+:\n/m);
  return nextJob < 0
    ? workflow.slice(start)
    : workflow.slice(start, start + startMarker.length + nextJob);
}

function verdictShell(job: string): string {
  const block = jobBlock(job);
  const step = block.indexOf('      - name: Verdict (commit) or echo (edit)\n');
  if (step < 0) throw new Error(`workflow job ${job} has no verdict/echo step`);
  const run = block.indexOf('        run: |\n', step);
  if (run < 0) throw new Error(`workflow job ${job} has no verdict/echo shell`);
  const lines = block.slice(run + '        run: |\n'.length).split('\n');
  const shell: string[] = [];
  for (const line of lines) {
    if (!line.startsWith('          ') && line !== '') break;
    shell.push(line.startsWith('          ') ? line.slice(10) : line);
  }
  return `${shell.join('\n')}\n`;
}

describe('regression HED-131 — scanner edit echoes fail closed', () => {
  const { tempDir } = useTempResources('heddle-det-review-echo-');

  for (const scanner of ['semgrep', 'gitleaks']) {
    it(`${scanner} isolates the container scan from the plain-runner verdict`, () => {
      const scan = jobBlock(`${scanner}-scan`);
      const verdict = jobBlock(scanner);

      expect(scan).toContain('    container:');
      expect(scan).not.toContain('      checks: write');
      expect(verdict).toContain(`    needs: [${scanner}-scan]`);
      expect(verdict).toContain('      checks: write');
      expect(verdict).not.toContain('    container:');
      expect(verdict).not.toContain('actions/checkout');
      expect(verdict).not.toMatch(/\b(?:python|wget|sed)\b/);
    });

    it(`${scanner} exits zero only for a positively parsed success marker`, () => {
      const dir = tempDir();
      const bin = join(dir, 'bin');
      const summary = join(dir, 'summary.md');
      const gh = join(bin, 'gh');
      const sleep = join(bin, 'sleep');
      mkdirSync(bin);
      writeFileSync(gh, '#!/bin/sh\nprintf "%s\\n" "$CHECKS_JSON"\n');
      writeFileSync(sleep, '#!/bin/sh\nexit 0\n');
      chmodSync(gh, 0o755);
      chmodSync(sleep, 0o755);

      const run = (checksJson: string) => spawnSync('/bin/sh', ['-c', verdictShell(scanner)], {
        encoding: 'utf8',
        env: {
          ...process.env,
          CHECKS_JSON: checksJson,
          GH_TOKEN: 'test-token',
          GITHUB_STEP_SUMMARY: summary,
          IS_EDIT: 'true',
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          REPO: 'owner/repo',
          SHA: '0123456789abcdef',
        },
      });

      const marker = (conclusion: string) => JSON.stringify({ check_runs: [{
        name: `${scanner}-verdict`,
        started_at: '2026-08-19T00:00:00Z',
        status: 'completed',
        conclusion,
      }] });

      expect(run(marker('success')).status).toBe(0);
      expect(run(marker('failure')).status).not.toBe(0);
      expect(run('{"check_runs":[]}').status).not.toBe(0);
      expect(run('{malformed').status).not.toBe(0);
    });
  }
});
