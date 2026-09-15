// Ambient Anthropic credentials that outrank or short-circuit the per-account /login credential in the
// documented auth-precedence chain: if any is inherited from the operator's shell (an env-repoint
// ANTHROPIC_BASE_URL would even aim the native OAuth flow at a gateway), `claude auth login` and
// `auth status` would resolve THAT identity instead of the isolated CLAUDE_CONFIG_DIR (HED-585).
// CANONICAL LIST (HED-607 runtime strip / HED-674). `heddle ambient-cred-vars` emits exactly this list.
// Two kinds of consumer:
//   - TypeScript (accountEnv, below via import) uses this constant directly.
//   - Non-TS runtime strip sites — the bash launcher (resume-sessions-v2.sh) and the Python
//     window-keeper (heddle-window-keeper.py) — keep a HARD-CODED verbatim copy so they can strip even
//     when heddle is not invocable at that instant (no chicken/egg, no runtime dependency on the CLI);
//     their TESTS call `heddle ambient-cred-vars` and assert their copy equals this list, so drift is
//     caught in CI, not at runtime (design confirmed with T, 2026-09-15).
// Denylist of the documented precedence vars; codex's OPENAI_* surface is a separate audit.
export const CLAUDE_AMBIENT_CRED_VARS = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_PROFILE',
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_FEDERATION_RULE_ID', 'ANTHROPIC_ORGANIZATION_ID',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
] as const;
