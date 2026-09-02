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
    const parsed = this.parts(word.parts, environment);
    const generated = staticGeneratedValue(word);
    return generated === undefined ? parsed : literalWord(generated);
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

  private parts(parts: readonly WordPart[], environment: ShellEnvironment): CommandWord {
    let value = '';
    let dynamic: Extract<CommandWord, { readonly kind: 'dynamic' }> | undefined;
    for (const part of parts) {
      const next = this.part(part, environment);
      if (next.kind === 'dynamic') {
        dynamic ??= next;
      } else {
        value += next.value;
      }
    }
    return dynamic === undefined
      ? literalWord(value)
      : dynamicWord(value || dynamic.value, dynamic.source);
  }

  private part(part: WordPart, environment: ShellEnvironment): CommandWord {
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
        return (
          environment.get(part.text.replaceAll(/^\$\{?|\}$/gu, '')) ??
          dynamicWord(part.text, 'parameter')
        );
      }
      case 'ParameterExpansion': {
        if (part.operand !== undefined) {
          this.word(part.operand, environment);
        }
        return part.operator === undefined
          ? (environment.get(part.parameter) ?? dynamicWord(part.parameter, 'parameter'))
          : dynamicWord(part.parameter, 'expansion');
      }
      case 'CommandExpansion':
      case 'ProcessSubstitution': {
        if (part.script !== undefined) {
          this.#visitScript(part.script, new Map(environment));
        }
        return dynamicWord(part.text, 'substitution');
      }
      case 'ArithmeticExpansion': {
        if (part.expression !== undefined) {
          this.arithmetic(part.expression, environment);
        }
        return dynamicWord(part.text, 'expansion');
      }
      case 'ExtendedGlob':
      case 'BraceExpansion': {
        return dynamicWord(part.text, 'expansion');
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
      if (value === undefined) {
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

const staticGeneratedValue = (word: Word): string | undefined => {
  const script = soleCommandExpansion(word);
  if (script === undefined || (script.errors?.length ?? 0) > 0 || script.commands.length !== 1) {
    return undefined;
  }
  const [statement] = script.commands;
  if (
    statement === undefined ||
    statement.background === true ||
    statement.redirects.length > 0 ||
    statement.command.type !== 'Command'
  ) {
    return undefined;
  }
  return staticCommandOutput(statement.command);
};

const staticCommandOutput = (command: Command): string | undefined => {
  if (
    command.name === undefined ||
    command.prefix.length > 0 ||
    !wordIsStatic(command.name) ||
    command.suffix.some((part) => !wordIsStatic(part))
  ) {
    return undefined;
  }
  const head = command.name.value.slice(command.name.value.lastIndexOf('/') + 1);
  const arguments_ = command.suffix.map((part) => part.value);
  if (head === 'printf' && arguments_.length === 2) {
    const [format, value] = arguments_;
    if (format === '%s' || format === String.raw`%s\n`) {
      return value ?? '';
    }
  }
  if (head === 'cat' && arguments_.length === 0 && command.redirects.length === 1) {
    const [redirect] = command.redirects;
    if (
      (redirect?.operator === '<<' || redirect?.operator === '<<-') &&
      redirect.heredocQuoted === true
    ) {
      return (redirect.content ?? '').replace(/\n+$/u, '');
    }
  }
  return undefined;
};

const soleCommandExpansion = (word: Word): ParsedScript | undefined => {
  const parts = word.parts ?? [];
  if (parts.length !== 1) {
    return undefined;
  }
  const [part] = parts;
  if (part?.type === 'CommandExpansion') {
    return part.script;
  }
  if (part?.type !== 'DoubleQuoted' || part.parts.length !== 1) {
    return undefined;
  }
  const [nested] = part.parts;
  return nested?.type === 'CommandExpansion' ? nested.script : undefined;
};

const wordIsStatic = (word: Word): boolean =>
  (word.parts ?? []).every((part) => partIsStatic(part));

const partIsStatic = (part: WordPart): boolean => {
  if (part.type === 'Literal' || part.type === 'SingleQuoted' || part.type === 'AnsiCQuoted') {
    return true;
  }
  if (part.type === 'DoubleQuoted' || part.type === 'LocaleString') {
    return part.parts.every((nested) => partIsStatic(nested));
  }
  return false;
};
