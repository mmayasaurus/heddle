// HED-476: the setup wizard's FINISH step — run `heddle doctor` as read-only verification.
//
// The wizard's last step PROVES setup rather than claiming it: it runs the same full-system
// `heddle doctor` sweep and maps the report to a WizardStepResult for the finish screen. The sweep
// covers (per src/doctor.ts assembleChecks): each provider harness (binary present / logged in /
// model catalog), the routing + lanes + projects + accounts config, comms readiness, artifact drift
// (dashboard source vs installed), and provider catalog freshness. It does NOT check hook rules or
// skill packs — those wizard steps carry their own results.
//
// It verifies the REAL resolved environment, exactly as `heddle doctor` does: it passes NO path
// overrides, so each path resolves through runDoctor's own resolution — the HEDDLE_* env var where
// one exists, otherwise runDoctor's built-in default (routing/lanes under the repo; accounts/comms/
// operator-token under ~/.heddle). Relocating only some paths under ctx.homeDir would split the view
// (drift under one root, accounts under another); relocating all of them would diverge from what
// `heddle doctor` reports and clobber the operator's HEDDLE_* env. A hermetic test relocates the
// whole tree via injected doctorDeps.
//
// This is HED-564's read-only step: it makes NO config changes of its own. runDoctor is a read-only
// probe with one incidental exception — opening an EXISTING older comms.db applies the standard
// schema migration on construction (idempotent; a current-version db is a no-op; an absent db is not
// created). Because the sweep changes no config, re-running `heddle setup` (or `heddle doctor`)
// always reflects current truth rather than a one-time claim.
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
  /**
   * DoctorDeps overrides for a HERMETIC integration test — relocate the WHOLE config tree
   * (paths.{routing,lanes,projects,accounts,comms,operatorToken,heddle,repoRoot}) plus
   * execFile/readFileBytes/gitBehindOriginMain, so no real ~/.heddle is read and no binary is
   * spawned. The step imposes NO paths of its own; ctx.now still wins over any injected `now`
   * (the wizard owns the run clock).
   */
  doctorDeps?: Partial<DoctorDeps>;
}

/** Build the doctor finish-step. `injected` is for tests; production wires the exported `doctorStep`. */
export function createDoctorStep(injected: DoctorStepDeps = {}): WizardStep {
  const run = injected.runDoctor ?? realRunDoctor;
  return {
    id: 'doctor',
    title: 'Verify setup',
    // No `applies` — doctor is the finish gate, so it always runs. targetDir is unused (global sweep),
    // and homeDir is intentionally NOT used to relocate config (see the header): the step verifies the
    // real resolved environment like `heddle doctor`.
    async run(ctx: WizardContext, io: WizardIO): Promise<WizardStepResult> {
      try {
        // Verify the real resolved config: pass no path overrides (like `heddle doctor`). A hermetic
        // test threads the whole tree through doctorDeps; ctx.now stays authoritative (wizard clock),
        // spread AFTER doctorDeps so an injected `now` can never override the wizard's run clock.
        const report = await run({}, { ...injected.doctorDeps, now: () => ctx.now() });
        const text = formatDoctorReport(report);
        // WizardIO.report is a per-LINE progress sink — emit each table row, not one multi-line blob.
        for (const line of text.split('\n')) io.report(line);
        const { ok, warn, fail, skipped } = report.summary;
        const ran = ok + warn + fail;
        // ran===0 (nothing verified) maps to `failed`, not a hollow-green `done` — a finish screen that
        // keys off status (not the prose) must never paint success when nothing was proven. This branch
        // is unreachable with the real runDoctor (configChecks pushes 4 unconditional ok/fail
        // definitions → ran>=4); the guard covers the injected-runner / degenerate-report path.
        const status: WizardStepStatus = fail > 0 || ran === 0 ? 'failed' : 'done';
        const skippedSuffix = skipped > 0 ? ` (${skipped} skipped)` : '';
        const summary =
          fail > 0
            ? `setup NOT proven — ${fail} check(s) failing (${ok} ok, ${warn} warn, ${skipped} skipped)`
            : ran === 0
              ? `setup NOT verified — no checks ran${skippedSuffix}`
              : warn > 0
                ? `setup verified with ${warn} warning(s) (${ok} ok, ${skipped} skipped)`
                : skipped > 0
                  ? `setup verified — ${ok} checks pass (${skipped} skipped)`
                  : `setup verified — all ${ok} checks pass`;
        return { id: 'doctor', status, summary, detail: text };
      } catch (error) {
        // A thrown doctor run must not abort the wizard — report it as a failed verification instead.
        // Stringify defensively: a non-Error throwable (a null-prototype object, a Symbol) can make
        // String() itself throw, which would break the very "never aborts" guarantee this catch exists
        // for — so the conversion is itself wrapped.
        let detail: string;
        try {
          detail = error instanceof Error ? error.message : String(error);
        } catch {
          detail = 'a non-Error value was thrown';
        }
        return { id: 'doctor', status: 'failed', summary: `verification could not run: ${detail}`, detail };
      }
    },
  };
}

/** The production step (real runDoctor). HED-564's setup.ts wires this into the STEPS array. */
export const doctorStep: WizardStep = createDoctorStep();
