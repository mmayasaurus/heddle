import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function standaloneReadme(version: string, sourceCommit: string): string {
  return template().replace('{{version}}', version).replace('{{sourceCommit}}', sourceCommit);
}

function template(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const direct = join(here, 'README.template.md');
  const source = join(here, '../../src/release/README.template.md');
  return readFileSync(existsSync(direct) ? direct : source, 'utf8');
}
