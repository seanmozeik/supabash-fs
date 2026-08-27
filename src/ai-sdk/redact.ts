const SECRET_PATTERN =
  /Bearer\s+[^\s]+|sb_(?:secret|publishable)_[A-Za-z0-9]+|https?:\/\/[^\s]*token=[^\s]+/giu;

export const redactSecrets = (value: string): string =>
  value.replaceAll(SECRET_PATTERN, '[redacted]');

export const safeToolText = (
  value: string,
  max: number,
  bound: (text: string, limit: number) => string,
): string => bound(redactSecrets(value), max);
