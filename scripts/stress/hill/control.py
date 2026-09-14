"""Two disposable Modal VMs: one database stack and one traffic generator."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import tarfile

import modal

ROOT = Path(__file__).resolve().parents[3]
STATE = Path('/tmp/supabash-hill-070')
STATE.mkdir(exist_ok=True)
parser = argparse.ArgumentParser()
parser.add_argument('action', choices=['up', 'upload', 'exec', 'connect', 'pull', 'put', 'down'])
parser.add_argument('args', nargs=argparse.REMAINDER)
args = parser.parse_args()
record = STATE / 'sandboxes.json'

if args.action == 'up':
    if record.exists():
        raise RuntimeError('Existing hill-climb environment must be used or terminated first.')
    state = {}
    server_cpus = int(args.args[0]) if args.args else 8
    if server_cpus not in [8, 16, 32]:
        raise RuntimeError('Supported server sizes: 8, 16, or 32 CPUs.')
    app = modal.App.lookup('supabash-070-hill', create_if_missing=True)
    image = (modal.Image.from_registry('oven/bun:1.4.0')
             .apt_install('docker.io', 'curl', 'ca-certificates', 'python3', 'postgresql-client')
             .run_commands('curl -fsSL https://github.com/supabase/cli/releases/download/v2.111.0/supabase_linux_amd64.tar.gz | tar -xz -C /usr/local/bin supabase'))
    for role in ['server', 'generator']:
        with modal.enable_output():
            sb = modal.Sandbox.create('/usr/sbin/dockerd', app=app, image=image,
                cpu=(server_cpus, server_cpus) if role == 'server' else (8, 8),
                memory=server_cpus * 4096 if role == 'server' else 8192,
                region='eu-west', timeout=14400,
                encrypted_ports=[54321, 54324, 54325] if role == 'server' else [],
                experimental_options={'vm_runtime': True})
        state[role] = sb.object_id
        record.write_text(json.dumps(state))
        (STATE / 'sizing.json').write_text(json.dumps({'serverCpus': server_cpus, 'serverMemoryMiB': server_cpus * 4096, 'generatorCpus': 8}))
        print(f'{role}: {sb.object_id}', flush=True)
elif args.action == 'down':
    state = json.loads(record.read_text())
    for role, identifier in state.items():
        modal.Sandbox.from_id(identifier).terminate(wait=True)
        print(f'Terminated {role}.', flush=True)
    record.rename(STATE / 'terminated.json')
elif args.action == 'connect':
    state = json.loads(record.read_text())
    server = modal.Sandbox.from_id(state['server'])
    generator = modal.Sandbox.from_id(state['generator'])
    local = STATE / 'credentials.json'
    local.touch(mode=0o600)
    os.chmod(local, 0o600)
    try:
        server.filesystem.copy_to_local('/tmp/hill-config.json', str(local))
        config = json.loads(local.read_text())
        tunnels = server.tunnels()
        config.update(api=tunnels[54321].url,
            dbTunnel=tunnels[54324].host, restTunnel=tunnels[54325].host)
        local.write_text(json.dumps(config))
        generator.filesystem.copy_from_local(str(local), '/tmp/hill-config.json')
    finally:
        local.unlink(missing_ok=True)
    print('Transferred only disposable credentials to the generator.')
else:
    role, *remaining = args.args
    state = json.loads(record.read_text())
    sb = modal.Sandbox.from_id(state[role])
    if args.action == 'upload':
        archive = STATE / 'source.tar.gz'
        with tarfile.open(archive, 'w:gz') as tar:
            for name in ['src', 'tests', 'sql', 'scripts', 'dist', 'package.json', 'bun.lock', 'deno.check.json', 'deno.lock', 'tsconfig.json']:
                if (ROOT / name).exists():
                    tar.add(ROOT / name, arcname=name)
        (STATE / 'source-sha256.txt').write_text(hashlib.sha256(archive.read_bytes()).hexdigest())
        sb.filesystem.copy_from_local(str(archive), '/tmp/source.tar.gz')
        print(f'Uploaded {role}.')
    elif args.action == 'put':
        local, remote = remaining
        sb.filesystem.copy_from_local(local, remote)
        print('Transferred the selected file.')
    elif args.action == 'exec':
        process = sb.exec(*remaining, timeout=7200)
        for line in process.stdout:
            print(line, end='', flush=True)
        print(process.stderr.read(), end='', flush=True)
        process.wait()
        raise SystemExit(process.returncode)
    else:
        remote, local = remaining
        sb.filesystem.copy_to_local(remote, local)
        print(f'Saved {local}.')
