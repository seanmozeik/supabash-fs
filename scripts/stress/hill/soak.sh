#!/usr/bin/env bash
set -Eeuo pipefail
cd /workspace
pids=()
total="${1:-2048}"
if [[ "$total" != 2048 && "$total" != 8192 ]]; then exit 2; fi
workers="${3:-4}"
if [[ "$workers" != 4 && "$workers" != 8 ]]; then exit 2; fi
cohort=$((total / workers))
concurrency="${2:-32}"
python3 scripts/stress/hill/client.py maintenance 2 120 0 "$total" > /results/soak-maintenance.jsonl &
pids+=("$!")
for ((slot=0; slot<workers; slot++)); do
  offset=$((slot * cohort))
  python3 scripts/stress/hill/client.py mixed "$concurrency" 120 "$offset" "$cohort" > "/results/soak-$offset.jsonl" &
  pids+=("$!")
done
failed=0
for pid in "${pids[@]}"; do wait "$pid" || failed=1; done
echo 'Mixed workload and maintenance finished.'
exit "$failed"
