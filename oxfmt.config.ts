import base from '@seanmozeik/de-clank/oxfmt';
import { defineConfig } from 'oxfmt';

export default defineConfig({
  ...base,
  ignorePatterns: ['coverage/**', 'dist/**', 'node_modules/**'],
});
