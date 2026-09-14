#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
mkdir -p /workspace /results /stack
tar -xzf /tmp/source.tar.gz -C /workspace
for attempt in {1..60}; do
  if docker info >/dev/null 2>&1; then break; fi
  sleep 1
done
cd /workspace
bun install --frozen-lockfile > /tmp/bun-install.log 2>&1
echo 'Remote package dependencies installed.'
cd /stack
supabase init > /tmp/supabase-init.log 2>&1
supabase start -x studio,imgproxy,storage-api,realtime,logflare,vector,supavisor > /tmp/supabase-start.log 2>&1
supabase status -o env > /tmp/supabase.env 2>/tmp/supabase-status.log
echo 'Disposable Supabase is running.'
docker ps --format '{{.Names}} {{.Image}}'
echo 'Run integration.sh before seeding the stress dataset.'
