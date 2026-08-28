import { asError, formatError, LiveContext, type JsonRecord } from '../postgres/live-context.ts';
import { runPostgresIntegration } from '../postgres/live-suite.ts';
import { integrationRuntime } from '../postgres/runtime.ts';

const runtime = integrationRuntime();
const context = new LiveContext(runtime);
let failure: Error | undefined;
let result: JsonRecord | undefined;

try {
  result = await runPostgresIntegration(context, runtime.version.deno);
} catch (error) {
  failure = asError(error);
} finally {
  const cleanupFailures = await context.cleanupUsers();
  if (cleanupFailures.length > 0 && failure === undefined) {
    failure = new Error(cleanupFailures.join(' '));
  }
}

const output: JsonRecord =
  failure === undefined
    ? (result ?? { result: 'failed' })
    : { failure: formatError(failure), result: 'failed' };
await runtime.writeTextFile(context.resultsFile, `${JSON.stringify(output, null, 2)}\n`);
if (failure !== undefined) {
  throw failure;
}
