import type {
  ArithmeticExpression,
  Command,
  ParsedScript,
  TestExpression,
  Word,
  WordPart,
} from 'unbash';

import { dynamicWord, literalWord, type CommandWord } from './segments.js';

export type ShellEnvironment = Map<string, CommandWord>;

type ScriptVisitor = (script: ParsedScript, environment: ShellEnvironment) => void;

export class AstValues {
  readonly #visitScript: ScriptVisitor;

  constructor(visitScript: ScriptVisitor) {
    this.#visitScript = visitScript;
  }

  word(word: Word, environment: ShellEnvironment): CommandWord {
    if (word.parts === undefined) {
      return literalWord(word.value);
    }
    return this.parts(word.parts, environment) ?? dynamicWord(word.text);
  }

  arithmetic(expression: ArithmeticExpression, environment: ShellEnvironment): void {
    switch (expression.type) {
      case 'ArithmeticBinary': {
        this.arithmetic(expression.left, environment);
        this.arithmetic(expression.right, environment);
        break;
      }
      case 'ArithmeticUnary': {
        this.arithmetic(expression.operand, environment);
        break;
      }
      case 'ArithmeticTernary': {
        this.arithmetic(expression.test, environment);
        this.arithmetic(expression.consequent, environment);
        this.arithmetic(expression.alternate, environment);
        break;
      }
      case 'ArithmeticGroup': {
        this.arithmetic(expression.expression, environment);
        break;
      }
      case 'ArithmeticCommandExpansion': {
        if (expression.script !== undefined) {
          this.#visitScript(expression.script, new Map(environment));
        }
        break;
      }
      case 'ArithmeticWord': {
        if (expression.parts !== undefined) {
          this.parts(expression.parts, environment);
        }
        break;
      }
      default: {
        unreachable(expression);
      }
    }
  }

  testExpression(expression: TestExpression, environment: ShellEnvironment): void {
    switch (expression.type) {
      case 'TestUnary': {
        this.word(expression.operand, environment);
        break;
      }
      case 'TestBinary': {
        this.word(expression.left, environment);
        this.word(expression.right, environment);
        break;
      }
      case 'TestLogical': {
        this.testExpression(expression.left, environment);
        this.testExpression(expression.right, environment);
        break;
      }
      case 'TestNot': {
        this.testExpression(expression.operand, environment);
        break;
      }
      case 'TestGroup': {
        this.testExpression(expression.expression, environment);
        break;
      }
      default: {
        unreachable(expression);
      }
    }
  }

  private parts(
    parts: readonly WordPart[],
    environment: ShellEnvironment,
  ): CommandWord | undefined {
    let value = '';
    for (const part of parts) {
      const next = this.part(part, environment);
      if (next === undefined || next.kind === 'dynamic') {
        return undefined;
      }
      value += next.value;
    }
    return literalWord(value);
  }

  private part(part: WordPart, environment: ShellEnvironment): CommandWord | undefined {
    switch (part.type) {
      case 'Literal':
      case 'SingleQuoted':
      case 'AnsiCQuoted': {
        return literalWord(part.value);
      }
      case 'DoubleQuoted':
      case 'LocaleString': {
        return this.parts(part.parts, environment);
      }
      case 'SimpleExpansion': {
        return environment.get(part.text.replaceAll(/^\$\{?|\}$/gu, ''));
      }
      case 'ParameterExpansion': {
        if (part.operand !== undefined) {
          this.word(part.operand, environment);
        }
        return part.operator === undefined ? environment.get(part.parameter) : undefined;
      }
      case 'CommandExpansion':
      case 'ProcessSubstitution': {
        if (part.script !== undefined) {
          this.#visitScript(part.script, new Map(environment));
        }
        return undefined;
      }
      case 'ArithmeticExpansion': {
        if (part.expression !== undefined) {
          this.arithmetic(part.expression, environment);
        }
        return undefined;
      }
      case 'ExtendedGlob':
      case 'BraceExpansion': {
        return undefined;
      }
      default: {
        return unreachable(part);
      }
    }
  }
}

export const applyAssignments = (
  command: Command,
  assignmentValues: readonly CommandWord[],
  environment: ShellEnvironment,
): void => {
  for (const [index, assignment] of command.prefix.entries()) {
    if (
      assignment.name !== undefined &&
      assignment.append !== true &&
      assignment.array === undefined
    ) {
      const value = assignmentValues[index];
      if (value === undefined || value.kind === 'dynamic') {
        environment.delete(assignment.name);
      } else {
        environment.set(assignment.name, value);
      }
    }
  }
};

const unreachable = (value: never): never => {
  throw new Error(`Unsupported Unbash value: ${String(value)}`);
};
