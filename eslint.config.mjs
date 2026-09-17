import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// Pin the root explicitly. Stryker's sandbox (.stryker-tmp) is a full copy of
// the repo, tsconfig and all, so without this the parser sees several
// candidate roots and refuses to parse anything.
const tsconfigRootDir = import.meta.dirname;

export default tseslint.config(
  {
    // Build output, vendored artefacts and the example apps' own toolchains.
    ignores: [
      '**/node_modules/**',
      '**/build/**',
      '**/.build/**',
      '**/Pods/**',
      '**/*.xcframework/**',
      '.stryker-tmp/**',
      'reports/**',
      'examples/**',
      '**/lib/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: { parserOptions: { tsconfigRootDir } },
    rules: {
      // The bridge surface is an open map of com.bugsee.option.* keys whose
      // value types vary per option, so `unknown` is the honest type and
      // casting at the boundary is deliberate. Everything else stays strict.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // CommonJS config files consumed by the React Native autolinker.
    files: ['**/*.js', '**/*.cjs'],
    languageOptions: {
      globals: { module: 'writable', require: 'readonly', __dirname: 'readonly' },
    },
  },
  {
    // jest.mock is hoisted above the import block, so its factory cannot
    // close over an imported binding — require() is the only thing that
    // works here, not a style choice.
    files: ['**/__tests__/**/*.ts', '**/__mocks__/**/*.ts'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    files: ['scripts/**/*.ts'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly', require: 'readonly', module: 'readonly', __dirname: 'readonly' },
    },
  },
);
