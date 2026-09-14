"""Measure one SQL helper implementation without changing the HTTP settings."""
from pathlib import Path
import subprocess
import sys

control = str(Path(__file__).with_name('control.py'))
mode, label = sys.argv[1:]
def invoke(*args):
    subprocess.run([sys.executable, control, *args], check=True)
invoke('exec', 'server', 'python3', '/workspace/scripts/stress/hill/function_experiment.py', mode)
invoke('exec', 'server', 'python3', '/workspace/scripts/stress/hill/profile.py', 'reset')
for lane in ['sql', 'sdk']:
    invoke('exec', 'generator', 'env', 'MODAL_STRESS_REMOTE=1', 'bun',
           '/workspace/scripts/stress/hill/lanes.ts', lane, '64', '20', label)
invoke('exec', 'server', 'python3', '/workspace/scripts/stress/hill/profile.py', label)
