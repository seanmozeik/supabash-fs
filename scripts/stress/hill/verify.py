"""Verify saved source hashes and summarize completed synthetic operations."""
import hashlib
import json
from pathlib import Path
import sys
import tarfile

root = Path(sys.argv[1])
for role in ['server', 'generator']:
    summary = json.loads((root / f'{role}-summary.json').read_text())
    source = hashlib.sha256()
    with tarfile.open(root / f'{role}-source.tar.gz') as archive:
        files = {member.name: member for member in archive.getmembers() if member.isfile()}
        for folder in ['src', 'sql', 'dist']:
            for name in sorted((name for name in files if name.startswith(folder + '/')), key=Path):
                source.update(name.encode())
                source.update(archive.extractfile(files[name]).read())
    if source.hexdigest() != summary['candidateCodeSha256']:
        raise RuntimeError(f'{role} source hash mismatch.')
    results = summary['results']
    errors = [result for result in results if result['errors']]
    soak = summary.get('soak', {})
    print(json.dumps({'role': role, 'sourceVerified': True,
        'operations': sum(result.get('successes', result.get('succeeded', 0)) for result in results),
        'errorPhases': len(errors), 'soakOpsPerSecond': soak.get('opsPerSecond'),
        'soakP95Ms': soak.get('p95Ms'), 'soakVerifiedWrites': soak.get('verifiedWrites')}))
