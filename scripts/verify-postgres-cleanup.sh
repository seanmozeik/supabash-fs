#!/usr/bin/env bash
set -euo pipefail

: "${SUPABASH_TEST_DATABASE_CONTAINER:?Set SUPABASH_TEST_DATABASE_CONTAINER.}"

readonly database_container="$SUPABASH_TEST_DATABASE_CONTAINER"
readonly edge_container="${SUPABASH_TEST_EDGE_CONTAINER:-supabash-postgres-integration-edge}"
readonly deno_container="${SUPABASH_TEST_DENO_CONTAINER:-supabash-postgres-integration-deno}"
readonly deno_cache_volume="${SUPABASH_TEST_DENO_CACHE_VOLUME:-supabash-postgres-integration-deno-cache}"
readonly edge_cache_volume="${SUPABASH_TEST_EDGE_CACHE_VOLUME:-supabash-postgres-integration-edge-cache}"

query() {
  docker exec "$database_container" psql -U postgres -d postgres -Atqc "$1" 2>/dev/null
}

schema_count="$(query "select count(*) from pg_namespace where nspname in ('supabash', 'supabash_test')")"
function_count="$(query "select count(*) from pg_proc join pg_namespace on pg_namespace.oid = pg_proc.pronamespace where pg_namespace.nspname = 'public' and pg_proc.proname like 'supabash_%'")"
role_count="$(query "select count(*) from pg_roles where rolname like 'supabash%'")"
auth_user_count="$(query "select count(*) from auth.users where email like 'supabash-postgres-test-%@example.test'")"
container_count="$(
  docker ps -a --format '{{.Names}}' |
    awk -v edge="$edge_container" -v deno="$deno_container" '$0 == edge || $0 == deno { count++ } END { print count + 0 }'
)"
volume_count="$(
  docker volume ls --format '{{.Name}}' |
    awk -v deno="$deno_cache_volume" -v edge="$edge_cache_volume" '$0 == edge || $0 == deno { count++ } END { print count + 0 }'
)"

if [[ "$schema_count" == 0 && "$function_count" == 0 && "$role_count" == 0 && "$auth_user_count" == 0 && "$container_count" == 0 && "$volume_count" == 0 ]]; then
  overall_clean=true
else
  overall_clean=false
fi

printf '{"checkedAt":"%s","schemaCount":%s,"publicFunctionCount":%s,"roleCount":%s,"syntheticAuthUserCount":%s,"containerCount":%s,"volumeCount":%s,"overallClean":%s}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  "$schema_count" \
  "$function_count" \
  "$role_count" \
  "$auth_user_count" \
  "$container_count" \
  "$volume_count" \
  "$overall_clean"

[[ "$overall_clean" == true ]]
