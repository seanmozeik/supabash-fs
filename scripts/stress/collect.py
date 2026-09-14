"""Collect aggregate test evidence, excluding environment files and raw service logs."""

import hashlib
import json
from pathlib import Path
import platform
import subprocess
import tarfile

root = Path('/results')
if not Path('/tmp/supabase.env').exists():
    raise RuntimeError('Run collection inside the disposable VM.')
phases = []
for mode in ['read', 'mixed']:
    for concurrency in [1, 8, 32, 128, 512, 2048]:
        path = root / f'{mode}-{concurrency}.jsonl'
        if path.exists() and path.stat().st_size:
            phases.append(json.loads(path.read_text()))
arrivals = []
for rate in [500, 1000, 2000]:
    path = root / f'arrival-{rate}.jsonl'
    if path.exists() and path.stat().st_size:
        arrivals.append(json.loads(path.read_text()))
multi = []
samples = []
for offset in [0, 512, 1024, 1536]:
    path = root / f'multi-{offset}.jsonl'
    if path.exists() and path.stat().st_size:
        worker = json.loads(path.read_text())
        multi.append(worker)
        samples.extend(json.loads((root / (worker['run'] + '-latencies.json')).read_text()))
samples.sort()
source = hashlib.sha256()
for folder in ['src', 'sql', 'dist']:
    for path in sorted((Path('/workspace') / folder).rglob('*')):
        if path.is_file():
            source.update(str(path.relative_to('/workspace')).encode())
            source.update(path.read_bytes())
summary = {
    'candidateCodeSha256': source.hexdigest(),
    'platform': platform.platform(),
    'scope': 'One Modal VM. Nested Supabase. Synthetic JWTs and accounts. Not an application capacity certification.',
    'phases': phases, 'arrivals': arrivals, 'multiWorkers': multi,
    'multiAggregate': {
        'workers': len(multi),
        'successfulOpsPerSecond': sum(w['successfulOpsPerSecond'] for w in multi),
        'completed': sum(w['completed'] for w in multi),
        'succeeded': sum(w['succeeded'] for w in multi),
        'p95Ms': samples[int(len(samples)*.95)] if samples else None,
        'p99Ms': samples[int(len(samples)*.99)] if samples else None,
    },
}
for name in ['correctness', 'tuning']:
    path = root / (name + '.json')
    summary[name] = json.loads(path.read_text()) if path.exists() else None
summary['integration'] = json.loads((root / 'integration/result.json').read_text())
path = root / 'multi-maintenance.jsonl'
summary['maintenance'] = json.loads(path.read_text()) if path.exists() and path.stat().st_size else None
(root / 'summary.json').write_text(json.dumps(summary, indent=2))
versions = subprocess.check_output(['docker', 'images', '--digests', '--format', '{{.Repository}}:{{.Tag}} {{.Digest}}']).decode()
(root / 'images.txt').write_text(versions)
with tarfile.open('/tmp/stress-results.tar.gz', 'w:gz') as archive:
    for path in sorted(root.rglob('*')):
        if path.is_file() and 'edge' not in path.parts and path.suffix in {'.json', '.jsonl', '.txt'}:
            archive.add(path, arcname=str(path.relative_to(root)))
print(json.dumps({'phases':len(phases),'arrivalPhases':len(arrivals),'multi':summary['multiAggregate'],'codeSha256':source.hexdigest()}))
