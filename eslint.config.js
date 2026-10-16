// Minimal lint (T-612, D-66): the TypeScript parser and a few rules for plain mistakes. quick-check runs it on the files a branch
// changed. A wider rule set comes only with a baseline count of what it would flag.
import tseslint from 'typescript-eslint';

export default [
  { ignores: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/coverage/**', 'job-out/**', 'job-run-artifacts/**'] },
  ...tseslint.configs.base,
  {
    files: ['**/*.{ts,tsx,js,jsx,mjs,cjs}'],
    rules: {
      'no-debugger': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-else-if': 'error',
      'no-duplicate-case': 'error',
      'no-unreachable': 'error',
      'no-self-assign': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
    },
  },
];
