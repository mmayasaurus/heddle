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

function jobIf(job: string): string {
  const block = jobBlock(job);
  const marker = '    if: >-\n';
  const start = block.indexOf(marker);
  if (start < 0) throw new Error(`workflow job ${job} has no multiline if`);
  const lines = block.slice(start + marker.length).split('\n');
  const expression: string[] = [];
  for (const line of lines) {
    if (!line.startsWith('      ')) break;
    expression.push(line);
  }
  return expression.join('\n');
}

function verdictShell(job: string): string {
  const block = jobBlock(job);
  const step = block.indexOf('      - name: Verdict (commit) or echo (edit)\n');
  if (step < 0) throw new Error(`workflow job ${job} has no verdict/echo step`);
  const run = block.indexOf('        run: |\n', step);
  if (run < 0) throw new Error(`workflow job ${job} has no verdict/echo shell`);
  const lines = block.slice(run + '        run: |\n'.length).split('\n');
  const firstContent = lines.find((line) => line.trim() !== '');
  if (!firstContent) throw new Error(`workflow job ${job} has an empty verdict/echo shell`);
  const baseIndent = firstContent.match(/^\s*/)?.[0] ?? '';
  const shell: string[] = [];
  for (const line of lines) {
    if (line !== '' && !line.startsWith(baseIndent)) break;
    shell.push(line === '' ? line : line.slice(baseIndent.length));
  }
  return `${shell.join('\n')}\n`;
}

describe('regression HED-131 — scanner edit echoes fail closed', () => {
  const { tempDir } = useTempResources('heddle-det-review-echo-');
  const hasJq = spawnSync('jq', ['--version'], { stdio: 'ignore' }).status === 0;

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

    it(`${scanner} aggregator uses always() and couples its skip to the scan`, () => {
      const scan = jobBlock(`${scanner}-scan`);
      const verdict = jobBlock(scanner);
      const verdictIf = jobIf(scanner).replace(/\s/g, '');

      // always() is LOAD-BEARING: without it, `needs: [<scanner>-scan]` would
      // SKIP the aggregator when the scan FAILS/cancels, masking a real failure
      // (a gitleaks secret hit!) as `skipped`. With it, an eligible event always
      // runs the aggregator, which publishes the real success/failure verdict.
      expect(verdictIf).toContain('always()&&');

      if (scanner === 'semgrep') {
        // Skips exactly when semgrep-scan skips: draft + Dependabot (by AUTHOR,
        // pull_request.user.login — NOT github.actor, which is the editor on an
        // edited event). Push is always scanned.
        for (const job of [scan, verdict]) {
          expect(job).toContain('github.event.pull_request.draft == false');
          expect(job).toContain("github.event.pull_request.user.login != 'dependabot[bot]'");
          expect(job).not.toContain("github.actor != 'dependabot[bot]'");
        }
        expect(verdictIf).toContain("github.event_name=='push'");
      } else {
        // gitleaks is PR-only in BOTH — the aggregator skips on push (native
        // secret scanning covers main), so no `push` branch in its `if`.
        expect(scan).toContain("github.event_name == 'pull_request'");
        expect(verdictIf).toContain("github.event_name=='pull_request'");
        expect(verdict).not.toContain("github.event_name == 'push'");
      }
    });

    it(`${scanner} uses slurped pagination and distinguishes all echo liveness states`, () => {
      const verdict = jobBlock(scanner);
      const shell = verdictShell(scanner);

      expect(verdict).toContain('    timeout-minutes: 25');
      expect(shell).toContain('for i in $(seq 1 57); do');
      expect(shell).toContain('--paginate --slurp');
      expect(shell).toContain('[.[].check_runs[]]');
      expect(shell).toMatch(/if ! CR=\$\(gh api .* --paginate --slurp/);
      expect(shell).not.toContain("|| echo '{}'");
      expect(shell).toContain('if [ "$CONC" != "none" ] && [ "$INFLIGHT" = "0" ]; then');
      expect(shell).toContain('if [ "$CONC" = "none" ] && [ "$INFLIGHT" = "0" ]; then');
    });

    it.skipIf(!hasJq)(`${scanner} exits zero only for a jq-parsed success marker (requires jq on PATH)`, () => {
      const dir = tempDir();
      const bin = join(dir, 'bin');
      const summary = join(dir, 'summary.md');
      const gh = join(bin, 'gh');
      const sleep = join(bin, 'sleep');
      mkdirSync(bin);
      writeFileSync(gh, `#!/bin/sh
if [ -n "\${CHECKS_SEQUENCE_FILE:-}" ]; then
  COUNT_FILE="\${CHECKS_SEQUENCE_FILE}.count"
  I=$(cat "$COUNT_FILE" 2>/dev/null || printf '1')
  RESPONSE=$(sed -n "\${I}p" "$CHECKS_SEQUENCE_FILE")
  printf '%s\n' "$((I + 1))" > "$COUNT_FILE"
  if [ "$RESPONSE" = '__FAIL__' ]; then exit 1; fi
  printf '%s\n' "$RESPONSE"
else
  printf '%s\n' "$CHECKS_JSON"
fi
`);
      writeFileSync(sleep, '#!/bin/sh\nexit 0\n');
      chmodSync(gh, 0o755);
      chmodSync(sleep, 0o755);

      const run = (checksJson: string, responses?: string[]) => {
        const sequence = join(dir, `responses-${Math.random()}.txt`);
        if (responses) writeFileSync(sequence, `${responses.join('\n')}\n`);
        return spawnSync('/bin/sh', ['-c', verdictShell(scanner)], {
          encoding: 'utf8',
          env: {
            ...process.env,
            CHECKS_JSON: checksJson,
            CHECKS_SEQUENCE_FILE: responses ? sequence : '',
            GH_TOKEN: 'test-token',
            GITHUB_STEP_SUMMARY: summary,
            IS_EDIT: 'true',
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            REPO: 'owner/repo',
            SHA: '0123456789abcdef',
          },
        });
      };

      const checkPage = (...checkRuns: object[]) => ({ check_runs: checkRuns });
      const marker = (conclusion: string) => ({
        name: `${scanner}-verdict`,
        started_at: '2026-08-19T00:00:00Z',
        status: 'completed',
        conclusion,
      });
      const inFlight = {
        name: `${scanner} scan (test)`,
        started_at: '2026-08-19T00:01:00Z',
        status: 'in_progress',
        conclusion: null,
      };
      const pages = (...page: object[]) => JSON.stringify(page);

      expect(run(pages(checkPage(), checkPage(marker('success')))).status).toBe(0);
      expect(run(pages(checkPage(marker('failure')))).status).not.toBe(0);
      expect(run(pages(checkPage())).status).not.toBe(0);
      expect(run('{malformed').status).not.toBe(0);

      const race = run('', [
        pages(checkPage(marker('success'), inFlight)),
        pages(checkPage(marker('failure'))),
      ]);
      expect(race.status).not.toBe(0);
      expect(race.stdout).toContain('real verdict for 0123456789abcdef was \'failure\'');

      const outageThenSuccess = run('', [
        ...Array.from({ length: 10 }, () => '__FAIL__'),
        pages(checkPage(marker('success'))),
      ]);
      expect(outageThenSuccess.status).toBe(0);
    });
  }
});
