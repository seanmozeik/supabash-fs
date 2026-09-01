#!/usr/bin/env bash
set -Eeuo pipefail

readonly repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

: "${SUPABASH_TEST_SUPABASE_ROOT:?Set SUPABASH_TEST_SUPABASE_ROOT.}"
: "${SUPABASH_TEST_DATABASE_CONTAINER:?Set SUPABASH_TEST_DATABASE_CONTAINER.}"
: "${SUPABASH_TEST_EDGE_MAIN_FILE:?Set SUPABASH_TEST_EDGE_MAIN_FILE to the Edge Runtime main-service loader.}"

readonly supabase_root="$SUPABASH_TEST_SUPABASE_ROOT"
readonly database_container="$SUPABASH_TEST_DATABASE_CONTAINER"
readonly install_sql="${SUPABASH_POSTGRES_INSTALL_SQL:-$repo_root/sql/postgres/0001_install.sql}"
readonly remove_sql="${SUPABASH_POSTGRES_REMOVE_SQL:-$repo_root/sql/postgres/0001_remove.sql}"
readonly edge_main_file="$SUPABASH_TEST_EDGE_MAIN_FILE"
readonly test_support_sql="$repo_root/tests/postgres/test-support.sql"
readonly remove_test_support_sql="$repo_root/tests/postgres/remove-test-support.sql"
readonly edge_container="${SUPABASH_TEST_EDGE_CONTAINER:-supabash-postgres-integration-edge}"
readonly deno_container="${SUPABASH_TEST_DENO_CONTAINER:-supabash-postgres-integration-deno}"
readonly deno_cache_volume="${SUPABASH_TEST_DENO_CACHE_VOLUME:-supabash-postgres-integration-deno-cache}"
readonly edge_cache_volume="${SUPABASH_TEST_EDGE_CACHE_VOLUME:-supabash-postgres-integration-edge-cache}"
readonly edge_port="${SUPABASH_TEST_EDGE_PORT:-55432}"
readonly edge_image="${SUPABASH_TEST_EDGE_IMAGE:-public.ecr.aws/supabase/edge-runtime:v1.74.2}"
readonly deno_image="${SUPABASH_TEST_DENO_IMAGE:-denoland/deno:2.1.4}"

generate_run_id() {
  local id=""
  if [[ -n "${SUPABASH_TEST_RUN_ID:-}" ]]; then
    printf '%s\n' "$SUPABASH_TEST_RUN_ID"
    return 0
  fi
  if [[ -r /proc/sys/kernel/random/uuid ]]; then
    id="$(tr -d '-' </proc/sys/kernel/random/uuid)"
  elif command -v uuidgen >/dev/null 2>&1; then
    id="$(uuidgen | tr '[:upper:]' '[:lower:]' | tr -d '-')"
  elif command -v python3 >/dev/null 2>&1; then
    id="$(python3 -c 'import uuid; print(uuid.uuid4().hex)')"
  elif command -v openssl >/dev/null 2>&1; then
    id="$(openssl rand -hex 16)"
  fi
  if [[ -z "$id" ]]; then
    printf 'Unable to generate SUPABASH_TEST_RUN_ID.\n' >&2
    return 1
  fi
  printf '%s\n' "$id"
}

readonly run_id="$(generate_run_id)"
readonly results_dir="${SUPABASH_TEST_RESULTS_DIR:-/tmp/supabash-postgres-integration-$run_id}"
readonly cleanup_verifier="$repo_root/scripts/verify-postgres-cleanup.sh"

for required_file in "$install_sql" "$remove_sql" "$edge_main_file" "$test_support_sql" "$remove_test_support_sql"; do
  if [[ ! -f "$required_file" ]]; then
    printf 'Required file is missing: %s\n' "$required_file" >&2
    exit 2
  fi
done

mkdir -p "$results_dir"
exec > >(tee "$results_dir/terminal.log") 2>&1

installation_attempted=0
run_started=0

psql_file() {
  docker exec -i "$database_container" psql -U postgres -d postgres -v ON_ERROR_STOP=1 <"$1"
}

cleanup() {
  local cleanup_status=0
  if [[ "$run_started" != 1 ]]; then
    return 0
  fi
  docker rm -f "$edge_container" "$deno_container" >/dev/null 2>&1 || true
  if ! docker exec "$database_container" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c \
    "delete from auth.users where email like 'supabash-postgres-test-%@example.test'" >/dev/null; then
    cleanup_status=1
  fi
  if [[ "$installation_attempted" == 1 ]]; then
    psql_file "$remove_test_support_sql" >/dev/null || cleanup_status=1
    psql_file "$remove_sql" >/dev/null || cleanup_status=1
  fi
  docker volume rm "$deno_cache_volume" "$edge_cache_volume" >/dev/null 2>&1 || true
  if ! "$cleanup_verifier" >"$results_dir/cleanup.json"; then
    cleanup_status=1
  fi
  return "$cleanup_status"
}

