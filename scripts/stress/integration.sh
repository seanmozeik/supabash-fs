#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
cd /workspace
# Keep the original disposable endpoints after test containers are recreated.
set -a
source /tmp/supabase.env
set +a
export SUPABASH_TEST_SUPABASE_ROOT=/stack
export SUPABASH_TEST_DATABASE_CONTAINER=supabase_db_stack
export SUPABASH_TEST_EDGE_MAIN_FILE=/stack/supabase/.temp/start-secrets/supabase_edge_runtime_stack/main/index.ts
export SUPABASH_TEST_RESULTS_DIR=/results/integration
bash scripts/run-postgres-integration.sh
