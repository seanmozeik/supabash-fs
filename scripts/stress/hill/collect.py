"""Archive synthetic results and source hashes; never archive environment files."""
import hashlib
import json
from pathlib import Path
import tarfile

root = Path('/results')
if not Path('/tmp/hill-config.json').exists():
    raise RuntimeError('Disposable environment required.')
source = hashlib.sha256()
for folder in ['src', 'sql', 'dist']:
    for path in sorted((Path('/workspace') / folder).rglob('*')):
        if path.is_file():
            source.update(str(path.relative_to('/workspace')).encode())
            source.update(path.read_bytes())
results = []
for path in sorted(root.glob('*.json')):
    value = json.loads(path.read_text())
    if isinstance(value, dict) and ('opsPerSecond' in value or 'successfulOpsPerSecond' in value):
        results.append(value)
soak = []
latencies = []
kind_samples = {}
for path in sorted(root.glob('soak-[0-9]*.jsonl')):
    if path.exists() and path.stat().st_size:
        result = json.loads(path.read_text())
        soak.append(result)
        latencies.extend(json.loads((root / (result['run'] + '-latencies.json')).read_text()))
        kinds = root / (result['run'] + '-kind-latencies.json')
        if kinds.exists():
            for kind, values in json.loads(kinds.read_text()).items():
                kind_samples.setdefault(kind, []).extend(values)
latencies.sort()
operation_latency = {}
for kind, values in kind_samples.items():
    values.sort()
    operation_latency[kind] = {'count': len(values), 'p95Ms': values[int(len(values) * .95)], 'p99Ms': values[int(len(values) * .99)]}
maintenance = root / 'soak-maintenance.jsonl'
multi = {}
for path in sorted(root.glob('multi-*-*.jsonl')):
    if path.stat().st_size:
        label = path.stem[len('multi-'):].rsplit('-', 1)[0]
        multi.setdefault(label, []).append(json.loads(path.read_text()))
aggregates = {}
for label, workers in multi.items():
    samples = []
    for worker in workers:
        samples.extend(json.loads((root / (worker['run'] + '-latencies.json')).read_text()))
    samples.sort()
    aggregates[label] = {'workers': len(workers),
        'opsPerSecond': sum(worker['successfulOpsPerSecond'] for worker in workers),
        'succeeded': sum(worker['succeeded'] for worker in workers),
        'errorCount': sum(sum(worker['errors'].values()) for worker in workers),
        'droppedArrivals': sum(worker['droppedArrivals'] for worker in workers),
        'offeredPerSecond': sum(worker['offeredPerSecond'] or 0 for worker in workers),
        'p95Ms': samples[int(len(samples) * .95)], 'p99Ms': samples[int(len(samples) * .99)]}
summary = {'candidateCodeSha256': source.hexdigest(), 'results': results,
    'multi': aggregates,
    'soak': {'workers': soak, 'opsPerSecond': sum(r['successfulOpsPerSecond'] for r in soak),
        'operationLatency': operation_latency,
        'succeeded': sum(r['succeeded'] for r in soak), 'verifiedWrites': sum(r['verifiedWrites'] for r in soak),
        'p95Ms': latencies[int(len(latencies) * .95)] if latencies else None,
        'p99Ms': latencies[int(len(latencies) * .99)] if latencies else None},
    'maintenance': json.loads(maintenance.read_text()) if maintenance.exists() and maintenance.stat().st_size else None}
(root / 'hill-summary.json').write_text(json.dumps(summary, indent=2))
with tarfile.open('/tmp/hill-results.tar.gz', 'w:gz') as archive:
    for path in sorted(root.rglob('*')):
        if path.is_file() and path.suffix in ['.json', '.jsonl', '.txt'] and 'edge' not in path.parts:
            archive.add(path, arcname=str(path.relative_to(root)))
with tarfile.open('/tmp/hill-source.tar.gz', 'w:gz') as archive:
    for name in ['src', 'sql', 'dist', 'scripts', 'tests', 'package.json', 'bun.lock', 'tsconfig.json', 'deno.check.json']:
        path = Path('/workspace') / name
        if path.exists():
            archive.add(path, arcname=name)
print(json.dumps({'results': len(results), 'candidateCodeSha256': source.hexdigest(),
                  'multi': aggregates, 'soakOpsPerSecond': summary['soak']['opsPerSecond']}))
