import { composeDeClankConfig, coreBaseConfig } from '@seanmozeik/de-clank/config';
import { defineConfig } from 'oxlint';

const projectConfig = defineConfig({
  env: { browser: true, es2024: true, node: true },
  globals: { Bun: 'readonly' },
  ignorePatterns: ['coverage/**', 'dist/**', 'node_modules/**'],
});

export default composeDeClankConfig(coreBaseConfig, projectConfig);
