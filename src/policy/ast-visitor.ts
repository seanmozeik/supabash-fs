import type {
  Command,
  CompoundList,
  Function as BashFunction,
  Node,
  ParsedScript,
  Redirect,
  Statement,
} from 'unbash';

import { applyAssignments, AstValues, type ShellEnvironment } from './ast-values.js';
import {
  dynamicWord,
  literalWord,
  segmentFromWords,
  type CommandRedirect,
  type CommandSegment,
  type CommandWord,
  type SegmentJoiner,
} from './segments.js';
import { denyPolicy, type CommandInspectDecision } from './types.js';

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const MAX_FOR_UNROLL = 32;

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

export class CommandVisitor {
  readonly segments: CommandSegment[] = [];
  decision: CommandInspectDecision | undefined;
  readonly #functions = new Map<string, BashFunction>();
  readonly #activeFunctions = new Set<string>();
  readonly #values = new AstValues((script, environment) => {
    this.script(script, environment);
  });

  script(script: ParsedScript, environment: ShellEnvironment): void {
    for (const statement of script.commands) {
      this.statement(statement, environment);
    }
  }

  private statement(statement: Statement, environment: ShellEnvironment): void {
    const before = this.segments.length;
    this.node(statement.command, environment);
    if (statement.redirects.length > 0) {
      this.addRedirects(before, statement.redirects, environment);
    }
  }

  private node(node: Node, environment: ShellEnvironment): void {
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

  private structuredNode(node: StructuredNode, environment: ShellEnvironment): void {
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
        this.forLoop(node, environment);
        break;
      }
      case 'While': {
        this.compound(node.clause, new Map(environment));
        this.compound(node.body, new Map(environment));
        break;
      }
      case 'Function': {
        this.defineFunction(node, environment);
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
        this.arithmeticFor(node, environment);
        break;
      }
      default: {
        unreachable(node);
      }
    }
  }

  private compound(list: CompoundList, environment: ShellEnvironment): void {
    for (const statement of list.commands) {
      this.statement(statement, environment);
    }
  }

  private command(command: Command, environment: ShellEnvironment): void {
    const assignmentValues = command.prefix.map((assignment) =>
      assignment.value === undefined
        ? literalWord('')
        : this.#values.word(assignment.value, environment),
    );
    const head =
      command.name === undefined ? undefined : this.#values.word(command.name, environment);
    const words = command.suffix.map((word) => this.#values.word(word, environment));
    const redirects = this.redirects(command.redirects, environment);
    if (command.name === undefined) {
      applyAssignments(command, assignmentValues, environment);
      return;
    }
    if (head?.kind === 'literal' && this.#functions.has(head.value)) {
      this.invokeFunction(head.value, words, command, assignmentValues, environment);
      this.addRedirects(this.segments.length, command.redirects, environment);
      return;
    }
    this.segments.push(segmentFromWords([head ?? dynamicWord(''), ...words], redirects));
  }

  private invokeFunction(
    name: string,
    arguments_: readonly CommandWord[],
    command: Command,
    assignmentValues: readonly CommandWord[],
    environment: ShellEnvironment,
  ): void {
    const definition = this.#functions.get(name);
    if (definition === undefined) {
      return;
    }
    if (this.#activeFunctions.has(name)) {
      this.fail(`Recursive function call: ${name}`);
      return;
    }
    this.#activeFunctions.add(name);
    const call = new Map(environment);
    applyAssignments(command, assignmentValues, call);
    for (const key of call.keys()) {
      if (/^[0-9]+$/u.test(key)) {
        call.delete(key);
      }
    }
    for (const [index, word] of arguments_.entries()) {
      call.set(String(index + 1), word);
    }
    try {
      this.node(definition.body, call);
      const prefixNames = new Set(
        command.prefix.flatMap((assignment) =>
          assignment.name === undefined ? [] : [assignment.name],
        ),
      );
      for (const [key, value] of call) {
        if (!/^[0-9]+$/u.test(key) && !prefixNames.has(key)) {
          environment.set(key, value);
        }
      }
    } finally {
      this.#activeFunctions.delete(name);
    }
  }

  private forLoop(
    node: Extract<StructuredNode, { readonly type: 'For' | 'Select' }>,
    environment: ShellEnvironment,
  ): void {
    const name = this.#values.word(node.name, environment);
    const values = node.wordlist.map((word) => this.#values.word(word, environment));
    if (
      name.kind === 'literal' &&
      VARIABLE_NAME.test(name.value) &&
      values.length > 0 &&
      values.length <= MAX_FOR_UNROLL &&
      values.every((value) => value.kind === 'literal')
    ) {
      for (const value of new Set(values.map((entry) => entry.value))) {
        this.compound(node.body, new Map([...environment, [name.value, literalWord(value)]]));
      }
      return;
    }
    if (name.kind === 'literal' && VARIABLE_NAME.test(name.value)) {
      this.compound(
        node.body,
        new Map([...environment, [name.value, dynamicWord(name.value, 'loop')]]),
      );
      return;
    }
    this.compound(node.body, new Map(environment));
  }

  private defineFunction(node: BashFunction, environment: ShellEnvironment): void {
    const name = this.#values.word(node.name, environment);
    if (name.kind !== 'literal') {
      this.fail('The function name is not static.');
      return;
    }
    if (VARIABLE_NAME.test(name.value)) {
      this.#functions.set(name.value, node);
    }
  }

  private arithmeticFor(
    node: Extract<StructuredNode, { readonly type: 'ArithmeticFor' }>,
    environment: ShellEnvironment,
  ): void {
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
  }

  private joined(
    commands: readonly Node[],
    operators: readonly SegmentJoiner[],
    environment: ShellEnvironment,
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
    environment: ShellEnvironment,
  ): void {
    const parsed = this.redirects(redirects, environment);
    if (parsed.length === 0) {
      return;
    }
    const index = Math.max(segmentIndex, this.segments.length - 1);
    const segment = this.segments[index];
    if (segment === undefined) {
      this.segments.push(segmentFromWords([literalWord('true')], parsed));
    } else {
      this.segments[index] = { ...segment, redirects: [...segment.redirects, ...parsed] };
    }
  }

  private redirects(
    redirects: readonly Redirect[],
    environment: ShellEnvironment,
  ): readonly CommandRedirect[] {
    return redirects.map((redirect) => {
      if (redirect.body !== undefined) {
        this.#values.word(redirect.body, environment);
      }
      return {
        op: redirect.operator,
        target:
          redirect.target === undefined
            ? dynamicWord(redirect.operator)
            : this.#values.word(redirect.target, environment),
      };
    });
  }

  private fail(reason: string): void {
    this.decision ??= denyPolicy('unsupported-syntax', reason);
  }
}

const unreachable = (value: never): never => {
  throw new Error(`Unsupported Unbash node: ${String(value)}`);
};
