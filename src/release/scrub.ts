import { createHash } from 'node:crypto';

const tenantPattern = new RegExp('spin' + 'ventory', 'i');
const placeholderPattern = new RegExp('\\b' + 'S' + 'PI-n\\b', 'i');
const issuePattern = new RegExp('\\b' + 'S' + 'PI-' + '\\d+', 'i');
const teamPattern = new RegExp('\\b' + 'S' + 'PI' + '(?:[-_][A-Za-z0-9]+)?\\b', 'i');
const personalNamePattern = new RegExp('\\b' + 'ma' + 'ya\\b', 'i');
const localUsernamePattern = new RegExp('\\b' + 'ma' + 'ya' + 'tobi\\b', 'i');
const companyPattern = new RegExp('vg' + 'fg', 'i');
const homePathPattern = new RegExp('/Users/' + 'ma' + 'ya' + '(?:tobi)?\\b', 'i');
const ownerPattern = new RegExp('mmaya' + 'saurus', 'i');

export const credentialPatterns = [
  new RegExp('\\bsk-' + '[A-Za-z0-9][A-Za-z0-9-]{9,}'),
  new RegExp('g' + 'sk_' + '[A-Za-z0-9]{12,}'),
  new RegExp('c' + 'sk-' + '[A-Za-z0-9-]{12,}'),
  new RegExp('lin_' + 'api_' + '[A-Za-z0-9]{12,}'),
  new RegExp('lin_' + 'oauth_' + '[A-Za-z0-9]{12,}'),
  new RegExp('gh' + 'p_' + '[A-Za-z0-9]{12,}'),
  new RegExp('github_' + 'pat_' + '[A-Za-z0-9_]{12,}'),
];

export const identityPatterns = [
  tenantPattern, placeholderPattern, issuePattern, teamPattern, personalNamePattern,
  localUsernamePattern, companyPattern, homePathPattern, ownerPattern,
];

export type ScrubFile = { path: string; contents: string };
export type AllowlistEntry = { path: string; lineNumber: number; digest: string };

const licenseCopyrightHolder = 'Copyright (c) 2026 Very Good Fiber Goods (' + 'VG' + 'FG)';
export const licenseCopyrightExemption: AllowlistEntry = {
  path: 'LICENSE', lineNumber: 3, digest: digest(licenseCopyrightHolder),
};
export const scrubExemptions = ['LICENSE: copyright holder line (legal ownership; operator-approved)'];

export function digest(line: string): string {
  return createHash('sha256').update(line).digest('hex').slice(0, 12);
}

export function matchesForbidden(line: string): boolean {
  return [...identityPatterns, ...credentialPatterns].some((pattern) => pattern.test(line));
}

export function scanFiles(files: ScrubFile[], allowed: AllowlistEntry[] = []) {
  const flaggedEntries = new Set<string>();
  const offendingLines: string[] = [];
  for (const { path, contents } of files) {
    scanFile(path, contents, allowed, flaggedEntries, offendingLines);
  }
  return { offendingLines, staleEntries: staleEntries(files, allowed, flaggedEntries) };
}

function scanFile(
  path: string, contents: string, allowed: AllowlistEntry[], flagged: Set<string>, offending: string[],
): void {
  if (identityPatterns.some((pattern) => pattern.test(path))) {
    offending.push(`${path}: [path name carries a forbidden identifier]`);
  }
  contents.split('\n').forEach((line, index) => {
    if (!matchesForbidden(line)) return;
    const entry = `${path}:${index + 1}`;
    const lineDigest = digest(line);
    const isAllowed = allowed.some((candidate) => candidate.path === path && candidate.lineNumber === index + 1
      && candidate.digest === lineDigest);
    if (isAllowed) {
      flagged.add(`${entry}:${lineDigest}`);
      return;
    }
    const isCredential = credentialPatterns.some((pattern) => pattern.test(line));
    const shown = isCredential ? '[credential-shaped content redacted]' : line;
    offending.push(`${entry}:${lineDigest}: ${shown}`);
  });
}

function staleEntries(files: ScrubFile[], allowed: AllowlistEntry[], flagged: Set<string>): string[] {
  const stale = allowed.filter(({ path, lineNumber, digest: entryDigest }) => (
    !flagged.has(`${path}:${lineNumber}:${entryDigest}`)
  ));
  return stale
    .map(({ path, lineNumber }) => {
      const contents = files.find((file) => file.path === path)?.contents;
      const line = contents?.split('\n')[lineNumber - 1];
      return line !== undefined && matchesForbidden(line)
        ? `stale allowlist entry ${path}:${lineNumber} (line changed)`
        : `${path}:${lineNumber}`;
    });
}
