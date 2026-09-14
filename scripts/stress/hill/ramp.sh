#!/usr/bin/env bash
set -Eeuo pipefail
cd /workspace
export MODAL_STRESS_REMOTE=1
label="${1:-baseline}"
for lane in sql rest kong sdk; do
  for concurrency in 8 32 64; do
    bun scripts/stress/hill/lanes.ts "$lane" "$concurrency" 20 "$label"
  done
done
