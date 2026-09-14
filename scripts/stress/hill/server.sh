#!/usr/bin/env bash
set -Eeuo pipefail
cd /workspace
bash scripts/stress/integration.sh
bash scripts/stress/run.sh seed
python3 scripts/stress/tune.py
python3 scripts/stress/hill/prepare.py
docker stop supabase_inbucket_stack
nohup python3 scripts/stress/hill/bridge.py server > /results/bridge.log 2>&1 < /dev/null &
echo 'Server prepared; private bridge started.'
