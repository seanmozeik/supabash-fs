# Postgres SQL assets

Run `0001_install.sql` as the Supabase database owner. Run `0001_remove.sql` to remove all package-owned database objects. Removal does not remove the shared `pgcrypto` extension. The install needs `pgcrypto` and, at capability-exchange time, `supabase_vault`. It needs no `pgsodium` and no custom extension, so it replays on a stock Supabase PostgreSQL 17 project.

The install creates the private `supabash` schema and the `supabash_api` execution role. Authenticated and service-role callers have no table access. Authenticated workspace RPCs derive the owner only from the verified JWT subject. Service-role workspace RPCs require an opaque delegated grant that is bound to one owner, signed actor subject, workspace, operation set, correlation ID, and expiry.

## Delegated verification secrets

A Postgres capability is a compact JWS signed with HMAC-SHA256. The database is its only verifier, so the signing secret is shared between the minting host and the database and is never given to the job that presents the capability. The secret lives in `supabase_vault`. `vault.decrypted_secrets` is not in a PostgREST-exposed schema and carries no grants to `anon`, `authenticated`, or `service_role`, so no REST caller can read it.

Register a key as the database owner. The function generates the secret when you do not supply one and returns it exactly once:

```sql
select public.supabash_register_capability_verifier(
  p_key_id => 'k1',
  p_issuer => 'https://issuer.example',
  p_audience => 'supabash-jobs',
  p_origin => 'https://project.example'
);
```

Put the returned value in the minting host's environment, for example `supabase secrets set SUPABASH_CAPABILITY_SECRET=<value>`. Do not commit it. Rotating is the same call: it overwrites the vault secret in place and returns the new value. Adding a second `p_key_id` lets both secrets verify while hosts roll over. `select public.supabash_revoke_capability_verifier('k1')` deletes the row and its vault secret.

Both functions are revoked from `public`, `anon`, `authenticated`, and `service_role`. Only the database owner can call them, from a migration or `psql`.

`supabash_exchange_capability` accepts a compact `HS256` JWS with schema version 3 and these claims: `aud`, `backend: "postgres"`, `corr`, `exp`, `iat`, `iss`, `nonce`, `ops`, `origin`, `sub`, `sv: 3`, and `workspace`. It consumes the nonce and returns one opaque short-lived grant. The database stores only the grant hash.

That RPC is owned by `supabash_api`, which has no vault access, so it never sees the secret. It calls `supabash.capability_signature_valid(secret_name, signing_input, signature)`, which keeps its definer rights with the installing database owner, reads one vault secret, recomputes the MAC with `extensions.hmac`, compares it under a fresh random blind so the comparison leaks no prefix, and returns only a boolean. The name must carry the `supabash_capability_` prefix that the `secret_name` column constraint already enforces, so the function cannot be steered at an unrelated vault secret. Its execute privilege is revoked from `public`, `anon`, `authenticated`, and `service_role`, and the `supabash` schema is not exposed to PostgREST.

The `sub` claim is a bounded nonempty actor subject. It does not select the workspace owner. The verified `workspace` claim selects the exact workspace, and the database derives its owner after signature verification. Delegated commit receipts use `delegated:<sub>` as the actor and a SHA-256 scope digest instead of the workspace UUID.

Every workspace RPC has an optional final `p_delegated_grant` argument. Authenticated calls omit it. A service-role call must supply it, and the grant must allow the required operation on the exact workspace.

The database owner can change safety quotas in the single row of `supabash.settings`. The defaults do not impose a document-count limit.
