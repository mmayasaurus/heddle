import { readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseRule, type Rule } from './schema.js';

function note(file: string, reason: string): void { process.stderr.write(`heddle-hook: rule '${file}' ignored: ${reason}\n`); }

export function loadRules(rulesDir: string): Rule[] {
  try {
    const files = readdirSync(rulesDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && extname(entry.name) === '.yaml')
      .map((entry) => entry.name).sort();
    const rules: Rule[] = [];
    for (const file of files) {
      try {
        const raw = parseYaml(readFileSync(join(rulesDir, file), 'utf8'));
        const parsed = parseRule(raw, basename(file, '.yaml'));
        if (!parsed.ok) { note(file, parsed.error); continue; }
        rules.push(parsed.rule);
      } catch (err) { note(file, err instanceof Error ? err.message : String(err)); }
    }
    return rules;
  } catch (err) {
    note(rulesDir, err instanceof Error ? err.message : String(err));
    return [];
  }
}
