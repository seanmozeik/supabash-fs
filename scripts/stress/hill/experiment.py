"""Coordinate one bounded configuration experiment; all load runs on Modal."""
from pathlib import Path
import subprocess
import sys

control = str(Path(__file__).with_name('control.py'))
key, value, label = sys.argv[1:]
def invoke(*args):
    subprocess.run([sys.executable, control, *args], check=True)
invoke('exec', 'server', 'python3', '/workspace/scripts/stress/hill/tune_rest.py', key, value)
invoke('exec', 'server', 'python3', '/workspace/scripts/stress/hill/profile.py', 'reset')
for lane, concurrency in [('rest', '64'), ('sdk', '64'), ('sdk', '128')]:
    invoke('exec', 'generator', 'env', 'MODAL_STRESS_REMOTE=1', 'bun',
           '/workspace/scripts/stress/hill/lanes.ts', lane, concurrency, '20', label)
invoke('exec', 'server', 'python3', '/workspace/scripts/stress/hill/profile.py', label)
