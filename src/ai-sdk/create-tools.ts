import type { ToolSet } from 'ai';
import type { IFileSystem } from 'just-bash/browser';

import type { ApplyPatchOptions } from '../patch/operations.js';
import { createApplyPatchTool } from './apply-patch-tool.js';
import { createWorkspaceBashTool } from './bash.js';
import type { CreateToolsOptions } from './options.js';

export type WorkspaceToolSet = ToolSet;

export interface WorkspaceTools {
  readonly tools: WorkspaceToolSet;
  readonly filesystem: IFileSystem;
}

export const createTools = async (options: CreateToolsOptions): Promise<WorkspaceTools> => {
  const toolWorkspace = { fs: options.filesystem };
  const bash = await createWorkspaceBashTool(toolWorkspace, options.bash);
  const applyPatch =
    options.applyPatch === false
      ? undefined
      : createApplyPatchTool(toolWorkspace, applyPatchOptions(options.applyPatch));
  const tools: ToolSet = { bash, ...(applyPatch !== undefined && { apply_patch: applyPatch }) };
  if (options.viewImage?.enabled === true) {
    const { createViewImageTool } = await import('./view-image.js');
    tools['view_image'] = createViewImageTool(toolWorkspace, options.viewImage.maxBytes);
  }
  return { tools, filesystem: options.filesystem };
};

const applyPatchOptions = (value: CreateToolsOptions['applyPatch']): ApplyPatchOptions =>
  value === undefined || value === true || value === false ? {} : value;
