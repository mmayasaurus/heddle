import { z } from 'zod';

const EventSchema = z.enum(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop']);
const StringOrStrings = z.union([z.string(), z.array(z.string()).min(1)]);
export const RuleIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const StopRuleDeferralMessage = 'Stop/SubagentStop rules are deferred in v1 pending a doc-verified continuation-safe output contract (HED-403 follow-up)';

export const RuleSchema = z.object({
  id: z.string().regex(RuleIdPattern, 'id must be kebab-case'),
  event: EventSchema,
  match: z.object({
    tool: StringOrStrings.optional(),
    input: z.record(z.string(), z.string()).optional(),
    cwd: StringOrStrings.optional(),
    agent_role: z.enum(['orchestrator', 'worker', 'any']).default('any'),
  }).default({}),
  action: z.enum(['nudge', 'inject', 'block']),
  enforce: z.boolean().default(false),
  subagent_aware: z.boolean().default(false),
  message: z.string(),
  fail_open: z.literal(true),
  since: z.string().date().optional(),
  provenance: z.string().optional(),
}).superRefine((rule, ctx) => {
  // HED-403: Stop events need a doc-verified continuation-safe output contract before rules can author output for them.
  if (rule.event === 'Stop' || rule.event === 'SubagentStop') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: StopRuleDeferralMessage, path: ['event'] });
  }
  // HED-403: v1 only verifies the PreToolUse permissionDecision:"deny" contract. Blocks on all
  // other events (including SessionStart) are DEFERRED until their exact Claude Code stdout contract is verified.
  if (rule.action === 'block' && rule.event !== 'PreToolUse') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'block is DEFERRED outside PreToolUse pending a doc-verified stdout contract', path: ['action'] });
  }
  for (const [key, pattern] of Object.entries(rule.match.input ?? {})) {
    try { new RegExp(pattern); } catch { ctx.addIssue({ code: z.ZodIssueCode.custom, message: `input regex for '${key}' is invalid`, path: ['match', 'input', key] }); }
  }
});

export type Rule = z.infer<typeof RuleSchema> & { inputRegexes: ReadonlyMap<string, RegExp> };

export function parseRule(raw: unknown, idFromFilename: string): { ok: true; rule: Rule } | { ok: false; error: string } {
  const parsed = RuleSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((issue) => issue.message).join('; ') };
  if (parsed.data.id !== idFromFilename) return { ok: false, error: `id '${parsed.data.id}' does not match filename stem '${idFromFilename}'` };
  try {
    const inputRegexes = new Map(Object.entries(parsed.data.match.input ?? {}).map(([key, pattern]) => [key, new RegExp(pattern)]));
    return { ok: true, rule: { ...parsed.data, inputRegexes } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
