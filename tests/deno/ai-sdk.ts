import type { Workspace } from '@seanmozeik/supabash-fs';
import { createTools } from '@seanmozeik/supabash-fs/ai-sdk';
import type { ToolSet } from 'ai';

export const bindWorkspaceTools = (
  workspace: Workspace,
): Promise<{ readonly tools: ToolSet; readonly workspace: Workspace }> =>
  createTools({ workspace });
