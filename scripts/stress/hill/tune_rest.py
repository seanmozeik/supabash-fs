"""Change one PostgREST setting on the disposable stack, retaining its baseline."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.request

key, value = sys.argv[1:]
if key not in ['PGRST_DB_POOL', 'GHCRTS', 'PGRST_DB_PREPARED_STATEMENTS']:
    raise RuntimeError('Unsupported isolated experiment.')
if not Path('/tmp/hill-config.json').exists():
    raise RuntimeError('Disposable stack only.')
name = 'supabase_rest_stack'
baseline = Path('/tmp/rest-baseline.json')
inspection = subprocess.run(['docker', 'inspect', name], capture_output=True, text=True)
exists = inspection.returncode == 0
if exists:
    original = json.loads(inspection.stdout)[0]
elif baseline.exists():
    original = json.loads(baseline.read_text())
else:
    raise RuntimeError('No PostgREST container or saved baseline.')
if not baseline.exists():
    descriptor = os.open(baseline, os.O_CREAT | os.O_WRONLY, 0o600)
    with os.fdopen(descriptor, 'w') as stream:
        json.dump(original, stream)
env = dict(entry.split('=', 1) for entry in original['Config']['Env'])
if value == 'baseline':
    previous = dict(entry.split('=', 1) for entry in json.loads(baseline.read_text())['Config']['Env'])
    env.pop(key, None)
    if key in previous:
        env[key] = previous[key]
else:
    env[key] = value
path = Path('/tmp/rest-env')
descriptor = os.open(path, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)
with os.fdopen(descriptor, 'w') as stream:
    stream.write('\n'.join(f'{name}={setting}' for name, setting in env.items()) + '\n')
networks = original['NetworkSettings']['Networks']
if len(networks) != 1:
    raise RuntimeError('Expected one test network.')
network, config = next(iter(networks.items()))
command = ['docker', 'run', '-d', '--name', name, '--network', network,
           '--env-file', str(path)]
for alias in config['Aliases'] or []:
    command.extend(['--network-alias', alias])
for mount in original['HostConfig']['Binds'] or []:
    command.extend(['--volume', mount])
entrypoint = original['Config']['Entrypoint'] or []
if entrypoint:
    command.extend(['--entrypoint', entrypoint[0]])
command.append(original['Config']['Image'])
command.extend(entrypoint[1:])
command.extend(original['Config']['Cmd'] or [])
if exists:
    subprocess.run(['docker', 'stop', name], check=True, stdout=subprocess.DEVNULL)
    subprocess.run(['docker', 'rm', name], check=True, stdout=subprocess.DEVNULL)
try:
    subprocess.run(command, check=True, stdout=subprocess.DEVNULL)
finally:
    path.unlink()
current = json.loads(subprocess.check_output(['docker', 'inspect', name]))[0]
rest_ip = current['NetworkSettings']['Networks'][network]['IPAddress']
private = Path('/tmp/hill-config.json')
credentials = json.loads(private.read_text())
credentials['restIp'] = rest_ip
private.write_text(json.dumps(credentials))
for attempt in range(30):
    try:
        with urllib.request.urlopen(f"http://{rest_ip}:3000/", timeout=2) as response:
            if response.status == 200:
                break
    except OSError:
        pass
    time.sleep(1)
else:
    raise RuntimeError('PostgREST did not become ready.')
# Kong caches the old container address; restart it with the same configuration.
subprocess.run(['docker', 'restart', 'supabase_kong_stack'], check=True, stdout=subprocess.DEVNULL)
for attempt in range(30):
    try:
        request = urllib.request.Request('http://127.0.0.1:54321/rest/v1/', headers={'apikey': credentials['key']})
        with urllib.request.urlopen(request, timeout=2) as response:
            if response.status == 200:
                break
    except OSError:
        pass
    time.sleep(1)
else:
    raise RuntimeError('Gateway did not reconnect to PostgREST.')
with Path('/results/rest-experiments.jsonl').open('a') as stream:
    stream.write(json.dumps({'key': key, 'value': value, 'time': time.time()}) + '\n')
print(f'Ready: {key}={value}')
