# Account registry

`~/.heddle/accounts.json` records the accounts available to heddle. Set `HEDDLE_ACCOUNTS` to use
another registry path.

## Schema

```json
{
  "schemaVersion": 2,
  "_doc": "Optional documentation; unknown top-level keys are tolerated.",
  "claude": [
    {
      "id": "glm",
      "configDir": "/Users/example/.claude-glm",
      "billingClass": "prepaid-credit",
      "tier": "T2",
      "fences": {
        "readOnlyEnforceable": true,
        "networkEnforceable": true,
        "cwdEnforceable": true
      },
      "overage": {
        "posture": "bounded-prepaid",
        "spendLimit": 25,
        "creditsRemaining": 12.5
      },
      "envRepoint": {
        "baseUrl": "https://api.z.ai/api/anthropic",
        "authTokenRef": "GLM_API_KEY",
        "service": "glm",
        "model": "glm-5.3"
      },
      "lastVerified": "2026-09-05T00:00:00Z",
      "notes": "GLM routing account",
      "orgId": "org-example",
      "accountUuid": "account-uuid"
    }
  ],
  "codex": [],
  "cursor": []
}
```

The sibling `claude[]`, `codex[]`, and `cursor[]` arrays are kept byte-compatible with the legacy
readers in `capaware.ts` and `rotation.ts`. `_doc`, `_doc_codex`, and other unknown top-level keys
are tolerated.

- `schemaVersion` is absent for a legacy registry, or exactly `2` for the current schema.
- `id` is the account identifier string.
- `provider` is derived from the sibling array and is not written.
- `harness` is an optional string; a missing or empty value uses the provider default.
- `credentialRef` is derived from the provider and its config location and is not written.
- `billingClass` is optional: `subscription-flat`, `subscription-quota`, `free-tier`,
  `prepaid-credit`, or `pay-per-token`.
- `tier` is optional: `T0`, `T1`, `T2`, or `T3`.
- `fences` is optional and, when present, contains exactly the boolean keys
  `readOnlyEnforceable`, `networkEnforceable`, and `cwdEnforceable`.
- `overage` is optional and contains `posture`: `hard-stop`, `bounded-prepaid`, or `open-billing`.
  `spendLimit` and `creditsRemaining` are finite non-negative numbers required only for
  `bounded-prepaid`.
- `envRepoint` is optional. Its `baseUrl` is an `https:` URL, or `http:` only for a loopback host
  (`localhost`, `127.0.0.1`, `::1`) — the loader refuses plaintext `http:` to a remote endpoint
  (`src/accounts.ts`). Its
  `authTokenRef` is a non-empty environment-variable name or keychain reference, and its `service`
  (the env-repoint provider key, e.g. `glm`) is required. `model` is optional; when set, the worker
  runs that model id. Unknown fields within `envRepoint` are tolerated and ignored by the loader.
- `lastVerified`, `notes`, `orgId`, `accountUuid`, `preferUntil`, and `email` are optional strings.
  `notes` falls back to legacy `note`.
- `loggedIn` is an optional boolean.
- `configDir` is the Claude config directory, `codexHome` is the Codex home directory, and `keyFile`
  is the Cursor key-file location. These optional provider-specific values are normalized to a string
  or `null` in the loaded account.

A missing registry file returns an empty registry. The loader fails loudly, naming the file path, for
a non-object root; invalid JSON or an unsupported `schemaVersion`; a present but non-array provider
value; an invalid `billingClass`, `tier`, `fences`, `overage`, or `envRepoint`; or duplicate IDs
within a provider. An id-less row is dropped with a stderr
warning. This makes an absent configuration fail-soft while surfacing hand-edit corruption.

## Security

`credentialRef` and `envRepoint.authTokenRef` hold only a configuration-directory, environment-variable
name, or keychain reference. They must never contain a token or other secret.

## Env-repoint accounts (GLM, Kimi, …) on the Claude harness

An env-repoint `claude[]` account runs another vendor's model through the Claude Code harness, with the
harness's tools. Add one with `heddle accounts add --provider <service>`. The token lives in
`~/.heddle/secrets.env` under the name in `authTokenRef`.

