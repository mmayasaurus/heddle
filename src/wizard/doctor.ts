// HED-476: the setup wizard's FINISH step — run `heddle doctor` as read-only verification.
//
// The wizard's last step PROVES setup rather than claiming it: it runs the same full-system
// `heddle doctor` sweep and maps the report to a WizardStepResult for the finish screen. The sweep
// covers (per src/doctor.ts assembleChecks): each provider harness (binary present / logged in /
// model catalog), the routing + lanes + projects + accounts config, comms readiness, artifact drift
// (dashboard source vs installed), and provider catalog freshness. It does NOT check hook rules or
// skill packs — those wizard steps carry their own results.
//
// In the composed wizard flow, the finish step re-roots the ONE config path the sweep verifies that
// setup also writes — the account registry — under ctx.homeDir, honoring HEDDLE_ACCOUNTS first exactly
// as accountsStep does (see homePaths). That verifies the registry setup wrote under --home. Every
// other doctor path keeps its standard env→homedir resolution: comms.db / operator token / projects
// are not written by `heddle setup` (they come from `heddle comms init` / `heddle init-project`) and
// their runtime consumers are homedir- or env-fixed — the operator token especially is a fixed trust
// root the comms server only reads at ~/.heddle/operator.token, so re-rooting it would verify a token
// the server can never read. Standalone `heddle doctor` (runDoctor via the CLI, not this step) is
// unchanged. Routing and lanes are repo-scoped config-as-code and are never re-rooted.
//
// This is HED-564's read-only step: it makes NO config changes of its own. runDoctor is a read-only
// probe with one incidental exception — opening an EXISTING older comms.db applies the standard
// schema migration on construction (idempotent; a current-version db is a no-op; an absent db is not
// created). Because the sweep changes no config, re-running `heddle setup` (or `heddle doctor`)
// always reflects current truth rather than a one-time claim.
import { join } from 'node:path';
import type { WizardStep, WizardContext, WizardIO, WizardStepResult, WizardStepStatus } from './step.js';
import { runDoctor as realRunDoctor, formatDoctorReport, type DoctorReport, type DoctorDeps } from '../doctor.js';

/**
 * The home-scoped doctor path override for the composed setup wizard's finish gate.
 *
 * Of everything `heddle setup` writes, the account registry is the ONLY path the doctor sweep also
 * verifies: comms.db + operator.token come from `heddle comms init`, projects.json from
 * `heddle init-project`, and the policy/*.json files aren't checked by doctor at all. accountsStep —
 * and the spread/meters readers — resolve that registry as
 * `HEDDLE_ACCOUNTS ?? join(<homeDir>, '.heddle', 'accounts.json')` (src/wizard/accounts-add.ts
 * registryPath), so the gate mirrors that EXACT resolution and verifies the registry setup actually
 * wrote under `--home`. Every OTHER doctor path keeps its standard env→homedir resolution
 * (resolveDoctorPaths): re-rooting them would make doctor check a path the runtime never reads — the
 * operator token especially is a FIXED trust root the comms server only reads at OPERATOR_TOKEN_PATH.
 * `env` is passed in (never read from process.env here) so it always matches the doctor's own
 * `deps.env`, which resolveDoctorPaths reads for the same var.
 */
export function homePaths(home: string, env: NodeJS.ProcessEnv): Partial<DoctorDeps['paths']> {
  // Mirror accounts-add.ts registryPath verbatim: `??` (so an empty HEDDLE_ACCOUNTS resolves the same
  // path the writer used, not the default) over a literal join with no dependence on the process home.
  return { accounts: env.HEDDLE_ACCOUNTS ?? join(home, '.heddle', 'accounts.json') };
}

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
   * DoctorDeps overrides for a HERMETIC integration test. Injected paths win over the composed
   * step's home-scoped base paths; ctx.now still wins over any injected `now` (the wizard owns the
   * run clock).
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
    // while homeDir re-roots only the account registry the sweep verifies (see the header).
    async run(ctx: WizardContext, io: WizardIO): Promise<WizardStepResult> {
      // The verification itself is the ONLY failure that means "could not verify", so its catch is
      // scoped to just the runDoctor call — a later progress-reporting error must never be
      // misattributed as a verification failure (a real report would then be silently swallowed).
      let report: DoctorReport;
      try {
        // Verify the account registry the composed wizard wrote under ctx.homeDir. homePaths reads the
        // SAME env the doctor resolves against (deps.env defaults to process.env — src/doctor.ts), so
        // its HEDDLE_ACCOUNTS-first resolution matches accountsStep's. Hermetic path overrides still
        // win over the home-scoped base; ctx.now remains authoritative for the wizard's run clock.
        report = await run({}, {
          ...injected.doctorDeps,
          paths: { ...homePaths(ctx.homeDir, injected.doctorDeps?.env ?? process.env), ...injected.doctorDeps?.paths },
          now: () => ctx.now(),
        });
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

      // Verification succeeded. Emit the report as progress (best-effort: a throwing io.report must
      // neither abort the wizard NOR be misreported as a verification failure — the verified result
      // below is what matters). WizardIO.report is a per-LINE sink, so emit each table row.
      const text = formatDoctorReport(report);
      try {
        for (const line of text.split('\n')) io.report(line);
      } catch {
        // progress output is best-effort; swallow so a broken reporter can't corrupt a real result.
      }
      // Pure mapping (cannot throw): map the report summary to the finish-screen result.
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
    },
  };
}

/** The production step (real runDoctor). HED-564's setup.ts wires this into the STEPS array. */
export const doctorStep: WizardStep = createDoctorStep();
