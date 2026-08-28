# Postgres SQL assets

Run `0001_install.sql` as the Supabase database owner. Run `0001_remove.sql` to remove all package-owned database objects. Removal does not remove the shared `pgcrypto` or `pgsodium` extensions.

The install creates the private `supabash` schema and the `supabash_api` execution role. Authenticated and service-role callers have no table access. Authenticated workspace RPCs derive the owner only from the verified JWT subject. Service-role workspace RPCs require an opaque delegated grant that is bound to one owner, signed actor subject, workspace, operation set, correlation ID, and expiry.

## Delegated verification keys

The install does not create a key-registration RPC. A database owner must add each active Ed25519 public key directly:

```sql
insert into supabash.capability_verifiers (
  key_id,
  public_key,
  issuer,
  audience,
  origin
) values (
  'key-id',
  supabash.base64url_decode('base64url-public-key'),
  'issuer',
  'audience',
  'https://project.example'
);
```

`supabash_exchange_capability` accepts a compact EdDSA JWS with schema version 2 and these claims: `aud`, `backend: "postgres"`, `corr`, `exp`, `iat`, `iss`, `nonce`, `ops`, `origin`, `sub`, `sv: 2`, and `workspace`. It verifies the protected JWS with `pgsodium`, consumes the nonce, and returns one opaque short-lived grant. The database stores only the grant hash.

The `sub` claim is a bounded nonempty actor subject. It does not select the workspace owner. The verified `workspace` claim selects the exact workspace, and the database derives its owner after signature verification. Delegated commit receipts use `delegated:<sub>` as the actor and a SHA-256 scope digest instead of the workspace UUID.

Every workspace RPC has an optional final `p_delegated_grant` argument. Authenticated calls omit it. A service-role call must supply it, and the grant must allow the required operation on the exact workspace.

The database owner can change safety quotas in the single row of `supabash.settings`. The defaults do not impose a document-count limit.
