"""Create a restricted SQL benchmark role and private, disposable transport keys."""
import json
import os
from pathlib import Path
import secrets
import subprocess

if not Path('/tmp/supabase.env').exists():
    raise RuntimeError('This must run inside the disposable database VM.')
env = dict(line.split('=', 1) for line in Path('/tmp/supabase.env').read_text().splitlines() if '=' in line)
password = secrets.token_hex(32)
sql = f"""
do $$ begin create role supabash_bench login noinherit; exception when duplicate_object then null; end $$;
alter role supabash_bench password '{password}';
grant authenticated to supabash_bench;
create extension if not exists pg_stat_statements;
alter system set track_io_timing = on;
alter system set pg_stat_statements.track = 'all';
select pg_reload_conf();
"""
subprocess.run(['docker', 'exec', '-i', 'supabase_db_stack', 'psql', '-U', 'supabase_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'],
               input=sql.encode(), check=True, stdout=subprocess.DEVNULL)
container = json.loads(subprocess.check_output(['docker', 'inspect', 'supabase_rest_stack']))[0]
config = {'password': password, 'bridgeSecret': secrets.token_hex(32),
          'key': env['ANON_KEY'].strip('"'), 'jwtSecret': env['JWT_SECRET'].strip('"'),
          'restIp': next(iter(container['NetworkSettings']['Networks'].values()))['IPAddress']}
path = Path('/tmp/hill-config.json')
descriptor = os.open(path, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
with os.fdopen(descriptor, 'w') as stream:
    json.dump(config, stream)
print('Prepared restricted SQL role and private transport.')
