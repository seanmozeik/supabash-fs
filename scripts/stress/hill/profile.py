"""Capture only aggregate statistics from the disposable database."""
import json
from pathlib import Path
import re
import subprocess
import sys

label = sys.argv[1]
if not re.fullmatch('[a-z0-9-]+', label) or not Path('/tmp/hill-config.json').exists():
    raise RuntimeError('Invalid disposable profile target.')
def query(sql):
    return subprocess.check_output(['docker', 'exec', 'supabase_db_stack', 'psql', '-U', 'supabase_admin', '-d', 'postgres', '-Atqc', sql], text=True)
if label == 'reset':
    query('select pg_stat_statements_reset()')
else:
    result = {
        'settings': query("select json_object_agg(name, setting) from pg_settings where name in ('max_connections','shared_buffers','work_mem','jit','effective_cache_size','max_parallel_workers','track_io_timing','pg_stat_statements.track')"),
        'queries': query("select coalesce(json_agg(t), '[]') from (select queryid, calls, total_exec_time, mean_exec_time, rows, shared_blks_hit, shared_blks_read, temp_blks_written, wal_bytes, left(query,400) as query from pg_stat_statements where query ilike '%supabash%' and query not ilike '%create role%' and query not ilike '%pg_stat_statements%' order by total_exec_time desc limit 15) t"),
        'waits': query("select json_agg(t) from (select state,wait_event_type,wait_event,count(*) from pg_stat_activity group by 1,2,3) t"),
        'database': query("select row_to_json(t) from (select numbackends,xact_commit,xact_rollback,blks_read,blks_hit,temp_bytes,deadlocks,blk_read_time,blk_write_time from pg_stat_database where datname='postgres') t"),
        'containers': subprocess.check_output(['docker', 'stats', '--no-stream', '--format', '{{json .}}'], text=True),
    }
    Path(f'/results/profile-{label}.json').write_text(json.dumps(result, indent=2))
    containers = [json.loads(line) for line in result['containers'].splitlines()]
    print(json.dumps({'saved': label, 'containers': [
        {'name': entry['Name'], 'cpu': entry['CPUPerc'], 'memory': entry['MemUsage']} for entry in containers]}))
