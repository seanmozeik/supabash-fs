"""Crash only the disposable database process and wait for WAL recovery."""
import json
import base64
import hashlib
import hmac
from pathlib import Path
import subprocess
import time
import urllib.request

if not Path('/tmp/hill-config.json').exists():
    raise RuntimeError('Disposable database only.')
command = ['docker', 'exec', 'supabase_db_stack', 'psql', '-U', 'supabase_admin', '-d', 'postgres', '-Atqc']
settings = json.loads(subprocess.check_output(command + ["select json_object_agg(name, setting) from pg_settings where name in ('fsync','synchronous_commit','full_page_writes')"], text=True))
if any(value != 'on' for value in settings.values()) or len(settings) != 3:
    raise RuntimeError('Durability settings must stay enabled.')
started = time.monotonic()
subprocess.run(['docker', 'kill', '--signal', 'KILL', 'supabase_db_stack'], check=True, stdout=subprocess.DEVNULL)
subprocess.run(['docker', 'start', 'supabase_db_stack'], check=True, stdout=subprocess.DEVNULL)
for attempt in range(60):
    ready = subprocess.run(command + ['select 1'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if ready.returncode == 0:
        break
    time.sleep(1)
else:
    raise RuntimeError('Database did not recover within 60 seconds.')
database_ready = time.monotonic() - started
config = json.loads(Path('/tmp/hill-config.json').read_text())
def encode(value):
    return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip('=')
unsigned = encode({'alg': 'HS256', 'typ': 'JWT'}) + '.' + encode({
    'sub': '10000000-0000-4000-8000-000000000001', 'aud': 'authenticated',
    'role': 'authenticated', 'exp': int(time.time()) + 3600})
signature = base64.urlsafe_b64encode(hmac.new(config['jwtSecret'].encode(), unsigned.encode(), hashlib.sha256).digest()).decode().rstrip('=')
for attempt in range(60):
    try:
        request = urllib.request.Request('http://127.0.0.1:54321/rest/v1/rpc/supabash_load_manifest',
            data=json.dumps({'p_workspace_id': '20000000-0000-4000-8000-000000000001'}).encode(),
            headers={'apikey': config['key'], 'authorization': 'Bearer ' + unsigned + '.' + signature,
                     'content-type': 'application/json'})
        with urllib.request.urlopen(request, timeout=3) as response:
            if response.status == 200:
                break
    except OSError:
        pass
    time.sleep(1)
else:
    raise RuntimeError('API did not recover its database connections.')
result = {'signal': 'SIGKILL', 'databaseReadySeconds': database_ready,
          'apiReadySeconds': time.monotonic() - started, 'settings': settings}
Path('/results/database-crash.json').write_text(json.dumps(result, indent=2))
print(json.dumps(result))
