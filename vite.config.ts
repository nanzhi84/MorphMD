import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  cacheDir: process.env.VITEST
    ? `node_modules/.vite-test-${process.env.VITEST_POOL_ID || process.pid}`
    : 'node_modules/.vite',
  optimizeDeps: {
    entries: ['src/index.ts', 'index.html'],
  },
  plugins: [react()],
  test: {
    include: ['tests/test_*.test.ts'],
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
