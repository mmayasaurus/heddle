/**
 * Canonical model-family identity across native CLIs and multi-provider harnesses.
 * Provider names alone are insufficient for OpenCode because its model id is `provider/model`.
 */
export function modelFamily(providerRaw: string | undefined | null, modelRaw?: string | null): string | undefined {
  const provider = providerRaw?.trim().toLowerCase();
  if (!provider) return undefined;
  const model = modelRaw?.trim().toLowerCase() ?? '';

  if (provider === 'gemini' || provider === 'gemini-cli') return 'gemini';
  if (provider === 'codex') return 'gpt';
  if (provider === 'claude') return 'claude';

  if (provider === 'opencode') {
    const slash = model.indexOf('/');
    const upstream = slash > 0 ? model.slice(0, slash) : '';
    if (upstream === 'anthropic') return 'claude';
    if (upstream === 'openai' || upstream === 'azure-openai') return 'gpt';
    if (upstream === 'google' || upstream === 'google-vertex' || upstream === 'gemini') return 'gemini';
    // Keep unknown OpenCode upstreams distinct from both each other and the harness itself. This
    // prevents two routes through the same upstream from masquerading as independent reviewers.
    return upstream ? `opencode:${upstream}` : 'opencode:unknown';
  }

  return provider;
}

export function sameModelFamily(
  leftProvider: string | undefined | null, leftModel: string | undefined | null,
  rightProvider: string | undefined | null, rightModel: string | undefined | null,
): boolean {
  const left = modelFamily(leftProvider, leftModel);
  const right = modelFamily(rightProvider, rightModel);
  return left !== undefined && right !== undefined && left === right;
}
