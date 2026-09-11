import type { AgentAdapter } from '@agent-hq-orchestron/shared'

export class AdapterRegistry {
  private readonly adapters = new Map<string, AgentAdapter>()

  register(name: string, adapter: AgentAdapter): void {
    this.adapters.set(name, adapter)
  }

  get(name: string): AgentAdapter | undefined {
    return this.adapters.get(name)
  }

  /** Registered adapter names. `/api/readiness` asks for this: a process
   *  with an empty registry is up but cannot spawn anything. */
  names(): string[] {
    return [...this.adapters.keys()]
  }

  getOrThrow(name: string): AgentAdapter {
    const adapter = this.adapters.get(name)
    if (!adapter) {
      throw new Error(`No adapter registered for agent type: "${name}". Check your config.`)
    }
    return adapter
  }
}
