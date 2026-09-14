// Git honors a family of environment variables that silently redirect it to a different repository
// (GIT_DIR / GIT_WORK_TREE / GIT_COMMON_DIR / GIT_INDEX_FILE / GIT_OBJECT_DIRECTORY) or inject config
// without touching a file (GIT_CONFIG* / GIT_CONFIG_KEY_n / VALUE_n). The standalone release must
// reason about — and cut from — the operator's checkout at `sourceDir`, never whatever an inherited
// GIT_DIR names, so EVERY git call in the release path (the main-HEAD gate AND the ship-set archive/
// init) runs with these stripped; otherwise the gate could certify one repo while the artifact is cut
// from another (HED-507 review). Mirrors src/worktree.ts's GIT_ENV_OVERRIDES — the canonical list;
// keep the two in sync.
export const GIT_ENV_OVERRIDES = new Set([
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_CONFIG', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS',
  'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM',
]);
const GIT_ENV_OVERRIDE_RE = /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/;

export function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!GIT_ENV_OVERRIDES.has(name) && !GIT_ENV_OVERRIDE_RE.test(name)) env[name] = value;
  }
  return env;
}
