# heddle setup — guided onboarding

`/heddle-setup` is the friendly, conversational front-end over the `heddle setup` CLI wizard. The
CLI owns every config write (idempotent, merge-preserving, atomic per step) and the `heddle doctor`
verification. This command's job is to orient a newcomer, preview what will happen, hand off the
interactive run, and interpret the result — it never writes config itself and never types into a
live prompt.

## What `heddle setup` walks through
The conceptual flow below is the intent; the **live** step list for this build is whatever
`heddle setup --json --dry-run` prints (see step 2) — trust that over this list. Each step owns its
own idempotent write, so re-running the walkthrough is always safe.

- **Accounts.** The wizard walks each service this build supports. **Claude, Codex, and Cursor**
  connect through the vendor's own **login**; for each you can loop to add more accounts for heddle to
  cycle through, recording paid-or-free and a plan tier per account. It also offers **keyed providers**
  you connect by naming an environment variable that holds your key (e.g. GLM), flags providers that
  aren't wired up yet as "coming", and closes with a **custom provider** option for anything not
  listed. The exact set offered is whatever the wizard prompts for — that is the source of truth.
- **Model economy**, **spread / rotation**, **meters (opt-in)**, and **init-project rules**.
- A closing **`heddle doctor`** gate that verifies the configured environment end-to-end.

## How to run it — guide the interactive CLI, don't drive it
`heddle setup` prompts interactively (readline), and its vendor **login** flows need a real terminal
the agent does not own. So never try to pre-fill answers or type into the prompts from a tool call.
(The `--answers` flag exists, but it is a *positional* scripted-prompt array meant for tests and
automation — it cannot express the per-service "add another?" loops a real person walks, so it is the
wrong tool for a conversational run. Don't reach for it here.) Instead, guide the user through their
own run:

1. **Orient.** Tell the user what the wizard will ask (the flow above), and that any vendor logins
   open in their own terminal.
2. **Preview — read-only.** Run `heddle setup --json --dry-run`. The per-step plan comes back as a
   JSON array on **stdout** (`id` / `status` / `summary`); the human-readable finish screen goes to
   **stderr**. Nothing is written. Relay what a real run would do and confirm the user wants to go on.
3. **Hand off the interactive run.** Have the user run `heddle setup` themselves — the readline
   prompts and the vendor logins need a terminal you don't own. The best path is to have them type
   `! heddle setup` at the prompt, which runs it in this session so the output lands back in the
   conversation for you to read and relay. If the prompts don't render interactively that way, have
   them run `heddle setup` directly in their own terminal and paste the finish screen back. (Testing
   against a throwaway install? add `--home <dir>` and/or `--target <dir>`.)
4. **Relay the finish screen.** `heddle setup` prints a per-step summary — `✓` done / `–` skipped /
   `✗` failed — to stderr, and exits `0` only when every step is done or skipped; a non-zero exit
   means at least one step **failed**. Name which failed, and surface the exact re-run it prints
   (`heddle setup --only <id>`).
5. **Verify.** The wizard's closing step runs `heddle doctor`. If it was skipped (a `--dry-run`
   preview, an alternate `--home`, or `--skip doctor`), run `heddle doctor` now and relay its verdict
   so "setup complete" is a checked claim, not an assumption.
6. **Repair a single step.** To redo just one part rather than the whole walkthrough, use
   `heddle setup --only <id>` (run only these steps) or `--skip <id>` (run all but these) — comma-
   separate ids, and take the ids from the `--json --dry-run` plan. `--only` and `--skip` are
   mutually exclusive.

## Report
A short summary, not a transcript: which accounts were connected (**by service — never echo a secret
or key value**), the model-economy / rotation / meters choices made, and the `heddle doctor` verdict.
Name anything that failed or was skipped, and the single next action to finish it.
