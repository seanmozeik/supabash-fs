import { denyPolicy, type CommandInspectDecision, type PolicyReasonCode } from './types.js';

export type SegmentOp = ';' | '&&' | '||' | '|' | '|&' | '&';

export type Token =
  | { readonly kind: 'word'; readonly value: string }
  | { readonly kind: 'op'; readonly value: SegmentOp }
  | { readonly kind: 'redirect'; readonly op: string; readonly target: string };

export type TokenizeResult =
  | { readonly ok: true; readonly tokens: readonly Token[] }
  | { readonly ok: false; readonly decision: CommandInspectDecision };

const REDIRECT_OPS = ['&>>', '<<<', '<<', '>>', '<&', '>&', '<>', '&>', '>', '<'] as const;
const SEGMENT_OPS = ['|&', '&&', '||', ';', '|', '&'] as const;
const UNQUOTED_ESCAPES = ' \t$`"\\|&;<>(){}\'#';

interface Cursor {
  readonly source: string;
  index: number;
}

export const tokenizeCommand = (command: string): TokenizeResult => {
  const cursor: Cursor = { index: 0, source: command };
  const tokens: Token[] = [];
  for (;;) {
    const next = nextToken(cursor);
    if (next.kind === 'end') {
      return { ok: true, tokens };
    }
    if (next.kind === 'fail') {
      return { ok: false, decision: next.decision };
    }
    if (next.kind === 'token') {
      if (next.token.kind === 'op') {
        pushOp(tokens, next.token.value);
      } else {
        tokens.push(next.token);
      }
    }
  }
};

const nextToken = (
  cursor: Cursor,
):
  | { readonly kind: 'end' }
  | { readonly kind: 'skip' }
  | { readonly kind: 'fail'; readonly decision: CommandInspectDecision }
  | { readonly kind: 'token'; readonly token: Token } => {
  skipSpaces(cursor);
  if (cursor.index >= cursor.source.length) {
    return { kind: 'end' };
  }
  if (peek(cursor) === '#') {
    skipComment(cursor);
    return { kind: 'skip' };
  }
  if (peek(cursor) === '\n') {
    cursor.index += 1;
    return { kind: 'token', token: { kind: 'op', value: ';' } };
  }
  const redirect = readRedirect(cursor);
  if (redirect !== undefined) {
    return redirect.ok
      ? { kind: 'token', token: redirect.token }
      : { decision: redirect.decision, kind: 'fail' };
  }
  const operator = readSegmentOp(cursor);
  if (operator !== undefined) {
    return { kind: 'token', token: { kind: 'op', value: operator } };
  }
  const word = readWord(cursor);
  return word.ok
    ? { kind: 'token', token: { kind: 'word', value: word.value } }
    : { decision: word.decision, kind: 'fail' };
};

const pushOp = (tokens: Token[], value: SegmentOp): void => {
  if (tokens.length === 0 || tokens.at(-1)?.kind === 'op') {
    return;
  }
  tokens.push({ kind: 'op', value });
};

const readSegmentOp = (cursor: Cursor): SegmentOp | undefined => {
  for (const operator of SEGMENT_OPS) {
    if (cursor.source.startsWith(operator, cursor.index)) {
      cursor.index += operator.length;
      return operator;
    }
  }
  return undefined;
};

const readRedirect = (
  cursor: Cursor,
): { ok: true; token: Token } | { ok: false; decision: CommandInspectDecision } | undefined => {
  const start = cursor.index;
  while (isDigit(peek(cursor))) {
    cursor.index += 1;
  }
  const op = matchAt(cursor, REDIRECT_OPS);
  if (op === undefined) {
    cursor.index = start;
    return undefined;
  }
  cursor.index += op.length;
  if ((op === '<' || op === '>') && peek(cursor) === '(') {
    return fail('unsupported-syntax', 'Process substitution cannot be inspected safely.');
  }
  if (op === '<<') {
    return fail('unsupported-syntax', 'Here-documents cannot be inspected safely.');
  }
  skipSpaces(cursor);
  const target = readWord(cursor);
  if (!target.ok) {
    return target;
  }
  return { ok: true, token: { kind: 'redirect', op, target: target.value } };
};

