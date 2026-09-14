"""Sample CPU and memory during load, without command arguments or credentials."""
import json
from pathlib import Path
import re
import subprocess
import sys
import time

label, duration = sys.argv[1:]
seconds = int(duration)
if not re.fullmatch('[a-z0-9-]+', label) or not 1 <= seconds <= 600 or not Path('/tmp/hill-config.json').exists():
    raise RuntimeError('Invalid disposable sampling profile.')
started = time.monotonic()
with Path(f'/results/sample-{label}.jsonl').open('w') as stream:
    while time.monotonic() - started < seconds:
        stats = subprocess.check_output(['docker', 'stats', '--no-stream', '--format', '{{json .}}'], text=True)
        processes = subprocess.check_output(['ps', '-eo', 'pid,pcpu,rss,comm', '--sort=-pcpu'], text=True).splitlines()[:12]
        stream.write(json.dumps({'seconds': time.monotonic() - started,
            'containers': [json.loads(line) for line in stats.splitlines()], 'processes': processes}) + '\n')
        stream.flush()
        time.sleep(3)
print('Sampling completed.')
