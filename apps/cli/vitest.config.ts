import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Most tests here spawn the CLI as a real subprocess — the only way to
    // catch a command registered under the wrong name or a flag Commander
    // never parsed. Each spawn costs a second or two, and a scenario that
    // runs the binary twice (an alias check, a pause/resume pair) blows the
    // 5s default intermittently. The failure looked like flake, not like a
    // timeout, which is the worst kind of red.
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
})
