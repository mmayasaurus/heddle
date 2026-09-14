// HED-476: the setup wizard's FINISH step — run `heddle doctor` as read-only verification.
//
// The wizard's last step PROVES setup is complete (never claims it): it runs the same full-system
// `heddle doctor` sweep (accounts/logins, MCP + comms, hooks, packs, gate mappings, artifact drift)
// and maps the report to a WizardStepResult for the finish screen. It is the read-only EXCEPTION to
// HED-564's "each step owns its config write" rule — this step WRITES NOTHING; runDoctor only reads.
// "Re-runnable forever" follows from that: the whole sweep is side-effect-free, so re-running
// `heddle setup` (or `heddle doctor`) always reflects current truth rather than a one-time claim.
import { join } from 'node:path';
import type { WizardStep, WizardContext, WizardIO, WizardStepResult, WizardStepStatus } from './step.js';
import { runDoctor as realRunDoctor, formatDoctorReport, type DoctorReport, type DoctorDeps } from '../doctor.js';

/**
 * WizardStep.run carries `ctx.now` but NOT doctor's execFile/gitBehindOriginMain/paths seams, so a
 * test needs a seam the interface doesn't provide. Inject the doctor runner (default: the real one) —
 * production wiring uses the bare `doctorStep`; tests pass a canned-report fn. This keeps the step
 * module self-contained and standalone-callable (HED-564).
 */
export interface DoctorStepDeps {
  /** Override the doctor runner (tests return a canned report; default = the real runDoctor). */
  runDoctor?: (opts: { provider?: string }, partial: Partial<DoctorDeps>) => Promise<DoctorReport>;
  /** Extra DoctorDeps overrides (paths/env/execFile) for integration tests; the step's own paths.heddle wins unless overridden. */
  doctorDeps?: Partial<DoctorDeps>;
}

/** Build the doctor finish-step. `injected` is for tests; production wires the exported `doctorStep`. */
export function createDoctorStep(injected: DoctorStepDeps = {}): WizardStep {
  const run = injected.runDoctor ?? realRunDoctor;
  return {
    id: 'doctor',
    title: 'Verify setup',
    // No `applies` — doctor is the finish gate, so it always runs. targetDir is unused (global sweep).
    async run(ctx: WizardContext, io: WizardIO): Promise<WizardStepResult> {
      try {
        const { paths: pathsOverride, ...restDeps } = injected.doctorDeps ?? {};
        const report = await run(
          {},
          {
            now: () => ctx.now(),
            ...restDeps,
            // ctx.homeDir is the wizard's source of truth for ~ (in production === homedir(), so
            // doctor's env/default-resolved routing/accounts/... paths line up); the rest of DoctorDeps
            // fills in inside runDoctor. An explicit doctorDeps.paths (integration tests) still wins.
            paths: { heddle: join(ctx.homeDir, '.heddle'), ...pathsOverride },
          },
        );
        const text = formatDoctorReport(report);
        io.report(text);
        const { ok, warn, fail, skipped } = report.summary;
        const status: WizardStepStatus = fail > 0 ? 'failed' : 'done';
        const summary =
          fail > 0
            ? `setup NOT proven — ${fail} check(s) failing (${ok} ok, ${warn} warn, ${skipped} skipped)`
            : warn > 0
              ? `setup verified with ${warn} warning(s) (${ok} ok, ${skipped} skipped)`
              : `setup verified — all ${ok} checks pass`;
        return { id: 'doctor', status, summary, detail: text };
      } catch (error) {
        // A thrown doctor run must not abort the wizard — report it as a failed verification instead.
        const detail = error instanceof Error ? error.message : String(error);
        return { id: 'doctor', status: 'failed', summary: `verification could not run: ${detail}`, detail };
      }
    },
  };
}

/** The production step (real runDoctor). HED-564's setup.ts wires this into the STEPS array. */
export const doctorStep: WizardStep = createDoctorStep();
