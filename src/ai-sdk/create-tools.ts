import type { Tool } from 'ai';

import type { Workspace } from '../api/contracts.js';
import type { ApplyPatchOptions } from '../patch/operations.js';
import { createApplyPatchTool } from './apply-patch-tool.js';
import { createWorkspaceBashTool } from './bash.js';
import type { CreateToolsOptions } from './options.js';

export interface WorkspaceTools {
  readonly apply_patch?: Tool;
  readonly bash: Tool;
  readonly view_image?: Tool;
  readonly workspace: Workspace;
}

export const createTools = async (options: CreateToolsOptions): Promise<WorkspaceTools> => {
  const bash = await createWorkspaceBashTool(options.workspace, options.bash);
  const applyPatch =
    options.applyPatch === false
      ? undefined
      : createApplyPatchTool(options.workspace, applyPatchOptions(options.applyPatch));
  if (options.viewImage?.enabled !== true) {
    return applyPatch === undefined
      ? { bash, workspace: options.workspace }
      : { apply_patch: applyPatch, bash, workspace: options.workspace };
  }
  const { createViewImageTool } = await import('./view-image.js');
  const viewImage = createViewImageTool(options.workspace, options.viewImage.maxBytes);
  return applyPatch === undefined
    ? { bash, view_image: viewImage, workspace: options.workspace }
    : { apply_patch: applyPatch, bash, view_image: viewImage, workspace: options.workspace };
};

const applyPatchOptions = (value: CreateToolsOptions['applyPatch']): ApplyPatchOptions =>
  value === undefined || value === true || value === false ? {} : value;
