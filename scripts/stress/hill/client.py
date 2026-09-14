"""Run the existing rotating-owner SDK workload from the separate generator."""
import json
import os
from pathlib import Path
import subprocess
import sys

config = json.loads(Path('/tmp/hill-config.json').read_text())
env = {**os.environ, 'MODAL_STRESS_REMOTE': '1', 'API_URL': config['api'],
       'ANON_KEY': config['key'], 'JWT_SECRET': config['jwtSecret']}
checks = {'recovery': 'recovery.ts', 'verify-writes': 'verify-writes.ts'}
script = 'scripts/stress/hill/' + checks[sys.argv[1]] if sys.argv[1] in checks else 'scripts/stress/client.ts'
arguments = [] if sys.argv[1] in checks else sys.argv[1:]
raise SystemExit(subprocess.run(['bun', script, *arguments],
                               cwd='/workspace', env=env).returncode)
