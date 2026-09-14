"""Change only the disposable gateway's worker count."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.request

workers = int(sys.argv[1])
if workers not in [2, 4, 8] or not Path('/tmp/hill-config.json').exists():
    raise RuntimeError('Invalid disposable gateway profile.')
name = 'supabase_kong_stack'
original = json.loads(subprocess.check_output(['docker', 'inspect', name]))[0]
env = dict(entry.split('=', 1) for entry in original['Config']['Env'])
env['KONG_NGINX_WORKER_PROCESSES'] = str(workers)
path = Path('/tmp/gateway-env')
descriptor = os.open(path, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)
with os.fdopen(descriptor, 'w') as stream:
    stream.write('\n'.join(f'{key}={value}' for key, value in env.items()) + '\n')
networks = original['NetworkSettings']['Networks']
if len(networks) != 1:
    raise RuntimeError('Expected one test network.')
network, config = next(iter(networks.items()))
command = ['docker', 'run', '-d', '--name', name, '--network', network, '--env-file', str(path)]
for alias in config['Aliases'] or []:
    command.extend(['--network-alias', alias])
for mount in original['HostConfig']['Binds'] or []:
    command.extend(['--volume', mount])
for port, bindings in (original['HostConfig']['PortBindings'] or {}).items():
    for binding in bindings:
        host = binding['HostIp'] or '0.0.0.0'
        if ':' in host:
            host = '[' + host + ']'
        command.extend(['--publish', f"{host}:{binding['HostPort']}:{port}"])
entrypoint = original['Config']['Entrypoint'] or []
if entrypoint:
    command.extend(['--entrypoint', entrypoint[0]])
command.append(original['Config']['Image'])
command.extend(entrypoint[1:])
command.extend(original['Config']['Cmd'] or [])
subprocess.run(['docker', 'stop', name], check=True, stdout=subprocess.DEVNULL)
subprocess.run(['docker', 'rm', name], check=True, stdout=subprocess.DEVNULL)
try:
    subprocess.run(command, check=True, stdout=subprocess.DEVNULL)
finally:
    path.unlink()
credentials = json.loads(Path('/tmp/hill-config.json').read_text())
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
    raise RuntimeError('Gateway did not become ready.')
with Path('/results/gateway-experiments.jsonl').open('a') as stream:
    stream.write(json.dumps({'workers': workers, 'time': time.time()}) + '\n')
print(f'Gateway ready with {workers} workers.')
