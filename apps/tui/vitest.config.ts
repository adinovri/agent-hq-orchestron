import { defineConfig } from 'vitest/config'
import path from 'node:path'

// npm workspaces hoisted `ink-testing-library` to the repo root but left
// `ink` in `apps/tui/node_modules/ink` (ink couldn't hoist — some other
// workspace pins a different major). Node then can't resolve `ink` when
// the imports come from `node_modules/ink-testing-library/build/index.js`.
// Alias `ink` (and its subpath imports) to this workspace's copy so
// vitest resolves them without depending on hoist order.
const inkRoot = path.resolve(import.meta.dirname, 'node_modules/ink')

export default defineConfig({
  resolve: {
    alias: [
      { find: /^ink$/, replacement: inkRoot },
      { find: /^ink\/(.*)$/, replacement: `${inkRoot}/$1` },
    ],
  },
  test: {
    server: {
      deps: {
        // The alias above only reaches imports Vite actually resolves.
        // `ink-testing-library` lives in node_modules, so vitest externalised
        // it and let Node load it directly — and Node, resolving `ink` from
        // the repo root where the library was hoisted, found nothing. The
        // library declares no dependency or peer on `ink` at all (only on
        // `@types/react`), so nothing makes npm place them together. Inlining
        // it puts its imports back through Vite, where the alias applies.
        inline: ['ink-testing-library'],
      },
    },
  },
})
