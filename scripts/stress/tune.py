"""Change only the disposable nested stack's connection pools and gateway limits."""

import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request

if not Path('/tmp/supabase.env').exists() or not Path('/workspace/scripts/stress').exists():
    raise RuntimeError('This script belongs inside the disposable Modal VM.')

changes = {
    'supabase_auth_stack': {
        'GOTRUE_DB_MAX_POOL_SIZE': '20',
        'GOTRUE_DB_MAX_IDLE_POOL_SIZE': '20',
        'GOTRUE_DB_CONN_MAX_LIFETIME': '1h',
    },
    'supabase_kong_stack': {
        'KONG_NGINX_EVENTS_WORKER_CONNECTIONS': '8192',
        'KONG_NGINX_WORKER_PROCESSES': '2',
    },
}
for name, overrides in changes.items():
    baseline = name + '-baseline'
    has_baseline = subprocess.run(['docker', 'inspect', baseline], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    original = json.loads(subprocess.check_output(['docker', 'inspect', baseline if has_baseline else name]))[0]
    env = dict(entry.split('=', 1) for entry in original['Config']['Env'])
    env.update(overrides)
    env_file = Path('/tmp') / (name + '.env')
    descriptor = os.open(env_file, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, 'w') as stream:
        stream.write('\n'.join(f'{key}={value}' for key, value in env.items()) + '\n')
    networks = original['NetworkSettings']['Networks']
    if len(networks) != 1:
        raise RuntimeError('Expected one isolated Docker network.')
    network = next(iter(networks))
    command = ['docker', 'run', '--detach', '--name', name, '--network', network,
               '--env-file', str(env_file)]
    for alias in networks[network]['Aliases'] or []:
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
    if has_baseline:
        subprocess.run(['docker', 'rm', name], check=True, stdout=subprocess.DEVNULL)
    else:
        subprocess.run(['docker', 'rename', name, baseline], check=True)
    subprocess.run(command, check=True, stdout=subprocess.DEVNULL)
    env_file.unlink()
    print(f'Restarted {name} with {overrides}', flush=True)
Path('/results/tuning.json').write_text(json.dumps(changes, indent=2))
anon_key = next(line.split('=', 1)[1].strip('"') for line in
                Path('/tmp/supabase.env').read_text().splitlines() if line.startswith('ANON_KEY='))
for attempt in range(60):
    try:
        request = urllib.request.Request('http://127.0.0.1:54321/auth/v1/health',
                                         headers={'apikey': anon_key})
        with urllib.request.urlopen(request, timeout=2) as response:
            if response.status == 200:
                print('Auth and gateway are ready.', flush=True)
                break
    except (OSError, TimeoutError):
        pass
    time.sleep(1)
else:
    raise RuntimeError('Auth and gateway did not become ready within 60 seconds.')
