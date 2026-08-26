const CONTENT_TYPES: Readonly<Record<string, string>> = {
  css: 'text/css; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  json: 'application/json',
  md: 'text/markdown; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  svg: 'image/svg+xml',
  toml: 'application/toml',
  ts: 'text/typescript; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  yaml: 'application/yaml',
  yml: 'application/yaml',
};

export const contentTypeForPath = (path: string): string => {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return CONTENT_TYPES[extension] ?? 'application/octet-stream';
};
