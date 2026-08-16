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
        __BUILD_SHA__: 'readonly',
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
      // React Compiler-aware rules (eslint-plugin-react-hooks v7) are very
      // strict and target rewrites under React Compiler. We measured adopting
      // the compiler on 2026-08-06 and decided against it for now — see the
      // "React Compiler" section in AGENTS.md for the numbers. Keep the rest as
      // warnings; they still flag genuine Rules-of-React problems.
      //
      // `set-state-in-effect` is OFF rather than 'warn' on purpose. It fired 80
      // times, and we have no intention of acting on any of them while the
      // compiler is off the table. Left at 'warn' it buried the ~50 warnings we
      // do care about, which is the only thing that makes lint output useless.
      // Turn it back on if the compiler is ever adopted — it is that migration's
      // to-do list.
      'react-hooks/set-state-in-effect': 'off',
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
    // Cloudflare Workers (deckloom-og): modules format, but the runtime globals
    // are the Workers/service-worker set — `fetch`, `Response`, `URL`, `crypto`.
    // Without this block they'd all read as no-undef.
    files: ['cloudflare/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.serviceworker,
      },
    },
    rules: {
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-useless-escape': 'warn',
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
