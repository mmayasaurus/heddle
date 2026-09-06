import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { bootstrapComms } from '../src/comms/bootstrap.js';
import { CommsLog, DEFAULT_ROOM } from '../src/comms/log.js';
import { runDoctor } from '../src/doctor.js';
import { check, config, fakeDeps, resources } from './doctor-fixtures.js';

describe('runDoctor comms readiness', () => {
  test('warns when comms is uninitialized', async () => {
    const dir = resources.tempDir();
    const dbPath = join(dir, 'comms.db');
    const tokenPath = join(dir, 'operator.token');
    const report = await runDoctor({}, fakeDeps({ ...config(), comms: dbPath, operatorToken: tokenPath }));

    expect(check(report, 'comms:ready')).toMatchObject({
      outcome: 'warn', detail: expect.stringMatching(/not initialized/), hint: expect.stringMatching(/heddle comms init/),
    });
  });

  test('reports bootstrap-provisioned comms as ready', async () => {
    const dir = resources.tempDir();
    const dbPath = join(dir, 'comms.db');
    const tokenPath = join(dir, 'operator.token');
    bootstrapComms({ commsDbPath: dbPath, operatorTokenPath: tokenPath, projectsPath: join(dir, 'projects.json') });
    const report = await runDoctor({}, fakeDeps({ ...config(), comms: dbPath, operatorToken: tokenPath }));

    expect(check(report, 'comms:ready')).toMatchObject({ outcome: 'ok' });
    expect(check(report, 'comms:ready').detail).toContain('operator token');
    expect(check(report, 'comms:ready').detail).toContain(DEFAULT_ROOM);
  });

  test('warns when the database and room exist but the operator token is absent', async () => {
    const dir = resources.tempDir();
    const dbPath = join(dir, 'comms.db');
    const tokenPath = join(dir, 'operator.token');
    const log = new CommsLog(dbPath);
    log.ensureDefaultRooms();
    log.close();
    const report = await runDoctor({}, fakeDeps({ ...config(), comms: dbPath, operatorToken: tokenPath }));

    expect(check(report, 'comms:ready')).toMatchObject({
      outcome: 'warn', detail: expect.stringMatching(/operator token/),
    });
    expect(check(report, 'comms:ready').detail).toMatch(/missing/);
  });

  test('fails when the default room is absent', async () => {
    const dir = resources.tempDir();
    const dbPath = join(dir, 'comms.db');
    const tokenPath = join(dir, 'operator.token');
    const log = new CommsLog(dbPath);
    log.close();
    const report = await runDoctor({}, fakeDeps({ ...config(), comms: dbPath, operatorToken: tokenPath }));

    expect(check(report, 'comms:ready')).toMatchObject({ outcome: 'fail' });
    expect(check(report, 'comms:ready').detail).toContain(DEFAULT_ROOM);
  });

  test('does not create a missing comms database or its parent directory', async () => {
    const dbPath = join(resources.tempDir(), 'nested', 'comms.db');
    const tokenPath = join(resources.tempDir(), 'operator.token');
    const report = await runDoctor({}, fakeDeps({ ...config(), comms: dbPath, operatorToken: tokenPath }));

    expect(check(report, 'comms:ready').outcome).toBe('warn');
    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(dirname(dbPath))).toBe(false);
  });

  test('resolves the comms db from HEDDLE_COMMS_DB, not DEFAULT_COMMS_PATH', async () => {
    const dir = resources.tempDir();
    const provisioned = join(dir, 'provisioned.db');
    const tokenPath = join(dir, 'operator.token');
    bootstrapComms({ commsDbPath: provisioned, operatorTokenPath: tokenPath, projectsPath: join(dir, 'projects.json') });
    const missing = join(dir, 'missing.db');

    // comms stays UNSET (undefined) so env drives resolution. Two env values that MUST yield different
    // outcomes prove the check reads HEDDLE_COMMS_DB and not DEFAULT_COMMS_PATH — whose host ~/.heddle
    // state a test cannot control (an assert-only-`ok` test greens even if env were ignored). Review (med).
    const ready = await runDoctor({}, fakeDeps({ ...config(), comms: undefined, operatorToken: tokenPath }, { env: { HEDDLE_COMMS_DB: provisioned } }));
    const absent = await runDoctor({}, fakeDeps({ ...config(), comms: undefined, operatorToken: tokenPath }, { env: { HEDDLE_COMMS_DB: missing } }));

    expect(check(ready, 'comms:ready').outcome).toBe('ok');
    expect(check(absent, 'comms:ready').outcome).toBe('warn');
  });

  test('fails when the comms database cannot be opened', async () => {
    const dir = resources.tempDir();
    const dbPath = join(dir, 'comms.db');
    const tokenPath = join(dir, 'operator.token');
    writeFileSync(dbPath, 'not a database');
    writeFileSync(tokenPath, 'test token');
    const report = await runDoctor({}, fakeDeps({ ...config(), comms: dbPath, operatorToken: tokenPath }));

    expect(check(report, 'comms:ready')).toMatchObject({
      outcome: 'fail', detail: expect.stringMatching(/cannot be opened/),
    });
  });

  test('warns when the operator token is an empty file (not a usable token)', async () => {
    const dir = resources.tempDir();
    const dbPath = join(dir, 'comms.db');
    const tokenPath = join(dir, 'operator.token');
    const log = new CommsLog(dbPath);
    log.ensureDefaultRooms();
    log.close();
    writeFileSync(tokenPath, ''); // exists, but zero bytes — existsSync would report it present; statSync catches it
    const report = await runDoctor({}, fakeDeps({ ...config(), comms: dbPath, operatorToken: tokenPath }));

    expect(check(report, 'comms:ready')).toMatchObject({
      outcome: 'warn', detail: expect.stringMatching(/operator token/),
    });
  });
});
