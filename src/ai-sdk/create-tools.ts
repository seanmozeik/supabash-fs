import type { ToolSet } from 'ai';

import type { Workspace } from '../api/contracts.js';
import type { ApplyPatchOptions } from '../patch/operations.js';
import { createApplyPatchTool } from './apply-patch-tool.js';
import { createWorkspaceBashTool } from './bash.js';
import type { CreateToolsOptions } from './options.js';

export type WorkspaceToolSet = ToolSet;

export interface WorkspaceTools {
  readonly tools: WorkspaceToolSet;
  readonly workspace: Workspace;
}

export const createTools = async (options: CreateToolsOptions): Promise<WorkspaceTools> => {
  const bash = await createWorkspaceBashTool(options.workspace, options.bash);
  const applyPatch =
    options.applyPatch === false
      ? undefined
      : createApplyPatchTool(options.workspace, applyPatchOptions(options.applyPatch));
  if (options.viewImage?.enabled !== true) {
    if (applyPatch === undefined) {
      return { tools: { bash }, workspace: options.workspace };
    }
    return { tools: { apply_patch: applyPatch, bash }, workspace: options.workspace };
  }
  const { createViewImageTool } = await import('./view-image.js');
  const viewImage = createViewImageTool(options.workspace, options.viewImage.maxBytes);
  if (applyPatch === undefined) {
    return { tools: { bash, view_image: viewImage }, workspace: options.workspace };
  }
  return {
    tools: { apply_patch: applyPatch, bash, view_image: viewImage },
    workspace: options.workspace,
  };
};

const applyPatchOptions = (value: CreateToolsOptions['applyPatch']): ApplyPatchOptions =>
  value === undefined || value === true || value === false ? {} : value;
