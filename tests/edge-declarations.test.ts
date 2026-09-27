import type { NetworkConfig } from 'just-bash/browser';
import { describe, expect, expectTypeOf, test } from 'vitest';

import { checkDeclarationDependencies } from '../scripts/build/declaration-dependencies.ts';
import type { PinnedConnectionOwnerFactory } from '../scripts/build/edge-dns-pin.d.ts';

const check = (source: string): void => {
  checkDeclarationDependencies(
    'ai-sdk/index.d.ts',
    source,
    new Set(['shared.d.ts']),
    new Set(['ai']),
  );
};

describe('edge declaration dependencies', () => {
  test('keeps the browser DNS transport adapter compatible with upstream', () => {
    expectTypeOf<PinnedConnectionOwnerFactory>().toExtend<
      NonNullable<NetworkConfig['_createConnectionOwner']>
    >();
    expectTypeOf<
      NonNullable<NetworkConfig['_createConnectionOwner']>
    >().toExtend<PinnedConnectionOwnerFactory>();
  });

  test.each([
    '/// <reference types="node" />',
    "/// <reference types = 'node' resolution-mode='import' />",
    '/// <reference path="../../node_modules/@types/node/index.d.ts" />',
    '/// <reference path="./missing.d.ts" />',
    '/// <reference path="/shared.d.ts" />',
    'import type { Buffer } from "node:buffer";',
    'declare module "node:buffer" { interface File {} }',
    'type T = import("undeclared").T;',
  ])('rejects an unbundled dependency: %s', (source) => {
    expect(() => {
      check(source);
    }).toThrow(/(?:unbundled|forbidden external) declaration/u);
  });

  test.each([
    '/// <reference types="ai" />',
    '/// <reference path="../shared.d.ts" />',
    'import type { T } from "../shared.js";',
    'export type { Tool } from "ai";',
    '/* /// <reference types="node" /> */',
    '// import "node:fs";',
  ])('accepts bundled declarations and declared peers: %s', (source) => {
    expect(() => {
      check(source);
    }).not.toThrow();
  });
});
