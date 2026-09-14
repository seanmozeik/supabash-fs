#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
mkdir -p /workspace /results
tar -xzf /tmp/source.tar.gz -C /workspace
cd /workspace
bun install --frozen-lockfile > /tmp/bun-install.log 2>&1
nohup python3 scripts/stress/hill/bridge.py generator > /results/bridge.log 2>&1 < /dev/null &
echo 'Generator prepared; private bridges started.'
