import { openai } from '@ai-sdk/openai';
import type { Tool } from 'ai';

import type { Workspace } from '../api/contracts.js';
import { applyPatch } from '../patch/executor.js';
import type {
  ApplyPatchOperation,
  ApplyPatchOptions,
  ApplyPatchResult,
} from '../patch/operations.js';
import { DEFAULT_MAX_BASH_OUTPUT, boundText } from './bounds.js';
import { safeToolText } from './redact.js';

export const createApplyPatchTool = (workspace: Workspace, options: ApplyPatchOptions = {}): Tool =>
  openai.tools.applyPatch({
    execute: async ({ operation }): Promise<ApplyPatchResult> => {
      const result = await applyPatch(workspace, asPatchOperation(operation), options);
      return {
        status: result.status,
        ...(result.output !== undefined && {
          output: safeToolText(result.output, DEFAULT_MAX_BASH_OUTPUT, boundText),
        }),
      };
    },
  });

interface ProviderPatchOperation {
  readonly type: string;
  readonly path: string;
  readonly diff?: string;
  readonly moveTo?: string;
}

const asPatchOperation = (operation: ProviderPatchOperation): ApplyPatchOperation => {
  if (operation.type === 'delete_file') {
    return { path: operation.path, type: 'delete_file' };
  }
  if (operation.type === 'create_file') {
    return { diff: operation.diff ?? '', path: operation.path, type: 'create_file' };
  }
  return operation.moveTo === undefined
    ? { diff: operation.diff ?? '', path: operation.path, type: 'update_file' }
    : {
        diff: operation.diff ?? '',
        moveTo: operation.moveTo,
        path: operation.path,
        type: 'update_file',
      };
};
