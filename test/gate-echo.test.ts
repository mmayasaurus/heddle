import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { useTempResources } from './helpers.js';

const workflow = readFileSync(join(process.cwd(), '.github/workflows/gate.yml'), 'utf8');

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

describe('regression HED-182 — gate edit echo fails closed', () => {
  const { tempDir } = useTempResources('heddle-gate-echo-');
  const hasJq = spawnSync('jq', ['--version'], { stdio: 'ignore' }).status === 0;

  it('uses the single-leaf gate echo contract', () => {
    const gate = jobBlock('gate');
    const shell = verdictShell('gate');

    expect(gate).toContain('    needs: [build]');
    expect(gate).toContain('    if: always()');
    expect(gate).toContain('    timeout-minutes: 30');
    expect(gate).toContain('      checks: write');
    expect(shell).toContain('for i in $(seq 1 57); do');
    expect(shell).toContain('--paginate --slurp');
    expect(shell).toContain('[.[].check_runs[]]');
    expect(shell).toMatch(/if ! CR=\$\(gh api .* --paginate --slurp/);
    expect(shell).not.toContain("|| echo '{}'");
    expect(shell).toContain('if [ "$CONC" != "none" ] && [ "$INFLIGHT" = "0" ]; then');
    expect(shell).toContain('if [ "$CONC" = "none" ] && [ "$INFLIGHT" = "0" ]; then');
    // D2: exit 0 is reachable only via the accept-break's VERDICT, never a
    // retained CONC at loop exhaustion.
    expect(shell).toContain('VERDICT="$CONC"; break');
    expect(shell).toContain('case "$VERDICT" in');
    // D1: a gate-verdict marker is accepted only when it is newer than the newest
    // commit-path leaf (freshness folded into the CONC jq filter).
    expect(shell).toContain('$m.started_at >= $leaf');
  });

  it.skipIf(!hasJq)('accepts only the gate leaf display name in its in-flight regex (requires jq on PATH)', () => {
    const shell = verdictShell('gate');
    const regex = shell.match(/\.name\|test\("(\^\(build\|web\|rust\))"\)/)?.[1];

    expect(regex).toBe('^(build|web|rust)');
    const selector = new RegExp(regex!);
    expect(selector.test('build (typecheck + test + build + smoke)')).toBe(true);
    expect(selector.test('gate')).toBe(false);
    expect(selector.test('gate-verdict')).toBe(false);
  });

  it.skipIf(!hasJq)('executes the edit echo against paginated markers, races, outages, and invalid data (requires jq on PATH)', () => {
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
      return spawnSync('/bin/sh', ['-c', verdictShell('gate')], {
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
    const pages = (...page: object[]) => JSON.stringify(page);
    const T = (m: number) => `2026-08-19T00:${String(m).padStart(2, '0')}:00Z`;
    // Marker/leaf carry explicit timestamps — the D1 freshness filter accepts a
    // gate-verdict marker only when it is NEWER than the newest commit-path leaf.
    const marker = (conclusion: string, ts: string) => ({
      name: 'gate-verdict',
      started_at: ts,
      status: 'completed',
      conclusion,
    });
    const leaf = (status: string, ts: string, conclusion: string | null = null) => ({
      name: 'build (typecheck + test + build + smoke)',
      started_at: ts,
      status,
      conclusion,
    });

    // A FRESH success (leaf completed, marker posted after it) → gate green.
    expect(run(pages(checkPage(leaf('completed', T(0), 'success'), marker('success', T(5))))).status).toBe(0);

    // F3: the same fresh pair split across two slurped pages → still green.
    expect(
      run(pages(checkPage(leaf('completed', T(0), 'success')), checkPage(marker('success', T(5))))).status,
    ).toBe(0);

    // Finding 1 (skipped-leaf false-RED guard): a title/body edit's OWN leaf jobs
    // are if:-false → `skipped` check-runs whose started_at is NEWER than the
    // marker. They must NOT count toward the freshness max, or the marker reads
    // stale and the gate reds on every bot edit (live-confirmed on heddle#57). A
    // real build + fresh marker + a NEWER skipped build → still green. (Without
    // `.conclusion != "skipped"` in the $leaf select, this exits non-zero.)
    expect(run(pages(checkPage(
      leaf('completed', T(0), 'success'),
      marker('success', T(5)),
      leaf('completed', T(20), 'skipped'),
    ))).status).toBe(0);

    // >= boundary: a marker whose started_at equals the newest real leaf's is
    // accepted (a marker never posts before its leaf starts; equal → fresh).
    expect(run(pages(checkPage(leaf('completed', T(0), 'success'), marker('success', T(0))))).status).toBe(0);

    // D1 (freshness isolation — THE GAP that would false-green): the new build has
    // completed/FAILURE but its fresh failure marker has NOT posted yet; only the
    // OLD success marker exists on the SHA. Freshness rejects the stale success
    // (older than the completed leaf) → CONC="none" every poll → fail closed,
    // never "gate green". WITHOUT the freshness filter, INFLIGHT=0 + a success
    // marker is accepted here → the false green this fix closes. Repeated past the
    // DRY threshold and the 57-poll belt.
    const staleGap = run('', Array.from({ length: 70 }, () =>
      pages(checkPage(marker('success', T(0)), leaf('completed', T(10), 'failure'))),
    ));
    expect(staleGap.status).not.toBe(0);
    expect(staleGap.stdout).not.toContain('gate green');

    // D1 (transition): poll 1 the new build is still in flight and the old marker
    // is not fresh → keep waiting; poll 2 the new build completed and a fresh
    // FAILURE marker exists → echo the failure. RED, "was 'failure'".
    const staleRace = run('', [
      pages(checkPage(marker('success', T(0)), leaf('in_progress', T(10)))),
      pages(checkPage(marker('success', T(0)), leaf('completed', T(10), 'failure'), marker('failure', T(15)))),
    ]);
    expect(staleRace.status).not.toBe(0);
    expect(staleRace.stdout).toContain("real verdict for 0123456789abcdef was 'failure'");

    // D2 (exhaustion false-GREEN guard): a FRESH success marker is read alongside
    // an in-flight leaf (an eventual-consistency race), then the API is out for the
    // rest of the loop. The accept-break never fires (a leaf was in flight), so
    // VERDICT stays empty and the loop exhausts → fail closed, NOT green. (Without
    // the VERDICT flag, the retained CONC=success greens the gate.) The __FAIL__
    // padding runs past the 57-poll belt so `sed` never returns empty past EOF.
    const staleThenOutage = run('', [
      pages(checkPage(leaf('in_progress', T(0)), marker('success', T(5)))),
      ...Array.from({ length: 70 }, () => '__FAIL__'),
    ]);
    expect(staleThenOutage.status).not.toBe(0);

    // F4: a transient API outage then a FRESH success → green.
    const outageThenSuccess = run('', [
      ...Array.from({ length: 10 }, () => '__FAIL__'),
      pages(checkPage(leaf('completed', T(0), 'success'), marker('success', T(5)))),
    ]);
    expect(outageThenSuccess.status).toBe(0);

    // codex P1 (DRY reset on failed read): a "verifiably gone" streak must NOT
    // survive an API outage. 5 gone-polls build DRY→5, then an outage, then a
    // gone-poll — WITHOUT the reset the pre-outage DRY + one post-outage gone-read
    // hits the fail-closed threshold and reds prematurely; WITH the reset the streak
    // restarts, so the echo keeps waiting and accepts the arriving fresh marker.
    const dryStreakBrokenByOutage = run('', [
      ...Array.from({ length: 5 }, () => pages(checkPage())),
      ...Array.from({ length: 7 }, () => '__FAIL__'),
      pages(checkPage()),
      pages(checkPage(leaf('completed', T(0), 'success'), marker('success', T(5)))),
      ...Array.from({ length: 60 }, () => '__FAIL__'),
    ]);
    expect(dryStreakBrokenByOutage.status).toBe(0);

    // A fresh FAILURE marker → red; no marker at all → red; malformed → red.
    expect(run(pages(checkPage(leaf('completed', T(0), 'failure'), marker('failure', T(5))))).status).not.toBe(0);
    expect(run(pages(checkPage(leaf('completed', T(0), 'success')))).status).not.toBe(0);
    expect(run('{malformed').status).not.toBe(0);
    // Generous timeout: each case spawns gh+jq per poll and the D2/no-marker cases
    // do a long fail-closed accumulation; under full-suite concurrency on a loaded
    // machine subprocess-spawn latency can exceed vitest's 30s default (HED-182).
    // Bumped 120s→300s (HED-266): a 60-file loaded fleet run measured 133s and timed
    // the 120s budget out under vitest's no-worker-cap parallelism; 300s clears the
    // observed worst case with margin. This is vitest.config.ts's own doctrine —
    // explicit per-test budgets for the slow subprocess tests, not a worker cap.
  }, 300000);
});
