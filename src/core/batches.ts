export const mapInBatches = async <Input, Output>(
  entries: readonly Input[],
  concurrency: number,
  transform: (entry: Input) => Promise<Output>,
): Promise<Output[]> => {
  const output: Output[] = [];
  for (let index = 0; index < entries.length; index += concurrency) {
    const batch = entries.slice(index, index + concurrency);
    output.push(...(await Promise.all(batch.map((entry) => transform(entry)))));
  }
  return output;
};
