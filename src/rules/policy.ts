import { secureReadFile } from '../secure-fs.js';
import type { HookRuleSelection } from '../wizard/hooks-choose.js';
import type { Rule } from './schema.js';

export interface RulesPolicy {
  schemaVersion: 1;
  rules: HookRuleSelection[];
}

// `absent` (no policy configured) is the normal case and fails open SILENTLY; `warning` is the
// believed-configured-but-unusable case (a securely-unreadable or malformed file) and fails open LOUDLY,
// naming path + reason (HED-594 convergence, R): an operator who configured a policy must never silently
// run catalog defaults instead.
export type RulesPolicyLoadResult =
  | { policy: RulesPolicy; warning?: never; absent?: never }
  | { policy?: never; warning: string; absent?: never }
  | { policy?: never; warning?: never; absent: true };

function isRuleSelection(value: unknown): value is HookRuleSelection {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && typeof (value as HookRuleSelection).id === 'string'
    && typeof (value as HookRuleSelection).enforce === 'boolean';
}

export function loadRulesPolicy(path: string): RulesPolicyLoadResult {
  // Operator-domain read (the HED-218/586 secure-fs pattern): O_NOFOLLOW + fstat-on-the-fd rejects a
  // symlink, a non-regular/special file (which would otherwise HANG a synchronous read — /dev/zero, a
  // FIFO), a foreign-owned file, and a group/other-permissioned file, closing the check-then-read TOCTOU.
  // The wizard writes ~/.heddle/policy/rules.json 0600 in a 0700 dir (atomicWriteFile), so this is a clean fit.
  let contents: string;
  try {
    contents = secureReadFile(path);
  } catch (error) {
    // ABSENT (the file — or its parent dir — does not exist): no policy configured → fail open SILENTLY.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { absent: true };
    // EXISTS but not securely readable (symlink / special file / foreign-owned / group-or-other perms /
    // open error): the operator configured *something* → fail open LOUDLY, naming path + reason.
    const detail = error instanceof Error ? error.message : String(error);
    return { warning: `rules policy at ${path} could not be securely read (${detail}); using catalog enforcement` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { warning: `rules policy at ${path} is not valid JSON (${detail}); using catalog enforcement` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { warning: `rules policy at ${path} is not a v1 policy object; using catalog enforcement` };
  }
  const candidate = parsed as { schemaVersion?: unknown; rules?: unknown };
  if (candidate.schemaVersion !== 1 || !Array.isArray(candidate.rules) || !candidate.rules.every(isRuleSelection)) {
    return { warning: `rules policy at ${path} is not a valid v1 policy; using catalog enforcement` };
  }
  return { policy: { schemaVersion: 1, rules: candidate.rules } };
}

export function applyPolicy(rules: Rule[], policy: RulesPolicy): Rule[] {
  const selections = new Map(policy.rules.map((selection) => [selection.id, selection.enforce]));
  return rules.map((rule) => ({ ...rule, enforce: rule.enforce && selections.get(rule.id) === true }));
}
