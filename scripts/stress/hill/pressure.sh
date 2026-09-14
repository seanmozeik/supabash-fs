#!/usr/bin/env bash
set -Eeuo pipefail
cd /workspace
step=0
failed=0
for rate in 375 750 1500 375; do
  pids=()
  for slot in 0 1 2 3 4 5 6 7; do
    offset=$((slot * 1024))
    python3 scripts/stress/hill/client.py arrival 32 20 "$offset" 1024 "$rate" > "/results/multi-arrival-$step-$rate-$offset.jsonl" &
    pids+=("$!")
  done
  for pid in "${pids[@]}"; do wait "$pid" || failed=1; done
  echo "Completed arrival stage $step: $((rate * 8)) requests per second."
  step=$((step + 1))
done
exit "$failed"
