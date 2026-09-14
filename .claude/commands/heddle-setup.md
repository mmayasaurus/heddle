<!-- HED-572 (HED-400 D12) — WIP skeleton. The conversational SKIN over the `heddle setup` CLI wizard
     (HED-564, CLI-only). Framing/flow below is surface-independent; the exact `heddle setup` flag
     spelling + the `--answers` file schema FIRM when Y locks the CLI surface (see the design note).
     Do NOT merge until `heddle setup` has landed on main and the surface is locked. -->
# heddle setup — guided onboarding

`/heddle-setup` walks a newcomer through connecting their coding-CLI accounts and configuring heddle
end-to-end, then verifies the result. It is the conversational front-end over the `heddle setup` CLI
wizard, which owns the actual config writes (idempotent, merge-preserving). This command's job is to
make the walkthrough friendly, gather the answers, drive the CLI, and report exactly what changed —
never to write config itself.

## What it sets up
The full walkthrough — each step owns its own idempotent write, so re-running is safe:
- **Accounts.** For each service (Claude, Codex, Gemini/agy, Cursor, GLM, OpenRouter, Groq/Cerebras,
  Kimi, Grok, …): connect one account, then loop to add more for heddle to cycle through. Per account,
  record paid-or-free and which plan (→ billing class + tier). **Login is preferred**; using an API key
  for a service that has a login path is a deliberate, confirmed choice, never a default.
- **Model economy**, **spread / rotation**, **meters (opt-in)**, **init-project rules**, and a closing
  **`heddle doctor`** for each account.

## How to run it — a hybrid conversational skin
`heddle setup` is an interactive CLI, and vendor LOGIN flows need a real terminal the agent does not
own. So drive it as a hybrid, never by trying to type into a live interactive prompt from a tool call:

1. **Orient.** Tell the user what will happen (the services above), and that any vendor logins happen
   in their own terminal.
2. **Gather answers conversationally** for the non-login choices — which services, paid/free + plan per
   account, model-economy / rotation / meters preferences, and any provider/model not on the list.
   Do not invent defaults; echo every chosen value back for confirmation.
3. **Preview.** Persist the gathered answers to an answers file and run `heddle setup --dry-run` against
   it — relay the planned per-step writes, and confirm with the user before anything is applied.
4. **Apply.** Run `heddle setup` against the answers to apply. For any step that needs a vendor login
   (a real TTY), hand off: give the user the exact login command to run in their terminal (`! <cmd>`),
   wait, then continue.
5. **Report the finish screen** — the per-step summary `heddle setup` emits (done / skipped / failed)
   and its exit code (0 = all done or skipped; non-zero = at least one step failed — name which).
6. **Verify.** The walkthrough closes with `heddle doctor`; relay its verdict.

Subset / override flags exist for re-runs and repair (run only or skip specific steps, preview without
writing, and home/target overrides for tests) — surface the relevant one when a user wants to redo just
one part rather than the whole walkthrough.

## Report
A short summary, not a transcript: which accounts were connected (by service — **never echo a secret or
key value**), the model-economy / rotation / meters choices made, and the `heddle doctor` verdict. Name
anything that failed or was skipped, and the single next action to finish it.
