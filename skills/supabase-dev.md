Working with Supabase in this project — READ BEFORE any DB, migration, or edge-function work.

- **🚫 NEVER touch production Supabase — EVER.** Prod (`aefsmsaokvpysqutphko`) is the currently-live
  site with 600+ real users. Operate ONLY on the dev project (`oiicdltxmqcokealfwbj`, the
  `supabase-dev` MCP).
- **There is NO dev→prod migration.** Launch = switching the live site OVER to the dev project, not
  migrating dev into prod. Any doc describing a dev→prod migration (e.g. `PROD_MIGRATION_CHECKLIST.md`)
  is WRONG — never reference or follow it.
- **The dev schema is frozen.** Do NOT invent, add, or alter tables/columns speculatively. New schema
  lands only after Maya has explicitly approved it. If a task seems to need new schema, STOP and say
  so in your result rather than creating it.
- Realtime: dev cannot verify ES256 signing-key JWTs, so presence/realtime runs through Ably, not
  Supabase Realtime. Don't wire presence to Supabase channels.
- Never print or commit secrets (service-role keys, DB passwords, connection strings). Env vars only.
- If you write SQL or a migration file, keep it reversible and scoped to the task; report exactly what
  it changes. Do not run destructive statements (DROP/DELETE/TRUNCATE) without explicit per-item
  approval surfaced in your result first.
