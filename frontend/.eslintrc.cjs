/**
 * ESLint config for the Vite + React + TypeScript frontend.
 *
 * Previously absent — `npm run lint` errored with "couldn't find a configuration
 * file". This restores a working linter using the already-installed
 * @typescript-eslint parser/plugin (no new dependencies, no type-aware `project`
 * pass so it stays fast). Rules are tuned to the existing codebase: genuine
 * footguns stay as errors, while stylistic/strictness rules that would otherwise
 * require a repo-wide refactor are warnings (the `lint` script already allows up
 * to 500 warnings), so the gate is useful without being a blocker.
 */
module.exports = {
  root: true,
  env: { browser: true, es2021: true, node: true },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  plugins: ['@typescript-eslint', 'react-hooks'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
  ],
  ignorePatterns: [
    'dist',
    'build',
    'node_modules',
    'coverage',
    '*.config.ts',
    '*.config.js',
    '*.cjs',
    'vite-env.d.ts',
  ],
  rules: {
    // The codebase intentionally uses `any` at transport/edge seams.
    '@typescript-eslint/no-explicit-any': 'off',
    // Unused vars are worth surfacing but not blocking; allow _-prefixed escapes.
    '@typescript-eslint/no-unused-vars': [
      'warn',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
    ],
    'no-unused-vars': 'off',
    // These are stylistic/strictness preferences, not correctness bugs.
    '@typescript-eslint/no-non-null-assertion': 'off',
    '@typescript-eslint/no-empty-function': 'warn',
    '@typescript-eslint/ban-ts-comment': 'warn',
    'no-empty': 'warn',
    'prefer-const': 'warn',
  },
};
