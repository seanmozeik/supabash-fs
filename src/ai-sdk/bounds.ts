export const DEFAULT_MAX_BASH_OUTPUT = 262_144;
export const DEFAULT_MAX_IMAGE_BYTES = 5_242_880;
export const TRUNCATION_MARKER = '\n[truncated]\n';

export const boundText = (value: string, max: number): string => {
  if (value.length <= max) {
    return value;
  }
  const keep = Math.max(0, max - TRUNCATION_MARKER.length);
  return `${value.slice(0, keep)}${TRUNCATION_MARKER}`;
};
