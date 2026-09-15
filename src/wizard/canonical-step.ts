import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { installFleetHooks } from '../fleet.js';
import { validateCanonical } from '../init-project.js';
import { atomicWriteFile } from './persist.js';
import type { WizardContext, WizardIO, WizardStep, WizardStepResult } from './step.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readPriorCanonical(path: string): Record<string, unknown> | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isPlainObject(parsed) || typeof parsed.canonical !== 'string') {
    throw new Error('canonical config is not a JSON object with a string canonical');
  }
  return parsed;
}

function writeCanonical(path: string, prior: Record<string, unknown> | undefined, canonical: string): void {
  atomicWriteFile(path, `${JSON.stringify({ ...prior, canonical }, null, 2)}\n`);
}

function installDetail(files: { name: string; action: string }[]): string {
  const counts = new Map<string, number>();
  for (const { action } of files) counts.set(action, (counts.get(action) ?? 0) + 1);
  return ['created', 'unchanged', 'differing']
    .filter((action) => counts.has(action))
    .map((action) => `${action}: ${counts.get(action)}`)
    .join('; ');
}

function readAndKeepCanonical(configPath: string): { prior?: Record<string, unknown>; result?: WizardStepResult } {
  let prior: Record<string, unknown> | undefined;
  try {
    prior = readPriorCanonical(configPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      result: {
        id: 'canonical', status: 'failed',
        summary: code ? `could not read existing canonical.json at ${configPath} (${code})` : `existing canonical.json is corrupt — fix or remove ${configPath}`,
      },
    };
  }
  if (!prior) return {};
  try {
    const { canonical, missing } = validateCanonical(prior.canonical as string);
    return !missing.length
      ? { prior, result: { id: 'canonical', status: 'done', summary: `kept canonical ${canonical}` } }
      : { prior };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { prior, result: { id: 'canonical', status: 'failed', summary: `could not validate existing canonical at ${configPath}: ${message}` } };
  }
}

function recordOverride(
  envOverride: string,
  configPath: string,
  prior: Record<string, unknown> | undefined,
  ctx: WizardContext,
  io: WizardIO,
): WizardStepResult {
  let canonical: string;
  let missing: string[];
  try {
    ({ canonical, missing } = validateCanonical(envOverride));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { id: 'canonical', status: 'failed', summary: `could not record canonical from $HEDDLE_CANONICAL: ${message}` };
  }
  if (missing.length) return { id: 'canonical', status: 'failed', summary: `canonical ${canonical} (from $HEDDLE_CANONICAL) is missing required discipline hooks: ${missing.join(', ')}` };
  if (ctx.dryRun) {
    try {
      io.report(`would record canonical ${canonical} (from $HEDDLE_CANONICAL); nothing written`);
      return { id: 'canonical', status: 'skipped', summary: `would record canonical ${canonical} (from $HEDDLE_CANONICAL)` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { id: 'canonical', status: 'failed', summary: `could not record canonical from $HEDDLE_CANONICAL: ${message}` };
    }
  }
  try {
    writeCanonical(configPath, prior, canonical);
    return { id: 'canonical', status: 'done', summary: `recorded canonical ${canonical} (from $HEDDLE_CANONICAL)` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { id: 'canonical', status: 'failed', summary: `could not record canonical from $HEDDLE_CANONICAL: ${message}` };
  }
}

async function installAndRecord(
  derived: string,
  configPath: string,
  prior: Record<string, unknown> | undefined,
  ctx: WizardContext,
  io: WizardIO,
): Promise<WizardStepResult> {
  if (ctx.dryRun) {
    try {
      const report = installFleetHooks({ homeDir: ctx.homeDir, dryRun: true, skipDiffering: true });
      if (!report.files.length) io.report('this pack ships no discipline hooks — canonical not recorded; init-project needs --canonical <path>');
      else io.report(`${report.files.map(({ name, action }) => `would ${action} ${name}`).join('\n')}\nwould record canonical ${derived}`);
      return { id: 'canonical', status: 'skipped', summary: 'dry-run — canonical installation and config write skipped' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { id: 'canonical', status: 'failed', summary: `could not preview discipline hook installation: ${message}` };
    }
  }

  let accepted: boolean;
  try {
    accepted = await io.prompter.confirm(`Install the heddle discipline hook set to ${derived} so init-project runs flag-free?`, true);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { id: 'canonical', status: 'failed', summary: `could not confirm canonical installation: ${message}` };
  }

  if (!accepted) {
    try {
      const { canonical, missing } = validateCanonical(derived);
      if (!missing.length) {
        writeCanonical(configPath, prior, canonical);
        return { id: 'canonical', status: 'done', summary: `recorded canonical ${canonical} (hooks already present)` };
      }
      return { id: 'canonical', status: 'skipped', summary: 'install declined — canonical not recorded; init-project will need --canonical <path>' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { id: 'canonical', status: 'failed', summary: `could not record existing canonical: ${message}` };
    }
  }

  try {
    const report = installFleetHooks({ homeDir: ctx.homeDir, dryRun: false, skipDiffering: true });
    if (!report.files.length) {
      io.report('this pack ships no discipline hooks — canonical not recorded; init-project needs --canonical <path>');
      return { id: 'canonical', status: 'skipped', summary: 'this pack ships no discipline hooks — canonical not recorded; init-project needs --canonical <path>' };
    }
    const detail = installDetail(report.files);
    const { canonical, missing } = validateCanonical(derived);
    if (missing.length) return { id: 'canonical', status: 'failed', summary: `canonical ${canonical} still missing required discipline hooks after install: ${missing.join(', ')}` };
    writeCanonical(configPath, prior, canonical);
    return { id: 'canonical', status: 'done', summary: `recorded canonical ${canonical}`, detail };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { id: 'canonical', status: 'failed', summary: `could not install or record canonical: ${message}` };
  }
}

export const canonicalStep: WizardStep = {
  id: 'canonical',
  title: 'Canonical',
  async run(ctx, io) {
    const configPath = join(ctx.homeDir, '.heddle', 'canonical.json');
    const derived = join(ctx.homeDir, '.heddle', 'fleet');
    const envOverride = process.env.HEDDLE_CANONICAL?.trim() || undefined;
    const { prior, result } = readAndKeepCanonical(configPath);
    if (result) return result;
    if (envOverride) return recordOverride(envOverride, configPath, prior, ctx, io);
    return installAndRecord(derived, configPath, prior, ctx, io);
  },
};
