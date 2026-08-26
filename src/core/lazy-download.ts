export type LazyDownload = () => Promise<Uint8Array>;

export const deduplicateDownload = (download: LazyDownload): LazyDownload => {
  let current: Promise<Uint8Array> | undefined;
  return () => {
    current ??= download().catch((error: unknown) => {
      current = undefined;
      throw error;
    });
    return current;
  };
};
