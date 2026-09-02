import type { ToolSet } from 'ai';

import type { Workspace } from '../api/contracts.js';
import { createWorkspaceFileSystemView } from '../core/filesystem-view.js';
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
  const toolWorkspace =
    options.view === undefined
      ? options.workspace
      : { fs: createWorkspaceFileSystemView(options.workspace.fs, options.view) };
  const bash = await createWorkspaceBashTool(toolWorkspace, options.bash);
  const applyPatch =
    options.applyPatch === false
      ? undefined
      : createApplyPatchTool(toolWorkspace, applyPatchOptions(options.applyPatch));
  if (options.viewImage?.enabled !== true) {
    if (applyPatch === undefined) {
      return { tools: { bash }, workspace: options.workspace };
    }
    return { tools: { apply_patch: applyPatch, bash }, workspace: options.workspace };
  }
  const { createViewImageTool } = await import('./view-image.js');
  const viewImage = createViewImageTool(toolWorkspace, options.viewImage.maxBytes);
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
