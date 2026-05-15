// Flat config — required by eslint v9+.
// Permissive baseline: catches real bugs (unused vars, no-undef, etc.) but
// doesn't enforce stylistic opinions, which is prettier's job.
//
// Run with: npm run lint
// Auto-fix:  npm run lint -- --fix

const tseslint = require('@typescript-eslint/eslint-plugin');
const tsparser = require('@typescript-eslint/parser');

module.exports = [
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        crypto: 'readonly',
        fetch: 'readonly',
        Response: 'readonly',
        Request: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        AbortSignal: 'readonly',
        btoa: 'readonly',
        atob: 'readonly',
        setTimeout: 'readonly',
        require: 'readonly',
        module: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      // The codebase uses `any` liberally for the MCP tool args (which are
      // genuinely untyped at the protocol boundary). Don't fight it.
      '@typescript-eslint/no-explicit-any': 'off',
      // Loosened — many handlers receive params they don't use.
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
      // tsconfig already enforces this where it matters.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
];
