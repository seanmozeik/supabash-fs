import type { ToolSet } from 'ai';

export interface ToolInvocationResult {
  readonly exitCode?: number;
  readonly output?: string;
  readonly status?: string;
  readonly stderr?: string;
  readonly stdout?: string;
}

export const invokeTool = async (
  tool: ToolSet[string] | undefined,
  input: unknown,
): Promise<ToolInvocationResult> => {
  if (tool?.execute === undefined) {
    throw new Error('Tool execute is missing.');
  }
  const value: unknown = await Promise.resolve(
    tool.execute(input, { context: {}, messages: [], toolCallId: crypto.randomUUID() }),
  );
  return parseToolResult(value);
};

export const resultField = <Key extends keyof ToolInvocationResult>(
  value: ToolInvocationResult,
  key: Key,
): ToolInvocationResult[Key] => value[key];

const parseToolResult = (value: unknown): ToolInvocationResult => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Tool returned an invalid result.');
  }
  const exitCode = 'exitCode' in value ? value.exitCode : undefined;
  const output = 'output' in value ? value.output : undefined;
  const status = 'status' in value ? value.status : undefined;
  const stderr = 'stderr' in value ? value.stderr : undefined;
  const stdout = 'stdout' in value ? value.stdout : undefined;
  return {
    ...(typeof exitCode === 'number' && { exitCode }),
    ...(typeof output === 'string' && { output }),
    ...(typeof status === 'string' && { status }),
    ...(typeof stderr === 'string' && { stderr }),
    ...(typeof stdout === 'string' && { stdout }),
  };
};
