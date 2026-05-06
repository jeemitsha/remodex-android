// Vitest config for our pure-TS protocol/utility modules.
// We keep tests in lib/__tests__/ next to the source they exercise.
// Component tests require RN testing infrastructure which we'll add separately.

import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname),
    },
  },
  test: {
    environment: 'node',
    include: ['lib/**/*.test.ts', 'scripts/**/*.test.ts'],
    globals: false,
  },
});
