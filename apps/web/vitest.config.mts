import { defineConfig } from 'vitest/config'

/** Node-only unit tests for the pure helpers in `lib/`. There is no DOM
 *  environment here on purpose — component rendering is not covered, so
 *  the suite stays dependency-free (vitest is already a workspace dep). */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['lib/**/*.test.ts'],
  },
})
