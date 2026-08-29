import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { discoverFixtures, runFixtureFile, type FixtureResult } from './fixture.js';
import { parseRule } from './schema.js';

type RuleRow = {
  id: string;
  event: string;
  action: string;
  enforce: boolean | '';
  state: 'active' | 'proposed';
  since: string;
  'age-days': number | '';
  provenance: string;
  error?: string;
};

function usage(): void {
  process.stderr.write('usage: heddle rule <list [--json] | propose <path-to-yaml> | ratify <id> | test [id]> [--rules <dir>]\n');
}

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
}

function resolveRulesRoot(argv: string[]): string {
  return flag(argv, '--rules') ?? process.env.HEDDLE_RULES_DIR ?? (process.env.CLAUDE_PROJECT_DIR
    ? `${process.env.CLAUDE_PROJECT_DIR}/rules`
    : fileURLToPath(new URL('../../rules', import.meta.url)));
}

function yamlFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && extname(entry.name) === '.yaml')
      .map((entry) => entry.name).sort();
  } catch { return []; }
}

function today(): string { return new Date().toISOString().slice(0, 10); }

function ageDays(since: string | undefined): number | '' {
  if (!since) return '';
  const date = Date.parse(`${since}T00:00:00.000Z`);
  return Number.isNaN(date) ? '' : Math.floor((Date.now() - date) / 86_400_000);
}

function listRows(root: string): RuleRow[] {
  return ([['active', root], ['proposed', join(root, 'proposed')]] as const).flatMap(([state, dir]) => yamlFiles(dir).map((file) => {
    const id = basename(file, '.yaml');
    try {
      const parsed = parseRule(parseYaml(readFileSync(join(dir, file), 'utf8')), id);
      if (!parsed.ok) return { id, event: '', action: '', enforce: '', state, since: '', 'age-days': '', provenance: '', error: parsed.error };
      const { rule } = parsed;
      return { id, event: rule.event, action: rule.action, enforce: rule.enforce, state, since: rule.since ?? '', 'age-days': ageDays(rule.since), provenance: rule.provenance ?? '' };
    } catch (err) {
      return { id, event: '', action: '', enforce: '', state, since: '', 'age-days': '', provenance: '', error: err instanceof Error ? err.message : String(err) };
    }
  }));
}

function printFixtureResults(ruleId: string, results: FixtureResult[]): boolean {
  let passed = true;
  for (const result of results) {
    const label = result.pass ? 'passed' : 'FAILED';
    process.stdout.write(`${ruleId}: ${result.name}: ${label}${result.pass ? '' : ` — ${result.message}`}\n`);
    if (!result.pass) passed = false;
  }
  return passed;
}

function rulePath(root: string, id: string): { rulesDir: string; path: string } | undefined {
  const active = join(root, `${id}.yaml`);
  if (existsSync(active)) return { rulesDir: root, path: active };
  const proposed = join(root, 'proposed', `${id}.yaml`);
  if (existsSync(proposed)) return { rulesDir: join(root, 'proposed'), path: proposed };
  return undefined;
}

async function list(root: string, json: boolean): Promise<number> {
  const rows = listRows(root);
  if (json) process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
  else if (!rows.length) process.stdout.write('(no rules)\n');
  else {
    process.stdout.write('id\tstate\tevent\taction\tenforce\tsince\tage-days\tprovenance\terror\n');
    for (const row of rows) process.stdout.write(`${row.id}\t${row.state}\t${row.event}\t${row.action}\t${row.enforce}\t${row.since}\t${row['age-days']}\t${row.provenance}\t${row.error ?? ''}\n`);
  }
  return 0;
}

