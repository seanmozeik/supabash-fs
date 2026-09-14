"""Provision a bounded, disposable test environment from the controller."""
from pathlib import Path
import subprocess
import sys

control = str(Path(__file__).with_name('control.py'))
size = sys.argv[1]
if size not in ['8', '16', '32']:
    raise RuntimeError('Choose 8, 16, or 32 server CPUs.')
def invoke(*args):
    subprocess.run([sys.executable, control, *args], check=True)
invoke('up', size)
invoke('upload', 'server')
invoke('upload', 'generator')
invoke('exec', 'server', 'bash', '-lc',
       'set -e; mkdir -p /workspace /results; tar -xzf /tmp/source.tar.gz -C /workspace; '
       'bash /workspace/scripts/stress/bootstrap.sh; '
       'bash /workspace/scripts/stress/hill/server.sh > /results/preparation.log 2>&1; '
       'echo "Integration, fixtures, and private bridge are ready."')
invoke('connect')
invoke('exec', 'generator', 'bash', '-lc',
       'set -e; mkdir -p /workspace; tar -xzf /tmp/source.tar.gz -C /workspace; '
       'bash /workspace/scripts/stress/hill/generator.sh')
print('Separate server and generator are ready.')
