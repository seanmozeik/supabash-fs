import { parse } from 'unbash';

import { CommandVisitor } from './ast-visitor.js';
import type { CommandSegment } from './segments.js';
import { denyPolicy, type CommandInspectDecision } from './types.js';

export type CommandProgramResult =
  | Readonly<{ ok: true; segments: readonly CommandSegment[] }>
  | Readonly<{ decision: CommandInspectDecision; ok: false }>;

export const commandProgram = (source: string): CommandProgramResult => {
  const script = parse(source);
  if ((script.errors?.length ?? 0) > 0) {
    return {
      decision: denyPolicy('unsupported-syntax', 'Bash syntax could not be parsed safely.'),
      ok: false,
    };
  }
  const visitor = new CommandVisitor();
  visitor.script(script, new Map());
  if (visitor.decision !== undefined) {
    return { decision: visitor.decision, ok: false };
  }
  return { ok: true, segments: visitor.segments };
};
