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
        "authTokenRef": "GLM_API_KEY"
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
- `envRepoint` is optional. Its `baseUrl` is a non-empty `http:` or `https:` URL and its
  `authTokenRef` is a non-empty environment-variable name or keychain reference. Unknown fields
  within `envRepoint` are tolerated and ignored by the loader.
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
