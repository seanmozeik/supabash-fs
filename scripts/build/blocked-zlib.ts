/** Import-safe constants; only execution of a compression operation throws. */
export const constants = {
  Z_BEST_COMPRESSION: 9,
  Z_BEST_SPEED: 1,
  Z_DEFAULT_COMPRESSION: -1,
} as const;

export const gzipSync = (): never => {
  throw new Error('Compression is not supported in Supabash.');
};

export const gunzipSync = (): never => {
  throw new Error('Compression is not supported in Supabash.');
};
