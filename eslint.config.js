import js from '@eslint/js'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

export default [
  {
    ignores: [
      'dist/**',
      'android/**',
      'ios/**',
      'node_modules/**',
      'public/**',
      'scripts/**',
      'coverage/**',
      '*.config.js',
    ],
  },
  js.configs.recommended,
  {
    files: ['src/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...globals.browser,
        ...globals.worker,
        __APP_VERSION__: 'readonly',
      },
    },
    plugins: {
      react,
      'react-hooks': reactHooks,
    },
    settings: {
      react: { version: 'detect' },
    },
    rules: {
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      // React 17+ JSX transform — no `import React` needed
      'react/react-in-jsx-scope': 'off',
      'react/jsx-uses-react': 'off',
      // Prop-types not used in this project (no TS either; accept the tradeoff)
      'react/prop-types': 'off',
      // Allow unescaped quotes/apostrophes in JSX text (common in UI strings)
      'react/no-unescaped-entities': 'off',
      // Warn on unused vars but ignore _-prefixed and args (common pattern here)
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      // Surface real hook bugs — this is the main reason we're adding ESLint
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // React Compiler-aware rules (eslint-plugin-react-hooks v6) are very
      // strict and target rewrites under React Compiler. We don't run the
      // compiler yet, so downgrade them to warnings to keep signal high.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/preserve-manual-memoization': 'off',
      'react-hooks/immutability': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/static-components': 'warn',
      'react-hooks/incompatible-library': 'warn',
      // Common JS noise in this codebase — keep as warnings, not errors
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-prototype-builtins': 'off',
      'no-cond-assign': ['error', 'except-parens'],
      'no-constant-binary-expression': 'warn',
      'no-useless-escape': 'warn',
      'no-useless-assignment': 'warn',
      'no-unsafe-finally': 'warn',
      'no-control-regex': 'warn',
    },
  },
  {
    // Tests run under Node + Vitest globals would normally be added, but the
    // project sets `globals: false` in Vitest config so tests import APIs
    // explicitly. Just allow Node globals here.
    files: ['src/**/*.test.{js,jsx}'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
]
