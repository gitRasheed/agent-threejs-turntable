import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig(
  globalIgnores(['dist/', 'dist-test/']),
  { files: ['**/*.mjs'], extends: [js.configs.recommended] },
  { files: ['**/*.ts'], extends: [js.configs.recommended, tseslint.configs.strict] },
  {
    files: ['src/{evaluate,color,geometryIntegrity,types}.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{
        regex: '^(?!\\./(?:evaluate|color|geometryIntegrity|types)\\.js$)',
        message: 'Pass measured data into the pure modules. Import only other pure modules here.',
      }] }],
      'no-restricted-globals': ['error', ...new Set([...Object.keys(globals.browser), ...Object.keys(globals.node), 'globalThis'])],
      'no-restricted-syntax': ['error', { selector: 'ImportExpression', message: 'Keep dynamic loading in the host.' }],
    },
  },
);
