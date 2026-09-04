import { describe, it, expect } from 'vitest'
import { AdapterRegistry } from '../src/adapters/registry.js'
import type { AgentAdapter } from '@agent-hq-orchestron/shared'

function makeStubAdapter(name: string): AgentAdapter {
  return {
    name,
    spawn: async () => { throw new Error('stub') },
    resume: async () => { throw new Error('stub') },
    sendPrompt: async () => { throw new Error('stub') },
    waitTuiReady: async () => { throw new Error('stub') },
    kill: async () => { throw new Error('stub') },
  }
}

describe('AdapterRegistry', () => {
  it('register and get returns the adapter', () => {
    const registry = new AdapterRegistry()
    const adapter = makeStubAdapter('claude')
    registry.register('claude', adapter)
    expect(registry.get('claude')).toBe(adapter)
  })

  it('get returns undefined for unknown key', () => {
    const registry = new AdapterRegistry()
    expect(registry.get('codex')).toBeUndefined()
  })

  it('getOrThrow throws for missing adapter', () => {
    const registry = new AdapterRegistry()
    expect(() => registry.getOrThrow('codex')).toThrow(/No adapter registered for agent type: "codex"/)
  })

  it('getOrThrow returns adapter when registered', () => {
    const registry = new AdapterRegistry()
    const adapter = makeStubAdapter('opencode')
    registry.register('opencode', adapter)
    expect(registry.getOrThrow('opencode')).toBe(adapter)
  })

  it('register overwrites existing adapter with same name', () => {
    const registry = new AdapterRegistry()
    const a1 = makeStubAdapter('claude')
    const a2 = makeStubAdapter('claude')
    registry.register('claude', a1)
    registry.register('claude', a2)
    expect(registry.get('claude')).toBe(a2)
  })
})
