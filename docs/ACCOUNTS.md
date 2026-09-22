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
- `envRepoint` is optional. Its `baseUrl` is a non-empty `http:` or `https:` URL, its
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
  pick in an env-repoint-only registry) runs as its `service` and `model`, not as `claude`. These all
  judge that identity:
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
