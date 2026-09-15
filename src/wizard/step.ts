// HED-564: the frozen step-registration contract for the top-level `heddle setup` wizard.
//
// Each onboarding step (accounts, model-economy, spread/rotation, meters, rules, doctor) is a
// self-contained module that exports a `WizardStep`. The `heddle setup` orchestrator (src/wizard/setup.ts)
// holds an ordered array of steps and runs each in turn, collecting a `WizardStepResult` for the finish
// screen. Steps own their OWN config write (idempotent, merge-preserving, atomic) and NEVER edit the
// orchestrator or each other — so step modules stay on disjoint files and land in parallel.
//
// This file is intentionally types-only and stable: step owners import it to type their export.
import type { Prompter } from './prompt.js';

/** Terminal I/O available to a step: the interactive/scripted prompter and a progress reporter. */
export interface WizardIO {
  prompter: Prompter;
  /** Emit a human-visible progress line (stderr). */
  report(line: string): void;
}

export type WizardStepStatus = 'done' | 'skipped' | 'failed';

/**
 * What a step reports back to the orchestrator for the finish screen and for later steps to read.
 * Immutable: fields are `readonly` and prior results reach later steps through a `ReadonlyMap`
 * (see `WizardContext.results`), so a step can never rewrite an earlier step's reported result.
 */
export interface WizardStepResult {
  readonly id: string;
  readonly status: WizardStepStatus;
  /** One-line, human-readable summary — always echo the chosen value (never a silent default). */
  readonly summary: string;
  /** Optional multi-line detail. */
  readonly detail?: string;
}

/** Shared, read-only context passed to every step. A step writes its own config; it does not mutate this. */
export interface WizardContext {
  /** The operator's home root (~). Account registry, `routing/lanes.yaml`, etc. resolve under here / the repo. */
  homeDir: string;
  /** The project directory for init-project-scoped steps; undefined for global-only steps. */
  targetDir?: string;
  /** Injectable clock so steps are deterministic under test. */
  now(): Date;
  /**
   * Prior steps' results, keyed by step id — for pre-fill and conditional skip. Values are
   * immutable: a step reads a prior result but never rewrites it.
   */
  results: ReadonlyMap<string, Readonly<WizardStepResult>>;
}

/** One step in the setup walkthrough. Exported by each step module; wired into the orchestrator by HED-564. */
export interface WizardStep {
  /** Stable kebab id, e.g. 'accounts' | 'model-economy' | 'spread' | 'meters' | 'rules' | 'doctor'. */
  id: string;
  /** Walkthrough header shown to the operator, e.g. "Model economy". */
  title: string;
  /** Whether this step applies in the current context (default: always). */
  applies?(ctx: WizardContext): boolean;
  /** Prompt, write this step's config, and return a summary. Must be idempotent + merge-preserving. */
  run(ctx: WizardContext, io: WizardIO): Promise<WizardStepResult>;
}