finish() {
  local run_status=$?
  local cleanup_status=0
  trap - EXIT
  set +e
  if [[ "$run_status" != 0 ]]; then
    docker logs "$edge_container" >&2 || true
  fi
  cleanup
  cleanup_status=$?
  set -e
  if [[ "$run_status" == 0 && "$cleanup_status" != 0 ]]; then
    run_status=$cleanup_status
  fi
  printf 'Supabash Postgres integration results: %s\n' "$results_dir"
  exit "$run_status"
}
trap finish EXIT

if ! "$cleanup_verifier" >"$results_dir/baseline-cleanup.json"; then
  printf 'The integration environment contains existing Supabash resources. Refusing to remove them.\n' >&2
  exit 1
fi
run_started=1

if ! status_environment="$(cd "$supabase_root" && supabase status -o env)"; then
  printf 'Supabase status failed.\n' >&2
  exit 1
fi
eval "$status_environment"
unset status_environment

installation_attempted=1
psql_file "$install_sql"
psql_file "$test_support_sql"

readonly function_config='{"supabash-postgres-smoke":{"verifyJWT":false,"entrypointPath":"/workspace/tests/postgres/edge-smoke/index.ts","importMapPath":"/workspace/deno.check.json"}}'

docker run --detach --rm --network host \
  --name "$edge_container" \
  --volume "$repo_root:/workspace:ro" \
  --volume "$edge_main_file:/root/index.ts:ro" \
  --volume "$edge_cache_volume:/root/.cache/deno" \
  --env "SUPABASH_TEST_SUPABASE_URL=$API_URL" \
  --env "SUPABASH_TEST_PUBLISHABLE_KEY=$ANON_KEY" \
  --env "SUPABASE_URL=$API_URL" \
  --env "SUPABASE_ANON_KEY=$ANON_KEY" \
  --env "SUPABASE_INTERNAL_HOST_PORT=$edge_port" \
  --env "SUPABASE_INTERNAL_JWT_SECRET=$JWT_SECRET" \
  --env "SUPABASE_INTERNAL_DEBUG=false" \
  --env "SUPABASE_INTERNAL_FUNCTIONS_CONFIG=$function_config" \
  --env "SUPABASE_INTERNAL_WALLCLOCK_LIMIT_SEC=400" \
  "$edge_image" \
  start --main-service=/root --port="$edge_port" --policy=per_worker >/dev/null

edge_ready=0
for _ in {1..60}; do
  if curl --fail --silent "http://127.0.0.1:$edge_port/_internal/health" >/dev/null; then
    edge_ready=1
    break
  fi
  sleep 0.5
done
if [[ "$edge_ready" != 1 ]]; then
  docker logs "$edge_container" >&2 || true
  printf 'Disposable Edge Runtime did not become ready.\n' >&2
  exit 1
fi

docker run --rm --network host \
  --name "$deno_container" \
  --volume "$repo_root:/workspace:ro" \
  --volume "$results_dir:/results" \
  --volume "$deno_cache_volume:/deno-dir" \
  --workdir /workspace \
  --env "DENO_DIR=/deno-dir" \
  --env "SUPABASH_TEST_SUPABASE_URL=$API_URL" \
  --env "SUPABASH_TEST_PUBLISHABLE_KEY=$ANON_KEY" \
  --env "SUPABASH_TEST_SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY" \
  --env "SUPABASH_TEST_FUNCTIONS_URL=http://127.0.0.1:$edge_port" \
  --env "SUPABASH_TEST_RESULTS_FILE=/results/result.json" \
  --env "SUPABASH_TEST_RUN_ID=$run_id" \
  "$deno_image" \
  deno run -A --config deno.check.json tests/deno/postgres-live.ts

{
  printf 'postgres='; docker exec "$database_container" psql -U postgres -d postgres -Atqc 'show server_version'
  printf 'supabase_cli='; supabase --version
  printf 'edge_runtime='; docker exec "$edge_container" /usr/local/bin/edge-runtime --version | tr '\n' ';'; printf '\n'
  printf 'edge_image='; docker image inspect "$edge_image" -f '{{index .RepoDigests 0}}'
  printf 'deno_image='; docker image inspect "$deno_image" -f '{{index .RepoDigests 0}}'
  printf 'docker='; docker --version
} >"$results_dir/versions.txt"
