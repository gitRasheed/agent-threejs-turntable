import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig(
  globalIgnores(['dist/', 'dist-test/']),
  { files: ['**/*.mjs'], extends: [js.configs.recommended] },
  { files: ['**/*.ts'], extends: [js.configs.recommended, tseslint.configs.strict] },
);
