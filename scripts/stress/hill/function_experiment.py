"""Compare cached PL/pgSQL query plans with the candidate's SQL helpers."""
from pathlib import Path
import re
import subprocess
import sys

mode = sys.argv[1]
if mode not in ['cached', 'baseline'] or not Path('/tmp/hill-config.json').exists():
    raise RuntimeError('Invalid disposable experiment.')
source = Path('/workspace/sql/postgres/0003_versioned_entries.sql').read_text()
statements = []
for name in ['allowed_workspaces', 'entries_at']:
    match = re.search(r'create function supabash\.' + name + r'\(.*?\$function\$;', source, re.S)
    if match is None:
        raise RuntimeError(f'Missing function {name}.')
    statement = match.group().replace('create function', 'create or replace function', 1)
    # Normalize the retained implementation to its earlier SQL-language form.
    statement = statement.replace('language plpgsql stable', 'language sql stable', 1)
    statement = statement.replace('as $function$\nbegin\n  return query\n', 'as $function$\n', 1)
    statement = statement.replace('\nend\n$function$;', '\n$function$;', 1)
    if mode == 'cached':
        statement = statement.replace('language sql stable', 'language plpgsql stable', 1)
        statement = statement.replace('as $function$\n', 'as $function$\nbegin\n  return query\n', 1)
        statement = statement.replace('\n$function$;', '\nend\n$function$;', 1)
    statements.append(statement)
subprocess.run(['docker', 'exec', '-i', 'supabase_db_stack', 'psql', '-U', 'supabase_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'],
               input='begin;\n' + '\n'.join(statements) + '\ncommit;', text=True, check=True)
print(f'Applied {mode} query-plan experiment.')
