# Single-database capacity tests

This harness runs Supabase and its traffic generator on separate disposable Modal
VMs in `eu-west`. The database VM supports 8, 16, or 32 CPUs. The generator has
8 CPUs. The controller uses the active Modal profile. It runs no database or load
generator on the controller machine.

Build the package first. Run `control.py up 8`, then upload the source with
`control.py upload server` and `control.py upload generator`. The controller
requires the Modal Python SDK. It records each VM immediately under
`/tmp/supabash-hill-070`, including a partly completed setup.

On the server, extract `/tmp/source.tar.gz` into `/workspace`, run
`scripts/stress/bootstrap.sh`, then run `scripts/stress/hill/server.sh`. The latter
runs the live upgrade and integration checks, seeds 10,000 synthetic accounts and
2,048 populated workspaces, and starts the private test bridge. Each populated
workspace has 20 files of about 2 KiB each.

Run `control.py connect` to transfer disposable credentials to the generator.
Extract its source archive into `/workspace`, then run
`scripts/stress/hill/generator.sh`. Credentials stay outside the source tree and
result archives. The SQL bridge requires a separate random secret over TLS. The
benchmark database role can assume `authenticated`; it has no direct access to
the private tables and no RLS bypass.

## Comparisons

Run `ramp.sh` on the generator with `MODAL_STRESS_REMOTE=1`. Each measured operation
loads one manifest and one revision-pinned file, then verifies its owner and
content. The four paths are:

- `sql`: persistent SQL connections with a fixed authenticated subject per worker.
- `rest`: direct PostgREST requests with JWT verification.
- `kong`: the same RPCs through the API gateway.
- `sdk`: the complete Supabash open and read path, including `Auth.getUser`.

The first three paths identify costs within the stack. The SDK path represents
the public package API. Direct SQL omits HTTP and Auth service work. The test
bridge and network latency remain part of the measured request latency.

Use `experiment.py SETTING VALUE LABEL` on the controller to change one PostgREST
setting and run the same three bounded comparisons. `function_trial.py` compares
SQL-language helpers with cached PL/pgSQL helpers. It replaces only the two
private helpers in the disposable database. Retain a change only after a repeat
or reversal confirms the gain, and verify larger workspaces and live access
checks before accepting it.

Use `sample.py LABEL SECONDS` on each VM during a test. It records resource use
without process arguments or credentials. `profile.py LABEL` records query and
database statistics. Nested query execution times overlap; do not sum them as
independent database demand.

## Load and recovery

`soak.sh TOTAL CONCURRENCY WORKERS` runs four or eight SDK generators plus
maintenance for 120 seconds. It supports 2,048 or 8,192 owners. Concurrency is
per generator. The mix is 70% reads, 20% writes, and 10% history requests.
Every accepted final write is read back. Maintenance runs concurrently against
the same owner population.

For the larger fixture, run `scale.py` once on the server to create one million
accounts and workspaces. Seed owners 2,049 through 8,192 before using the larger
workload. Most of the million workspaces remain empty: this tests tenant lookup
cardinality, not one million populated or active workspaces.

`pressure.sh` runs eight generators at combined arrival rates of 3,000, 6,000,
12,000, and 3,000 operations per second for 20 seconds each. The combined active
operation cap is 256. Preserve dropped arrivals in the report; a bounded
generator does not establish that the server accepted the offered rate.

`client.py arrival 512 30 0 2048 RATE` runs a fixed arrival rate, capped at 512
active operations. Results include dropped arrivals and scheduling delay. Drops
are generator admission failures, separate from server errors. Test a lower rate
again after overload to verify recovery.

`client.py recovery` drops a successful commit response after receiving it from
the real database. It verifies an unknown outcome, an idempotent retry, one new
revision, and the saved content. `scripts/stress/run.sh correctness` on the server
tests hot-workspace conflicts, bounded lock waits, and workspaces with up to
5,000 files.

After all traffic stops, run `crash.py` on the server and `client.py verify-writes`
on the generator. The first checks that durability settings are enabled, kills
the database process, restarts it, and waits for a real authenticated RPC. The
second checks every recorded final acknowledged value from the mixed workload.
This tests process crash recovery with the VM disk retained. It does not test
loss of the VM or its storage.

These are synthetic Supabash tests. Application model calls, chat handlers, memory
compilation, and indexing require a separate application workload. A short test
does not establish long-term capacity or support for one million active users.

## Evidence and cleanup

Run `collect.py` on both VMs, then use `control.py pull` to save each
`/tmp/hill-results.tar.gz` and `/results/hill-summary.json`. Save the source
archive, its hash, the sizing record, and the experimental settings with the
results. The source hash covers `src`, `sql`, and `dist`. Experiment labels also
identify temporary SQL or server configurations.

Always run `control.py down` when the test is complete, including after a failed
setup. It terminates both VMs and saves the terminated IDs. Archive that record
before creating another server size. The VM timeout is a final cleanup bound,
not the normal cleanup method.
