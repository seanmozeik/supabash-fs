#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
cd /workspace
set -a
source /tmp/supabase.env
MODAL_STRESS_REMOTE=1
set +a
unset SECRET_KEY SERVICE_ROLE_KEY

snapshot() {
  docker stats --no-stream --format '{{json .}}' > "/results/$1-containers.jsonl"
  docker exec supabase_db_stack psql -U postgres -d postgres -Atqc "
    select json_build_object('databaseBytes', pg_database_size('postgres'),
      'workspaces', (select count(*) from supabash.workspaces),
      'documents', (select count(*) from supabash.current_documents),
      'revisions', (select count(*) from supabash.workspace_revisions),
      'revisionEntries', (select count(*) from supabash.revision_entries),
      'versionEntries', (select count(*) from supabash.document_versions),
      'deadlocks', (select deadlocks from pg_stat_database where datname='postgres'));
    select json_build_object('state',state,'wait',wait_event_type,'count',count(*))
      from pg_stat_activity group by state,wait_event_type;" > "/results/$1-database.jsonl"
}

if [[ "${1:-}" == seed ]]; then
  for file in sql/postgres/0001_install.sql sql/postgres/0002_lazy_reads.sql sql/postgres/0003_versioned_entries.sql; do
    docker exec -i supabase_db_stack psql -U postgres -d postgres -v ON_ERROR_STOP=1 < "$file" >> /results/stress-install.log 2>&1
  done
  docker exec -i supabase_db_stack psql -U postgres -d postgres -v ON_ERROR_STOP=1 < scripts/stress/seed.sql > /results/seed-sql.log
  bun scripts/stress/client.ts seed 16 900 0 2048 > /results/seed-client.jsonl
  snapshot seeded
  echo 'Seeded 2048 populated workspaces, 20 files each, and 7952 empty workspaces.'
  exit
fi

if [[ "${1:-}" == correctness ]]; then
  bun scripts/stress/correctness.ts
  snapshot correctness
  exit
fi

if [[ "${1:-}" == arrival ]]; then
  for rate in 500 1000 2000; do
    bun scripts/stress/client.ts arrival 512 30 0 2048 "$rate" > "/results/arrival-$rate.jsonl"
    snapshot "arrival-$rate"
  done
  exit
fi

if [[ "${1:-}" == multi ]]; then
  processes=()
  bun scripts/stress/client.ts maintenance 2 180 0 2048 > /results/multi-maintenance.jsonl &
  processes+=("$!")
  for offset in 0 512 1024 1536; do
    bun scripts/stress/client.ts mixed 32 180 "$offset" 512 > "/results/multi-$offset.jsonl" &
    processes+=("$!")
  done
  failed=0
  for pid in "${processes[@]}"; do wait "$pid" || failed=1; done
  snapshot multi
  exit "$failed"
fi

snapshot before
for mode in read mixed; do
  for concurrency in 1 8 32 128 512 2048; do
    echo "Starting $mode concurrency=$concurrency"
    bun scripts/stress/client.ts "$mode" "$concurrency" 30 0 2048 > "/results/$mode-$concurrency.jsonl"
    snapshot "$mode-$concurrency"
    echo "Finished $mode concurrency=$concurrency"
  done
done
snapshot after