- **Family (HED-697).** A dispatch bound to the account (by `account_pin`, or by HED-531's automatic
  pick in an env-repoint-only registry) runs as its `service` and `model`, not as `claude`. Without a
  `model`, the service receives the route's concrete Claude model id and maps it to one of its own
  models, which heddle cannot see; the ledger then records the route alias (e.g. `glm/sonnet`). Set
  `model` so the record names the model that runs. `plan_dispatch` shows this identity as `runs_as`
  beside `would_run` (the route). Like `would_run`, it previews the PRIMARY: when the primary would
  capability-rebind to its fallback, the fallback is named in `remaining_fallback` instead (the HED-275
  preview boundary).
  These all judge that identity:
  - the HED-3 review guard, at plan time and again at spawn, so a fallback that re-binds the account is
    re-checked;
  - HED-519's headless opus/fable refusal;
  - the review row.

  So `adversarial-review` with `author_provider: claude`, `provider: claude` (any model, including the
  pool's `opus`) and `account_pin: <glm id>` is a genuine cross-family review, scored `claude → glm`.
  There is no family skill pack for these services, so the worker gets none (not the claude one either).
- **Selection (HED-698).** In a registry that also has a native Claude account, an env-repoint account
  is **pin-only**: pass `account_pin`. None of these ever lands on it:
  - the plan's automatic pick;
  - a fallback's re-pick;
  - account advice;
  - fleet batch placement;
  - the tier-presence check.

  So an exhausted native pool refuses, and the refusal counts the pin-only accounts, instead of silently
  running another family. A registry with only env-repoint accounts keeps using them automatically
  (HED-531).
- **Read-only reviewers** get Read/Grep/Glob only, with no shell or git (see `src/adapters/claude.ts`).
  Pass `diff_base` or embed the diff in the prompt.

## Moving a running session: `account pick --leaving`

`heddle account pick --leaving <account|config-dir|default> [--json] [--explain]` picks the account a
running Claude session should move to when it leaves the login it is on. Name that login by a registry
`id`, by `default` (the folder used when `CLAUDE_CONFIG_DIR` is unset, whose login `~/.claude.json`
holds), or by a config folder written the way `CLAUDE_CONFIG_DIR` would name it (a folder set that way
keeps its own `.claude.json`, so `--leaving ~/.claude` is not `--leaving default`). A plain `account
pick` takes the account with the most 5h headroom; this ranks **logins** instead:

- **One login, one candidate.** Config folders logged into the same login draw on one usage pool, so
  they are one candidate. A folder's login is its registry row's `accountUuid`, else its `email`; a
  folder the registry doesn't list (the default `~/.claude`, say), or a row recording neither, is told
  by the `oauthAccount` in its own `.claude.json`. A login known only by its email takes the
  `accountUuid` that email is paired with elsewhere (a registry row, or the `.claude.json` of a
  registered folder or the default one), when exactly one is, so one login reads alike whichever
  source told it. The login being left is never picked, whichever of its folders the session ran in.
- **Room.** A login's room is its headroom on the tighter of its two windows, by the tightest reading
  any of its folders has, and the pick reports that reading's `usedPct5h`, `usedPct7d` and `resetsAt`.
  A 5h window that resets within 30 minutes counts as empty while more than 15% is left on it, enough
  to carry the session to the reset. A window with 15% or less left gets no such credit, so a caller
  that moves sessions off an account at 85% of its 5h window is never handed one it would move straight
  off again.
- **Sessions already there.** The room is shared with the interactive sessions already running on the
  login. They come from the same live-process list as batch placement's census (`src/residents.ts`),
  counted per login rather than per registered account, so a session in a folder the registry doesn't
  list (the default one, say) counts toward that folder's login. The pick has the most room per seat,
  `room ÷ (weighted sessions + 1)`, then the most room, then the lowest account id. When the sessions
  can't be counted, it ranks on room alone and reports `residents: null`.
- **What rules a login out.** What is true of the shared pool takes the whole login out: a floored
  reading, overage billing, or a billing failure, on any of its folders, even when its 5h window resets
  soon. What is true of one folder (logged out, a dispatch signal that it lost its login, env-repoint
  pin-only) only rules out moving into that folder: the login is moved into through its first folder in
  registry order that isn't ruled out, and needs at least one reading.

The JSON is the single pick's shape plus `roomPct` and `residents` (the sessions counted on the
login). `--explain` adds every account, marking the ones on the login being left. It exits 2 when it
can't decide: usage readings missing or stale, a `--leaving` that names no login, or `--leaving` with
a multi-agent `--for`. It exits 1 when no other login has a usable account.
