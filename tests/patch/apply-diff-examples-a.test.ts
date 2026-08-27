import { describe, expect, it } from 'vitest';

import { applyDiff } from '../../src/patch/apply-diff.ts';

const lines = (...values: string[]): string => values.join('\n');

describe('applyDiff upstream examples 1-11', () => {
  it('example 1: README.md basic replacement', () => {
    expect(
      applyDiff(
        lines('Hello, world!', 'This is my project.'),
        lines('-Hello, world!', '+Hello, V4A diff format!'),
        'default',
      ),
    ).toBe(lines('Hello, V4A diff format!', 'This is my project.'));
  });

  it('example 2: greet.py function replacement', () => {
    const input = lines(
      'def greet(name):',
      '    return "Hello " + name',
      '',
      'if __name__ == "__main__":',
      '    print(greet("Alice"))',
    );
    const diff = lines(
      '-def greet(name):',
      '-    return "Hello " + name',
      '+def greet(name: str) -> str:',
      '+    return f"Hello, {name}!"',
    );
    expect(applyDiff(input, diff, 'default')).toBe(
      lines(
        'def greet(name: str) -> str:',
        '    return f"Hello, {name}!"',
        '',
        'if __name__ == "__main__":',
        '    print(greet("Alice"))',
      ),
    );
  });

  it('example 3: config.yml toggle debug flag', () => {
    expect(
      applyDiff(
        lines('env: dev', 'debug: false', 'log_level: info'),
        lines(' env: dev', '-debug: false', '+debug: true', ' log_level: info'),
        'default',
      ),
    ).toBe(lines('env: dev', 'debug: true', 'log_level: info'));
  });

  it('example 4: app.py insert import sys', () => {
    const input = lines(
      'import os',
      '',
      'def main():',
      '    print("Running app")',
      '',
      'if __name__ == "__main__":',
      '    main()',
    );
    const diff = lines(
      ' import os',
      '+import sys',
      '',
      ' def main():',
      '     print("Running app")',
      '',
      ' if __name__ == "__main__":',
      '     main()',
    );
    expect(applyDiff(input, diff, 'default')).toBe(
      lines(
        'import os',
        'import sys',
        '',
        'def main():',
        '    print("Running app")',
        '',
        'if __name__ == "__main__":',
        '    main()',
      ),
    );
  });

  it('example 5: service.py remove debug logging', () => {
    const input = lines(
      'def handle_request(req):',
      '    print("DEBUG: got request", req)',
      '    return {"status": "ok"}',
    );
    const diff = lines(
      ' def handle_request(req):',
      '-    print("DEBUG: got request", req)',
      '     return {"status": "ok"}',
    );
    expect(applyDiff(input, diff, 'default')).toBe(
      lines('def handle_request(req):', '    return {"status": "ok"}'),
    );
  });

  it('example 6: math_utils.py update add() with @@ context', () => {
    const input = lines(
      'def add(a, b):',
      '    return a + b',
      '',
      'def mul(a, b):',
      '    return a * b',
    );
    const diff = lines(
      '@@',
      '-def add(a, b):',
      '-    return a + b',
      '+def add(a: int, b: int) -> int:',
      '+    """Add two integers."""',
      '+    return a + b',
    );
    expect(applyDiff(input, diff, 'default')).toBe(
      lines(
        'def add(a: int, b: int) -> int:',
        '    """Add two integers."""',
        '    return a + b',
        '',
        'def mul(a, b):',
        '    return a * b',
      ),
    );
  });

  it('example 7: repository.py update get_user method', () => {
    const input = lines(
      'class UserRepository:',
      '    def get_user(self, user_id):',
      '        raise NotImplementedError',
      '',
      '    def save_user(self, user):',
      '        raise NotImplementedError',
    );
    const diff = lines(
      '@@ class UserRepository:',
      '     def get_user(self, user_id):',
      '-        raise NotImplementedError',
      '+        """Fetch a user by ID or return None."""',
      '+        return self._db.get(user_id)',
    );
    expect(applyDiff(input, diff, 'default')).toBe(
      lines(
        'class UserRepository:',
        '    def get_user(self, user_id):',
        '        """Fetch a user by ID or return None."""',
        '        return self._db.get(user_id)',
        '',
        '    def save_user(self, user):',
        '        raise NotImplementedError',
      ),
    );
  });

  it('example 8: settings.py bump timeout', () => {
    expect(
      applyDiff(
        lines('API_URL = "https://api.example.com"', 'TIMEOUT_SECONDS = 5', 'RETRIES = 1'),
        lines(
          ' API_URL = "https://api.example.com"',
          '-TIMEOUT_SECONDS = 5',
          '+TIMEOUT_SECONDS = 10',
          ' RETRIES = 1',
        ),
        'default',
      ),
    ).toBe(lines('API_URL = "https://api.example.com"', 'TIMEOUT_SECONDS = 10', 'RETRIES = 1'));
  });

  it('example 9: docs/intro.txt create file', () => {
    expect(
      applyDiff(
        '',
        lines('+Welcome to the project!', '+This documentation will guide you through setup.'),
        'create',
      ),
    ).toBe(lines('Welcome to the project!', 'This documentation will guide you through setup.'));
  });

  it('example 10: utils/strings.py create module', () => {
    expect(
      applyDiff(
        '',
        lines(
          '+def slugify(text: str) -> str:',
          '+    return text.lower().replace(" ", "-")',
          '+',
          '+__all__ = ["slugify"]',
        ),
        'create',
      ),
    ).toBe(
      lines(
        'def slugify(text: str) -> str:',
        '    return text.lower().replace(" ", "-")',
        '',
        '__all__ = ["slugify"]',
      ),
    );
  });

  it('example 11: app.py create + main.py update', () => {
    const appDiff = lines('+def run():', '+    print("Hello from app.run()")', '+');
    const mainDiff = lines(
      '-from app import run',
      '+from app import run',
      ' ',
      ' if __name__ == "__main__":',
      '     run()',
    );
    expect(applyDiff('', appDiff, 'create')).toBe(
      lines('def run():', '    print("Hello from app.run()")', ''),
    );
    expect(
      applyDiff(
        lines('from app import run', '', 'if __name__ == "__main__":', '    run()'),
        mainDiff,
        'default',
      ),
    ).toBe(lines('from app import run', '', 'if __name__ == "__main__":', '    run()'));
  });
});
