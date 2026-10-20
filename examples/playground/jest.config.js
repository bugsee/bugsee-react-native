module.exports = {
  preset: 'jest-expo',
  setupFiles: ['./jest.setup.ts'],
  // CI runners are slower than a dev machine: the first render of a big screen alone took > 5 s there.
  testTimeout: 15000,
  testMatch: ['**/__tests__/**/*.test.ts?(x)'],
  modulePathIgnorePatterns: ['<rootDir>/ios', '<rootDir>/android'],
};
