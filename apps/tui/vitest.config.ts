import { defineConfig } from 'vitest/config'
import path from 'node:path'

// npm workspaces hoisted `ink-testing-library` to the repo root but left
// `ink` in `apps/tui/node_modules/ink` (ink couldn't hoist — some other
// workspace pins a different major). Node then can't resolve `ink` when
// the imports come from `node_modules/ink-testing-library/build/index.js`.
// Alias `ink` (and its subpath imports) to this workspace's copy so
// vitest resolves them without depending on hoist order.
const inkRoot = path.resolve(__dirname, 'node_modules/ink')

export default defineConfig({
  resolve: {
    alias: [
      { find: /^ink$/, replacement: inkRoot },
      { find: /^ink\/(.*)$/, replacement: `${inkRoot}/$1` },
    ],
  },
})
