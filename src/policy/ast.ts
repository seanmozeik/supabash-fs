import {
  parse,
  type Command,
  type CompoundList,
  type Node,
  type ParsedScript,
  type Redirect,
  type Statement,
} from 'unbash';

import { AstValues } from './ast-values.js';
import {
  segmentFromWords,
  type CommandRedirect,
  type CommandSegment,
  type SegmentJoiner,
} from './segments.js';
import { denyPolicy, type CommandInspectDecision } from './types.js';

const DYNAMIC = '__supabash_dynamic_value__';
type StructuredNode = Exclude<
  Node,
  {
    readonly type:
      | 'AndOr'
      | 'BraceGroup'
      | 'Command'
      | 'CompoundList'
      | 'Pipeline'
      | 'Statement'
      | 'Subshell';
  }
>;

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
  return { ok: true, segments: visitor.segments };
};

class CommandVisitor {
  readonly segments: CommandSegment[] = [];
  readonly #functions = new Set<string>();
  readonly #values = new AstValues((script, environment) => {
    this.script(script, environment);
  });

  script(script: ParsedScript, environment: Map<string, string>): void {
    for (const statement of script.commands) {
      this.statement(statement, environment);
    }
  }

  private statement(statement: Statement, environment: Map<string, string>): void {
    const before = this.segments.length;
    this.node(statement.command, environment);
    if (statement.redirects.length > 0) {
      this.addRedirects(before, statement.redirects, environment);
    }
  }

  private node(node: Node, environment: Map<string, string>): void {
    if (node.type === 'Statement') {
      this.statement(node, environment);
      return;
    }
    if (node.type === 'Command') {
      this.command(node, environment);
      return;
    }
    if (node.type === 'Pipeline' || node.type === 'AndOr') {
      this.joined(node.commands, node.operators, environment);
      return;
    }
    if (node.type === 'CompoundList') {
      this.compound(node, environment);
      return;
    }
    if (node.type === 'BraceGroup') {
      this.compound(node.body, environment);
      return;
    }
    if (node.type === 'Subshell') {
      this.compound(node.body, new Map(environment));
      return;
    }
    this.structuredNode(node, environment);
  }

  private structuredNode(node: StructuredNode, environment: Map<string, string>): void {
    switch (node.type) {
      case 'If': {
        this.compound(node.clause, new Map(environment));
        this.compound(node.then, new Map(environment));
        if (node.else !== undefined) {
          this.node(node.else, new Map(environment));
        }
        break;
      }
      case 'For':
      case 'Select': {
        const values = node.wordlist.map((word) => this.#values.word(word, environment) ?? DYNAMIC);
        for (const value of values.length === 0 ? [DYNAMIC] : new Set(values)) {
          const scoped = new Map([...environment, [node.name.value, value]]);
          this.compound(node.body, scoped);
        }
        break;
      }
      case 'While': {
        this.compound(node.clause, new Map(environment));
        this.compound(node.body, new Map(environment));
        break;
      }
      case 'Function': {
        this.#functions.add(node.name.value);
        this.node(node.body, new Map(environment));
        this.addRedirects(this.segments.length, node.redirects, environment);
        break;
      }
      case 'Case': {
        this.#values.word(node.word, environment);
        for (const item of node.items) {
          for (const pattern of item.pattern) {
            this.#values.word(pattern, environment);
          }
          this.compound(item.body, new Map(environment));
        }
        break;
      }
      case 'Coproc': {
        this.node(node.body, new Map(environment));
        this.addRedirects(this.segments.length, node.redirects, environment);
        break;
      }
      case 'TestCommand': {
        this.#values.testExpression(node.expression, environment);
        break;
      }
      case 'ArithmeticCommand': {
        if (node.expression !== undefined) {
          this.#values.arithmetic(node.expression, environment);
        }
        break;
      }
      case 'ArithmeticFor': {
        if (node.initialize !== undefined) {
          this.#values.arithmetic(node.initialize, environment);
        }
        if (node.test !== undefined) {
          this.#values.arithmetic(node.test, environment);
        }
        if (node.update !== undefined) {
          this.#values.arithmetic(node.update, environment);
        }
        this.compound(node.body, new Map(environment));
        break;
      }
      default: {
        unreachable(node);
      }
    }
  }

  private compound(list: CompoundList, environment: Map<string, string>): void {
    for (const statement of list.commands) {
      this.statement(statement, environment);
    }
  }

  private command(command: Command, environment: Map<string, string>): void {
    const assignmentValues = command.prefix.map((assignment) =>
      assignment.value === undefined ? '' : this.#values.word(assignment.value, environment),
    );
    const head =
      command.name === undefined ? undefined : this.#values.word(command.name, environment);
    const words = command.suffix.map((word) => this.#values.word(word, environment) ?? DYNAMIC);
    const redirects = this.redirects(command.redirects, environment);
    for (const [index, assignment] of command.prefix.entries()) {
      if (
        assignment.name !== undefined &&
        assignment.append !== true &&
        assignment.array === undefined
      ) {
        const value = assignmentValues[index];
        if (value === undefined) {
          environment.delete(assignment.name);
        } else {
          environment.set(assignment.name, value);
        }
      }
    }
    if (head === undefined && command.name === undefined) {
      return;
    }
    if (head !== undefined && this.#functions.has(head)) {
      return;
    }
    this.segments.push(segmentFromWords([head ?? '', ...words], redirects));
  }

  private joined(
    commands: readonly Node[],
    operators: readonly SegmentJoiner[],
    environment: Map<string, string>,
  ): void {
    for (const [index, command] of commands.entries()) {
      const before = this.segments.length;
      this.node(command, environment);
      const joiner = operators[index];
      const last = this.segments.length - 1;
      const segment = this.segments[last];
      if (joiner !== undefined && last >= before && segment !== undefined) {
        this.segments[last] = { ...segment, joiner };
      }
    }
  }

  private addRedirects(
    segmentIndex: number,
    redirects: readonly Redirect[],
    environment: Map<string, string>,
  ): void {
    const parsed = this.redirects(redirects, environment);
    if (parsed.length === 0) {
      return;
    }
    const index = Math.max(segmentIndex, this.segments.length - 1);
    const segment = this.segments[index];
    if (segment === undefined) {
      this.segments.push(segmentFromWords(['true'], parsed));
    } else {
      this.segments[index] = { ...segment, redirects: [...segment.redirects, ...parsed] };
    }
  }

  private redirects(
    redirects: readonly Redirect[],
    environment: Map<string, string>,
  ): readonly CommandRedirect[] {
    return redirects.flatMap((redirect) => {
      if (redirect.body !== undefined) {
        this.#values.word(redirect.body, environment);
      }
      if (
        redirect.operator === '<<' ||
        redirect.operator === '<<-' ||
        redirect.operator === '<<<'
      ) {
        return [];
      }
      return [
        {
          op: redirect.operator,
          target:
            redirect.target === undefined
              ? DYNAMIC
              : (this.#values.word(redirect.target, environment) ?? DYNAMIC),
        },
      ];
    });
  }
}

const unreachable = (value: never): never => {
  throw new Error(`Unsupported Unbash node: ${String(value)}`);
};
