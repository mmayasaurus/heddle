import { existsSync, readFileSync } from 'node:fs';
import { readClaudeAccounts } from '../capaware.js';
import {
  listTaskClasses,
  loadRouting,
  resolveRoute,
  type RouteTarget,
} from '../routing.js';
import type { HarnessProvider } from './checks.js';
import { result, type CheckResult } from './probe.js';

export function loginStatus(stdout: string, stderr: string): boolean | undefined {
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;

    for (const key of ['loggedIn', 'isAuthenticated', 'authenticated']) {
      if (typeof parsed[key] === 'boolean') {
        return parsed[key];
      }
    }

    if (parsed.status === 'authenticated') {
      return true;
    }

    if (parsed.status === 'unauthenticated') {
      return false;
    }
  } catch {
    /* Text probes are supported below. */
  }

  const text = `${stdout}\n${stderr}`.trim();

  if (/^logged in/i.test(text)) {
    return true;
  }

  if (/not logged in|logged out|unauthenticated/i.test(text)) {
    return false;
  }

  return undefined;
}

export function catalogModels(stdout: string): Set<string> {
  const values = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      values.add(value);
    } else if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(walk);
    }
  };

  try {
    walk(JSON.parse(stdout));
  } catch {
    /* Text catalogs parse below. */
  }

  for (const line of stdout.split(/\r?\n/)) {
    const text = line.trim();

    if (!text) {
      continue;
    }

    for (const candidate of [
      text.split(' - ', 1)[0],
      text.split('\t', 1)[0],
      text.split(/\s+/, 1)[0],
    ]) {
      if (/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(candidate)) {
        values.add(candidate);
      }
    }
  }

  return values;
}

export function targetModels(
  provider: HarnessProvider,
  routingPath: string,
): Array<{ taskClass: string; model: string }> {
  const routing = loadRouting(routingPath);
  const targets: Array<{ taskClass: string; model: string }> = [];
  const seen = new Set<string>();
  const addTarget = (taskClass: string, target: RouteTarget): void => {
    const key = `${target.provider}\u0000${target.model}`;

    if (target.provider === provider && !seen.has(key)) {
      seen.add(key);
      targets.push({ taskClass, model: target.model });
    }
  };

  for (const taskClass of listTaskClasses(routing)) {
    const route = resolveRoute(routing, taskClass);

    for (const target of [route, route.fallback].filter(Boolean) as RouteTarget[]) {
      addTarget(taskClass, target);
    }
  }

  for (const [lane, target] of Object.entries(routing.laneDefaults ?? {})) {
    addTarget(`lane-default:${lane}`, target);
  }

  return targets;
}

export function accountResult(path: string): Omit<CheckResult, 'id' | 'kind' | 'provider'> {
  if (!existsSync(path)) {
    return result(
      'warn',
      'no Claude account registry; headless claude workers use the inherited login',
    );
  }

  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { claude?: unknown };

    if (!Array.isArray(raw.claude)) {
      return result('fail', 'accounts.json has no claude[] array', 'fix the file');
    }

    const malformed = raw.claude.filter(
      (row) => !row
        || typeof row !== 'object'
        || Array.isArray(row)
        || typeof (row as Record<string, unknown>).id !== 'string'
        || ('configDir' in row
          && (typeof (row as Record<string, unknown>).configDir !== 'string'
            && (row as Record<string, unknown>).configDir !== null))
        || ('loggedIn' in row && typeof (row as Record<string, unknown>).loggedIn !== 'boolean'),
    ).length;

    if (malformed) {
      return result(
        'fail',
        `accounts.json has ${malformed} malformed claude[] row(s) `
          + '(each needs a string id; configDir string or null; loggedIn boolean)',
        'fix the file',
      );
    }
  } catch {
    return result('fail', 'accounts.json is not valid JSON', 'fix the file');
  }

  const accounts = readClaudeAccounts(path);
  const loggedIn = accounts.filter((account) => account.loggedIn !== false).length;

  return result(
    'ok',
    `${accounts.length} Claude account${accounts.length === 1 ? '' : 's'}; ${loggedIn} logged in`,
  );
}
