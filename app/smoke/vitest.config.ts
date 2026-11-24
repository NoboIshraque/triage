import { defineConfig } from 'vitest/config';

// Not part of `pnpm test`: it needs a packaged app (app/build.mjs). CI runs it
// in the App workflow after packaging, on Windows and Linux.
export default defineConfig({
  test: {
    include: ['src/**/*.smoke.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
