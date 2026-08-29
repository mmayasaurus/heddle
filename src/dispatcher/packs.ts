import { withMandatoryPacks, modelFamilyPack, ALL_FAMILY_PACKS, resolveQualityGateForCwd } from '../skillpacks.js';

/**
 * The exact pack list a dispatch to `provider` materializes (HED-93). Shared by runTarget AND
 * planDispatch so refusal instructions and dry runs never advertise a different set than the worker
 * actually receives (PR #34, four reviewers).
 *
 * Caller-supplied family packs are DROPPED: the family pack is chosen from the TARGET, so an
 * explicit family-codex on a route that falls back to cursor would hand the worker two conflicting
 * instruction styles. The dispatcher's choice wins.
 */
export function packsFor(provider: string, requested: readonly string[], cwd: string): string[] {
  const withoutForeignFamilies = requested.filter((p) => !ALL_FAMILY_PACKS.has(p));
  // cwd is REQUIRED: `quality-gate` is resolved per repository from it (HED-389) — an optional cwd
  // whose absence kept the app gate was the old unsafe behaviour in disguise (round-1 review #5).
  const base = resolveQualityGateForCwd(cwd, withMandatoryPacks(withoutForeignFamilies));
  const family = modelFamilyPack(provider);
  return family && !base.includes(family) ? [...base, family] : base;
}

/**
 * The packs a request asks for, before packsFor's mandatory/gate resolution: an explicit `skills`
 * list REPLACES the class default — except for review classes (a reviewerPool), whose class packs
 * carry the find-only MANDATE and are UNIONED with the explicit list, never dropped. ONE definition
 * for the real run and every dry-run/refusal path: those used to replace unconditionally, so a
 * review dry run advertised a set the worker never got (PR #34 parity; HED-389 round-2 review #2).
 */
export function requestedPacks(
  reviewerPool: readonly unknown[] | undefined, classSkills: readonly string[] | undefined,
  explicit: readonly string[] | undefined,
): string[] {
  if (reviewerPool) return [...new Set([...(classSkills ?? []), ...(explicit ?? [])])];
  return [...(explicit ?? classSkills ?? [])];
}
