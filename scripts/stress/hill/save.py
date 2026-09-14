"""Save both VMs' evidence before terminating the environment."""
from pathlib import Path
import shutil
import subprocess
import sys

destination = Path(sys.argv[1]).resolve()
destination.mkdir(parents=True, exist_ok=True)
control = str(Path(__file__).with_name('control.py'))
for role in ['server', 'generator']:
    subprocess.run([sys.executable, control, 'exec', role, 'python3', '/workspace/scripts/stress/hill/collect.py'], check=True)
    for remote, name in [('/tmp/hill-results.tar.gz', 'results.tar.gz'),
                         ('/tmp/hill-source.tar.gz', 'source.tar.gz'),
                         ('/results/hill-summary.json', 'summary.json')]:
        subprocess.run([sys.executable, control, 'pull', role, remote, str(destination / f'{role}-{name}')], check=True)
for name in ['sandboxes.json', 'sizing.json']:
    shutil.copyfile(Path('/tmp/supabash-hill-070') / name, destination / name)
print(f'Saved evidence to {destination}.')