async function propose(root: string, source: string | undefined): Promise<number> {
  if (!source || source.startsWith('--')) { usage(); return 2; }
  const id = basename(source, extname(source));
  let contents: string;
  try { contents = readFileSync(source, 'utf8'); }
  catch (err) { process.stderr.write(`heddle rule: refusing propose: cannot read '${source}': ${err instanceof Error ? err.message : String(err)}\n`); return 1; }
  let parsed;
  try { parsed = parseRule(parseYaml(contents), id); }
  catch (err) { process.stderr.write(`heddle rule: refusing propose: invalid '${source}': ${err instanceof Error ? err.message : String(err)}\n`); return 1; }
  if (!parsed.ok) { process.stderr.write(`heddle rule: refusing propose: invalid '${source}': ${parsed.error}\n`); return 1; }
  if (!parsed.rule.provenance?.trim()) { process.stderr.write('heddle rule: refusing propose: provenance is required\n'); return 1; }
  if (!existsSync(join(root, 'tests', `${id}.jsonl`))) { process.stderr.write(`heddle rule: refusing propose: missing fixture '${join(root, 'tests', `${id}.jsonl`)}'\n`); return 1; }
  const active = join(root, `${id}.yaml`); const proposed = join(root, 'proposed', `${id}.yaml`);
  if (existsSync(active) || existsSync(proposed)) { process.stderr.write(`heddle rule: refusing propose: rule '${id}' already exists\n`); return 1; }
  mkdirSync(join(root, 'proposed'), { recursive: true });
  writeFileSync(proposed, contents);
  process.stdout.write(`heddle rule: proposed '${id}'\n`);
  return 0;
}

async function ratify(root: string, id: string | undefined): Promise<number> {
  if (!id || id.startsWith('--')) { usage(); return 2; }
  if (process.env.HEDDLE_WORKER) { process.stderr.write('heddle rule: refusing ratify: workers cannot ratify rules\n'); return 1; }
  const proposedDir = join(root, 'proposed'); const proposed = join(proposedDir, `${id}.yaml`); const active = join(root, `${id}.yaml`);
  if (!existsSync(proposed)) { process.stderr.write(`heddle rule: refusing ratify: proposed rule '${id}' does not exist\n`); return 1; }
  if (existsSync(active)) { process.stderr.write(`heddle rule: refusing ratify: active rule '${id}' already exists\n`); return 1; }
  const results = runFixtureFile(proposedDir, id, join(root, 'tests', `${id}.jsonl`));
  if (!results.every((result) => result.pass)) {
    process.stderr.write(`heddle rule: refusing ratify: fixture failures for '${id}': ${results.filter((result) => !result.pass).map((result) => `${result.name}: ${result.message}`).join('; ')}\n`);
    return 1;
  }
  const raw = parseYaml(readFileSync(proposed, 'utf8'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { process.stderr.write(`heddle rule: refusing ratify: invalid proposed rule '${id}'\n`); return 1; }
  if (!('since' in raw) || !raw.since) raw.since = today();
  writeFileSync(proposed, stringifyYaml(raw));
  renameSync(proposed, active);
  process.stdout.write(`heddle rule: ratified '${id}'\n`);
  return 0;
}

async function test(root: string, id: string | undefined): Promise<number> {
  const fixtures = id ? [{ ruleId: id, fixturePath: join(root, 'tests', `${id}.jsonl`) }] : discoverFixtures(root, join(root, 'tests'));
  if (!fixtures.length) { process.stdout.write('(no fixtures)\n'); return 0; }
  let passed = true;
  for (const fixture of fixtures) {
    const found = rulePath(root, fixture.ruleId);
    if (!found) {
      process.stdout.write(`${fixture.ruleId}: <rule>: FAILED — rule does not exist\n`);
      passed = false;
      continue;
    }
    if (!printFixtureResults(fixture.ruleId, runFixtureFile(found.rulesDir, fixture.ruleId, fixture.fixturePath))) passed = false;
  }
  return passed ? 0 : 1;
}

/** Runs the rule lifecycle CLI and returns an exit code instead of throwing. */
export async function runRuleCli(argv: string[]): Promise<number> {
  try {
    const [command] = argv;
    const root = resolveRulesRoot(argv);
    if (command === 'list') return await list(root, argv.includes('--json'));
    if (command === 'propose') return await propose(root, argv[1]);
    if (command === 'ratify') return await ratify(root, argv[1]);
    if (command === 'test') return await test(root, argv[1]?.startsWith('--') ? undefined : argv[1]);
    usage();
    return 2;
  } catch (err) {
    process.stderr.write(`heddle rule: failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
