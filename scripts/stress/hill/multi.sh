#!/usr/bin/env bash
set -Eeuo pipefail
cd /workspace
mode="$1"
concurrency="$2"
label="$3"
workers="${4:-4}"
if [[ "$workers" != 4 && "$workers" != 8 ]]; then exit 2; fi
cohort=$((8192 / workers))
if [[ "$mode" != read && "$mode" != mixed ]]; then exit 2; fi
if [[ ! "$label" =~ ^[a-z0-9-]+$ ]]; then exit 2; fi
pids=()
for ((slot=0; slot<workers; slot++)); do
  offset=$((slot * cohort))
  python3 scripts/stress/hill/client.py "$mode" "$concurrency" 30 "$offset" "$cohort" > "/results/multi-$label-$offset.jsonl" &
  pids+=("$!")
done
failed=0
for pid in "${pids[@]}"; do wait "$pid" || failed=1; done
echo "Completed $workers-process $label."
exit "$failed"
