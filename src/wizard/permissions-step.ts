import { readFileSync } from 'node:fs';
import { atomicWriteFile, policyPath } from './persist.js';
import type { WizardStep } from './step.js';

export const permissionCategories = [
  'file-deletion',
  'git-history-rewrite',
  'db-destructive',
  'disk-level',
  'credential-writes',
  'package-removal',
] as const;

export const permissionPostures = ['block', 'ask', 'nudge', 'off'] as const;
export const permissionProfiles = ['interactive', 'unattended'] as const;
export const permissionPresets = ['minimal', 'standard', 'strict'] as const;

export type PermissionCategory = typeof permissionCategories[number];
export type PermissionPosture = typeof permissionPostures[number];
export type PermissionProfile = typeof permissionProfiles[number];
export type PermissionPreset = typeof permissionPresets[number];

export interface PermissionsPolicy {
  version: 1;
  activeProfile: PermissionProfile;
  profiles: Record<PermissionProfile, Record<PermissionCategory, PermissionPosture>>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPosture(value: unknown): value is PermissionPosture {
  return typeof value === 'string' && (permissionPostures as readonly string[]).includes(value);
}

function isProfile(value: unknown): value is PermissionProfile {
  return typeof value === 'string' && (permissionProfiles as readonly string[]).includes(value);
}

function presetPosture(preset: PermissionPreset, category: PermissionCategory): PermissionPosture {
  if (preset === 'strict') return 'ask';
  if (preset === 'standard' && ['file-deletion', 'git-history-rewrite', 'credential-writes'].includes(category)) return 'ask';
  return 'nudge';
}

function readPriorPolicy(path: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }

  const parsed: unknown = JSON.parse(raw);
  if (!isPlainObject(parsed)) throw new Error('permissions policy is not a JSON object');
  if (parsed.version !== undefined && parsed.version !== 1) throw new Error('permissions policy has an unsupported version');
  if (parsed.activeProfile !== undefined && !isProfile(parsed.activeProfile)) {
    throw new Error('permissions policy has an invalid activeProfile');
  }
  if (parsed.profiles !== undefined) {
    if (!isPlainObject(parsed.profiles)) throw new Error('permissions policy "profiles" is not an object');
    for (const profile of permissionProfiles) {
      const values = parsed.profiles[profile];
      if (values === undefined) continue;
      if (!isPlainObject(values)) throw new Error(`permissions policy profile "${profile}" is not an object`);
      for (const category of permissionCategories) {
        const posture = values[category];
        if (posture !== undefined && !isPosture(posture)) {
          throw new Error(`permissions policy profile "${profile}" has an invalid posture for "${category}"`);
        }
      }
    }
  }
  return parsed;
}

function priorPosture(
  prior: Record<string, unknown>,
  profile: PermissionProfile,
  category: PermissionCategory,
): PermissionPosture | undefined {
  const profiles = prior.profiles;
  if (!isPlainObject(profiles)) return undefined;
  const profileValues = profiles[profile];
  return isPlainObject(profileValues) && isPosture(profileValues[category]) ? profileValues[category] : undefined;
}

function promptChoices(defaultPosture: PermissionPosture): PermissionPosture[] {
  return [defaultPosture, ...permissionPostures.filter((posture) => posture !== defaultPosture)];
}

function profileValues(prior: Record<string, unknown>, profile: PermissionProfile): Record<string, unknown> {
  const profiles = prior.profiles;
  if (!isPlainObject(profiles) || !isPlainObject(profiles[profile])) return {};
  return profiles[profile];
}

export function computePermissionsPolicy(
  choices: Record<PermissionProfile, Record<PermissionCategory, PermissionPosture>>,
  prior: Record<string, unknown> = {},
): PermissionsPolicy {
  const existingProfiles = isPlainObject(prior.profiles) ? prior.profiles : {};
  return {
    ...prior,
    version: 1,
    activeProfile: isProfile(prior.activeProfile) ? prior.activeProfile : 'interactive',
    profiles: {
      ...existingProfiles,
      interactive: { ...profileValues(prior, 'interactive'), ...choices.interactive },
      unattended: { ...profileValues(prior, 'unattended'), ...choices.unattended },
    },
  } as PermissionsPolicy;
}

export function permissionsStep(): WizardStep {
  return {
    id: 'permissions',
    title: 'Permission posture',
    async run(ctx, io) {
      const policyFile = policyPath(ctx.homeDir, 'permissions');
      if (ctx.dryRun) {
        io.report(`dry-run — permissions: a real run would capture interactive and unattended guard postures and write ${policyFile}; nothing was prompted or written.`);
        return { id: 'permissions', status: 'skipped', summary: 'dry-run — permission posture prompting and policy write skipped' };
      }

      let prior: Record<string, unknown>;
      try {
        prior = readPriorPolicy(policyFile);
      } catch {
        return {
          id: 'permissions',
          status: 'failed',
          summary: 'existing permissions policy is corrupt — fix or remove ~/.heddle/policy/permissions.json',
        };
      }

      io.report('Choose a posture for each guard category. A pattern expected to fire more than a few times a day must not be ask; prompts are a limited budget.');
      const preset = await io.prompter.select('Safety preset', permissionPresets) as PermissionPreset;
      io.report(`${preset} preset selected; every choice below is editable.`);

      const choices = {
        interactive: {} as Record<PermissionCategory, PermissionPosture>,
        unattended: {} as Record<PermissionCategory, PermissionPosture>,
      };
      for (const profile of permissionProfiles) {
        for (const category of permissionCategories) {
          const presetDefault = presetPosture(preset, category);
          const coercedDefault = profile === 'unattended' && presetDefault === 'ask' ? 'block' : presetDefault;
          const defaultPosture = priorPosture(prior, profile, category) ?? coercedDefault;
          const selected = await io.prompter.select(`${profile}: ${category}`, promptChoices(defaultPosture)) as PermissionPosture;
          const posture = profile === 'unattended' && selected === 'ask' ? 'block' : selected;
          if (selected !== posture) {
            io.report(`${profile}: ${category}: ask was coerced to block because nothing may wait on an absent human.`);
          } else if (profile === 'unattended' && presetDefault === 'ask' && priorPosture(prior, profile, category) === undefined && selected === 'block') {
            io.report(`${profile}: ${category}: preset ask is pre-filled as block because nothing may wait on an absent human.`);
          }
          choices[profile][category] = posture;
          io.report(`${profile}: ${category}: ${posture}`);
        }
      }

      try {
        atomicWriteFile(policyFile, `${JSON.stringify(computePermissionsPolicy(choices, prior), null, 2)}\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { id: 'permissions', status: 'failed', summary: `could not write the permissions policy: ${message}` };
      }
      return {
        id: 'permissions',
        status: 'done',
        summary: `permission postures saved (${preset} preset; active profile ${isProfile(prior.activeProfile) ? prior.activeProfile : 'interactive'})`,
      };
    },
  };
}
