// jest.config.js
module.exports = {
  testEnvironment: 'node',
  testMatch: [
    '**/tests/**/*.test.js',
    '!**/node_modules/**',
  ],
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/services/**', // External services are mocked
  ],
  coverageThreshold: {
    global: {
      branches: 50,
      functions: 50,
      lines: 50,
      statements: 50,
    },
  },
  setupFilesAfterEnv: ['./tests/setup.js'],
  testTimeout: 30000,
  verbose: true,
  // TODO: Remove once open handles are fixed (likely Bottleneck timers)
  forceExit: true,
};
