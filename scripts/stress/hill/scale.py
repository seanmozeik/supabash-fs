"""Add a million-tenant registry to the disposable single database."""
import json
from pathlib import Path
import subprocess
import time

if not Path('/tmp/hill-config.json').exists():
    raise RuntimeError('Disposable database only.')
source = Path('/workspace/scripts/stress/seed.sql').read_text()
if source.count('generate_series(1, 10000)') != 2:
    raise RuntimeError('Unexpected fixture definition.')
source = source.replace('generate_series(1, 10000)', 'generate_series(10001, 1000000)')
started = time.monotonic()
command = ['docker', 'exec', '-i', 'supabase_db_stack', 'psql', '-U', 'supabase_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1']
subprocess.run(command, input='begin;\n' + source + '\ncommit;\nanalyze auth.users;\nanalyze supabash.workspaces;', text=True, check=True)
counts = subprocess.check_output(command + ['-Atqc', "select json_build_object('accounts', (select count(*) from auth.users), 'workspaces', (select count(*) from supabash.workspaces), 'databaseBytes', pg_database_size('postgres'))"], text=True)
result = {'elapsedSeconds': time.monotonic() - started, **json.loads(counts)}
if result['workspaces'] != 1_000_000:
    raise RuntimeError('Incomplete tenant fixture.')
Path('/results/tenant-scale.json').write_text(json.dumps(result, indent=2))
print(json.dumps(result))
