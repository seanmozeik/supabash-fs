# Postgres SQL assets

`0001_install.sql` is a fresh install. There is no in-place upgrade from a 0.4.x install; remove the old one first. Run it as the Supabase database owner. Run `0001_remove.sql` to remove all package-owned database objects. Removal does not remove the shared `pgcrypto` extension. `pgcrypto` is the only extension the install needs. It needs no `pgsodium`, no `supabase_vault`, and no custom extension, so it replays on a stock Supabase PostgreSQL 17 project and on plain PostgreSQL 17.

The install creates the private `supabash` schema and the `supabash_api` execution role. Authenticated and service-role callers have no table access. Authenticated workspace RPCs derive the owner only from the verified JWT subject. Service-role workspace RPCs require an opaque delegated grant that is bound to one owner, signed actor subject, workspace, operation set, correlation ID, and expiry.

## Delegated verification secrets

A Postgres capability is a compact JWS signed with HMAC-SHA256. The database is its only verifier, so the signing secret is shared between the minting host and the database and is never given to the job that presents the capability.

The secret lives in `supabash.capability_secrets`. No role is granted anything on that table. Row level security is enabled on it but deliberately not forced, so the installing owner keeps access while every other role is denied by grants and by the absence of any policy. The only path to the secret is `supabash.capability_signature_valid`, which keeps its definer rights with the installing owner and returns a boolean, never the secret.

The boundary therefore rests only on grants this package owns. Forging a capability needs the minting host's secret, database-owner access, or a copy of the database. No PostgREST role can read the secret.

`supabase_vault` is not used. On a stock Supabase project `service_role` holds `select` and `delete` on `vault.secrets` and `vault.decrypted_secrets` and `execute` on `vault.create_secret` and `vault.update_secret`. A live install proved it. The vault would therefore give this secret no protection from the one role the capability system exists to constrain, and the only thing that would stand between `service_role` and the secret is the PostgREST exposed-schema setting, which this package does not control. Revoking the platform's own grants would be fragile, because a platform upgrade can restore them.

Unlike the Ed25519 scheme it replaces, the signing secret is now inside the database, so a database dump contains it. Anyone holding a dump can mint capabilities for any workspace. Rotation is the answer to a suspected dump leak: call the registration function again for the same `p_key_id`, then reload the minting host's environment.

Register a key as the database owner. The database mints the secret and returns it exactly once, so no caller writes a secret into SQL statement text:

```sql
select public.supabash_register_capability_verifier(
  p_key_id => 'k1',
  p_issuer => 'https://issuer.example',
  p_audience => 'supabash-jobs',
  p_origin => 'https://project.example'
);
```

Put the returned value in the minting host's environment, for example `supabase secrets set SUPABASH_CAPABILITY_SECRET=<value>`. Do not commit it. Rotating is the same call: it overwrites the stored secret in place and returns the new value. Adding a second `p_key_id` lets both secrets verify while hosts roll over. `select public.supabash_revoke_capability_verifier('k1')` deletes the key, and its secret follows through a foreign key cascade.

Both functions are revoked from `public`, `anon`, `authenticated`, and `service_role`. Only the database owner can call them, from a migration or `psql`. `supabash.capability_verifiers` forces row level security, so the install also creates a policy that admits the installing owner by name. That keeps registration working on an owner that has no `bypassrls`.

The install asserts its own boundary. It refuses to run when `anon`, `authenticated`, or `service_role` holds any privilege on `supabash.capability_secrets`, or `usage` on the `supabash` schema.

`supabash_exchange_capability` accepts a compact `HS256` JWS with schema version 3 and these claims: `aud`, `backend: "postgres"`, `corr`, `exp`, `iat`, `iss`, `nonce`, `ops`, `origin`, `sub`, `sv: 3`, and `workspace`. It consumes the nonce and returns one opaque short-lived grant. The database stores only the grant hash.

That RPC is owned by `supabash_api`, which holds no privilege on `supabash.capability_secrets`, so it never sees the secret. It calls `supabash.capability_signature_valid(key_id, signing_input, signature)`, which keeps its definer rights with the installing database owner, reads the one secret for that key, recomputes the MAC with `extensions.hmac`, compares it under a fresh random blind so the comparison leaks no prefix, and returns only a boolean. Its execute privilege is revoked from `public`, `anon`, `authenticated`, and `service_role`, and the `supabash` schema is not exposed to PostgREST.

The `sub` claim is a bounded nonempty actor subject. It does not select the workspace owner. The verified `workspace` claim selects the exact workspace, and the database derives its owner after signature verification. Delegated commit receipts use `delegated:<sub>` as the actor and a SHA-256 scope digest instead of the workspace UUID.

Every workspace RPC has an optional final `p_delegated_grant` argument. Authenticated calls omit it. A service-role call must supply it, and the grant must allow the required operation on the exact workspace.

The database owner can change safety quotas in the single row of `supabash.settings`. The defaults do not impose a document-count limit.