const readWord = (
  cursor: Cursor,
): { ok: true; value: string } | { ok: false; decision: CommandInspectDecision } => {
  const start = cursor.index;
  let quote: '"' | "'" | undefined;
  let value = '';
  while (cursor.index < cursor.source.length) {
    const character = peek(cursor);
    if (quote === undefined && isWordBreak(cursor, character)) {
      break;
    }
    const next = takeQuoted(cursor, quote);
    if (!next.ok) {
      return next;
    }
    const { character: quoted, quote: nextQuote } = next;
    quote = nextQuote;
    value += quoted;
  }
  if (quote !== undefined) {
    return fail('unsupported-syntax', 'Command contains an unmatched quote.');
  }
  if (cursor.index === start) {
    return fail('unsupported-syntax', 'Command contains an empty word.');
  }
  return { ok: true, value };
};

const takeQuoted = (
  cursor: Cursor,
  quote: '"' | "'" | undefined,
):
  | { ok: true; character: string; quote: '"' | "'" | undefined }
  | { ok: false; decision: CommandInspectDecision } => {
  const character = take(cursor);
  if (quote === "'") {
    return character === "'"
      ? { character: '', ok: true, quote: undefined }
      : { character, ok: true, quote };
  }
  if (character === '\\') {
    return takeEscape(cursor, quote);
  }
  if (quote === undefined && (character === "'" || character === '"')) {
    return { character: '', ok: true, quote: character };
  }
  if (quote === '"' && character === '"') {
    return { character: '', ok: true, quote: undefined };
  }
  return takeSubstitution(cursor, character, quote);
};

const takeEscape = (
  cursor: Cursor,
  quote: '"' | "'" | undefined,
):
  | { ok: true; character: string; quote: '"' | "'" | undefined }
  | { ok: false; decision: CommandInspectDecision } => {
  if (cursor.index >= cursor.source.length) {
    return fail('unsupported-syntax', 'Command ends with an unfinished escape.');
  }
  const escaped = take(cursor);
  if (escaped === '\n') {
    return { character: '', ok: true, quote };
  }
  if (quote === '"' && !'"$`\\'.includes(escaped)) {
    return { character: `\\${escaped}`, ok: true, quote };
  }
  if (quote === undefined && !UNQUOTED_ESCAPES.includes(escaped)) {
    return { character: `\\${escaped}`, ok: true, quote };
  }
  return { character: escaped, ok: true, quote };
};

const takeSubstitution = (
  cursor: Cursor,
  character: string,
  quote: '"' | "'" | undefined,
):
  | { ok: true; character: string; quote: '"' | "'" | undefined }
  | { ok: false; decision: CommandInspectDecision } => {
  if (character === '`' || (character === '$' && peek(cursor) === '(')) {
    return fail('unsupported-syntax', 'Command substitution cannot be inspected safely.');
  }
  if (quote === undefined && character === '$' && peek(cursor) === "'") {
    return fail('unsupported-syntax', 'ANSI-C quoting cannot be inspected safely.');
  }
  if (quote === undefined && (character === '<' || character === '>') && peek(cursor) === '(') {
    return fail('unsupported-syntax', 'Process substitution cannot be inspected safely.');
  }
  return { character, ok: true, quote };
};

const isWordBreak = (cursor: Cursor, character: string): boolean => {
  if (character === ' ' || character === '\t' || character === '\n' || character === '#') {
    return true;
  }
  return matchAt(cursor, REDIRECT_OPS) !== undefined || matchAt(cursor, SEGMENT_OPS) !== undefined;
};

const matchAt = (cursor: Cursor, operators: readonly string[]): string | undefined => {
  for (const operator of operators) {
    if (cursor.source.startsWith(operator, cursor.index)) {
      return operator;
    }
  }
  return undefined;
};

const skipSpaces = (cursor: Cursor): void => {
  while (peek(cursor) === ' ' || peek(cursor) === '\t') {
    cursor.index += 1;
  }
};

const skipComment = (cursor: Cursor): void => {
  while (cursor.index < cursor.source.length && peek(cursor) !== '\n') {
    cursor.index += 1;
  }
};

const peek = (cursor: Cursor): string => cursor.source[cursor.index] ?? '';

const take = (cursor: Cursor): string => {
  const character = peek(cursor);
  cursor.index += 1;
  return character;
};

const isDigit = (character: string): boolean => character >= '0' && character <= '9';

const fail = (
  code: PolicyReasonCode,
  reason: string,
): { ok: false; decision: CommandInspectDecision } => ({
  decision: denyPolicy(code, reason),
  ok: false,
});
