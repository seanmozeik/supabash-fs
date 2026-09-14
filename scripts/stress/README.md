# Supabash 0.7.0 Modal stress test

This harness runs in a disposable Modal VM in the active Modal profile. The VM runs Docker,
Supabase Postgres, Auth, PostgREST, Kong, and Edge Runtime. The Mac sends commands
and receives reports. It does not host the database or generate traffic.

The controller requests 8 CPUs and 32 GiB of RAM, limits CPU use to 8, and gives
the VM a two-hour timeout. It creates no persistent database volume or production
deployment. The named Modal app and cached image can remain after VM termination.

## Run

Use Python with Modal SDK 1.5.5 or a compatible version. From this checkout:

```text
python scripts/stress/modal_env.py up
python scripts/stress/modal_env.py upload
python scripts/stress/modal_env.py exec mkdir -p /workspace
python scripts/stress/modal_env.py exec tar -xzf /tmp/source.tar.gz -C /workspace
python scripts/stress/modal_env.py exec bash /workspace/scripts/stress/bootstrap.sh
python scripts/stress/modal_env.py exec bash /workspace/scripts/stress/integration.sh
python scripts/stress/modal_env.py exec bash /workspace/scripts/stress/run.sh seed
python scripts/stress/modal_env.py exec python3 /workspace/scripts/stress/tune.py
python scripts/stress/modal_env.py exec bash /workspace/scripts/stress/run.sh
python scripts/stress/modal_env.py exec bash /workspace/scripts/stress/run.sh multi
python scripts/stress/modal_env.py exec bash /workspace/scripts/stress/run.sh correctness
python scripts/stress/modal_env.py exec bash /workspace/scripts/stress/run.sh arrival
python scripts/stress/modal_env.py exec python3 /workspace/scripts/stress/collect.py
python scripts/stress/modal_env.py pull /tmp/stress-results.tar.gz /tmp/supabash-stress-results.tar.gz
python scripts/stress/modal_env.py down
```

Wait for each command to succeed before continuing. If a test fails, retain its
output and inspect the cause. Terminate the VM after saving evidence, including
after a failed test. The controller saves its sandbox ID under
`/tmp/supabash-modal-070/`; use `down` to terminate that exact sandbox.
Do not extract a new source archive while a test script is running.

`bootstrap.sh` pins Supabase CLI 2.111.0 and Bun 1.4.0. The live integration suite
uses Deno 2.1.4 and Supabase Edge Runtime 1.74.2. Collection records Docker image
digests and a digest of the candidate code. This tests the unpublished candidate
in this checkout, not a package fetched from the registry.

## Dataset and operations

The seed creates 10,000 synthetic Auth users and workspaces. It populates 2,048
workspaces with 20 files each, about 2 KiB per file. The other workspaces start
empty. Test tokens are signed with the disposable stack's JWT secret. Password
login, refresh, real provider calls, and application chat jobs are outside this load test.
The separate live integration suite does create and sign in test users.
It also tests an upgrade from populated legacy storage, and checks rollback,
shared bodies, and historical reads for the set-based batch write path.

Every timed operation uses the public Supabash SDK and real Auth and database
HTTP endpoints. Read operations open a workspace and verify one file's owner
marker. Mixed operations add writes and history reads to that path, with an
approximately 70/20/10 operation mix. After a phase, the test reopens each changed
workspace and checks its latest acknowledged value. RPC counters also include
the untimed preflight and verification requests; timed throughput excludes them.

The concurrency ramp runs 30-second phases at 1, 8, 32, 128, 512, and 2,048
active operations. These are closed-loop operations, not distinct logged-in
sessions or guaranteed simultaneous network connections. Four independent
generator processes then run 128 mixed operations in total for three minutes,
while another process performs retention cleanup with two active operations.

The arrival test offers 500, 1,000, then 2,000 reads per second for 30 seconds per
phase. It permits at most 512 active operations and records dropped arrivals.
Latency includes scheduling delay. Its scheduling-delay metric identifies when
the generator cannot offer the requested rate. HTTP calls have a 15-second
timeout. No result establishes support for one million concurrent users.

Correctness checks race 64 writers against the same revision and hold a database
lock to check the one-second lock timeout. Large-workspace checks use 100, 1,000,
and 5,000 files, about 4 KiB each. They measure open, first read, one-file commits,
full snapshots, and the old eager-read SQL path. A failed bulk seed due to a
statement timeout is recorded and checked for rollback before retrying in
250-file batches. Recovery does not turn the original timeout into a pass.

## Environment limits and evidence

The CLI's default Auth connection settings can exhaust ephemeral ports during
load. `tune.py` preserves the baseline containers and uses a 20-connection Auth
pool, including 20 idle connections. It also configures the gateway connection
limit. These are explicit test settings, not claims about hosted Supabase.
All services and generators share one VM. The tests neither reproduce a managed
Supabase compute tier nor establish a distributed deployment's capacity.

History grows across phases, so later phases do not start from identical data.
The three-minute test includes real Supabash retention work, not application compilation
or indexing. Database and container snapshots accompany the results. Passing
short tests does not establish long-term recovery, failover, or a production SLO.

Collection includes aggregate JSON, latency samples, image versions, and live
integration results. It excludes environment files, source bodies, and raw
service logs. Keep failed and successful configurations separate when comparing
results. Save the reports before terminating the VM.
