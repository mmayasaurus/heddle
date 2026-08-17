import { beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { Ledger } from '../src/ledger.js';
import { ensureBuilt, runCli, withTempHome } from './helpers/cli.js';

function dispatchRecord(overrides: Partial<Parameters<Ledger['start']>[0]> = {}) {
  return {
    orchestrator: 'U', taskClass: 'implementation', provider: 'claude', model: 'sonnet',
    skills: 'worker-role', issue: 'HED-120', pr: null, cwd: '/tmp/x', promptPreview: 'do the thing',
    sessionId: null, fellBackFrom: null, ...overrides,
  };
}

describe('heddle ledger CLI', () => {
  beforeAll(async () => {
    await ensureBuilt();
  }, 120_000);

  it('prints usage and exits zero with no command', async () => {
    const result = await runCli([]);
    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(result.stdout).toContain('heddle — cross-provider orchestration');
  }, 30_000);

  it('prints usage and exits two for an unknown command', async () => {
    const result = await runCli(['not-a-command']);
    expect(result).toMatchObject({ code: 2, stderr: '' });
    expect(result.stdout).toContain('heddle — cross-provider orchestration');
  }, 30_000);

  it('shows a seeded finished dispatch output', async () => {
    const home = withTempHome();
    const ledger = new Ledger(join(home, '.heddle', 'ledger.db'));
    const id = ledger.start(dispatchRecord());
    ledger.finish(id, { ok: true, output: 'the recorded worker output' });
    ledger.close();

    const result = await runCli(['ledger', 'show', String(id)], { home });
    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(result.stdout).toContain('the recorded worker output');
  }, 30_000);

  it('reports an unknown dispatch without rendering JSON null', async () => {
    const result = await runCli(['ledger', 'show', '999999']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('#999999');
    expect(result.stdout.trim()).not.toBe('null');
  }, 30_000);

  it('renders a seeded dispatch as JSON', async () => {
    const home = withTempHome();
    const ledger = new Ledger(join(home, '.heddle', 'ledger.db'));
    const id = ledger.start(dispatchRecord());
    ledger.finish(id, { ok: true, output: 'json output' });
    ledger.close();

    const result = await runCli(['ledger', 'show', String(id), '--json'], { home });
    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(result.stdout)).toMatchObject({ id });
  }, 30_000);

  it.each([
    ['a non-numeric id', ['ledger', 'report-in-session', 'nope', '--ok']],
    ['id zero', ['ledger', 'report-in-session', '0', '--ok']],
    ['neither outcome flag', ['ledger', 'report-in-session', '1']],
    ['both outcome flags', ['ledger', 'report-in-session', '1', '--ok', '--failed']],
    ['a non-numeric input token count', ['ledger', 'report-in-session', '1', '--ok', '--input-tokens', 'nope']],
    ['a negative input token count', ['ledger', 'report-in-session', '1', '--ok', '--input-tokens', '-5']],
    ['a fractional input token count', ['ledger', 'report-in-session', '1', '--ok', '--input-tokens', '1.5']],
    ['a missing input token count before the next flag', ['ledger', 'report-in-session', '1', '--input-tokens', '--ok']],
  ])('rejects report-in-session with %s', async (_description, args) => {
    const result = await runCli(args);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('usage: heddle ledger report-in-session');
  }, 30_000);

  it('records an in-session report once and exposes its usage', async () => {
    const home = withTempHome();
    const ledger = new Ledger(join(home, '.heddle', 'ledger.db'));
    const id = ledger.refuse(dispatchRecord(), 'claude-in-session', 'run this yourself', 'in-session');
    ledger.close();

    const reported = await runCli([
      'ledger', 'report-in-session', String(id), '--ok', '--input-tokens', '100', '--output-tokens', '20',
    ], { home });
    expect(reported).toMatchObject({ code: 0, stderr: '' });

    const usage = await runCli(['usage', '--json'], { home });
    expect(usage).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(usage.stdout)).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'claude', dispatches: 1, input_tokens: 100, output_tokens: 20 }),
    ]));

    const duplicate = await runCli(['ledger', 'report-in-session', String(id), '--ok'], { home });
    expect(duplicate.code).toBe(1);
  }, 30_000);

  it('renders empty workers as JSON', async () => {
    const result = await runCli(['workers', '--json']);
    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(result.stdout)).toEqual([]);
  }, 30_000);
});
