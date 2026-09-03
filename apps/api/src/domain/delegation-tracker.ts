import path from 'node:path'
import { appendJsonl, readJsonlFrom, listDir } from '@agent-hq-orchestron/file-store'
import type { SessionManager } from './session-manager.js'

export interface DelegationRow {
  childUuid: string
  spawnedAt: string
  spawnPrompt?: string
}

export class DelegationTracker {
  private readonly delegationDir: string

  constructor(dataDir: string) {
    this.delegationDir = path.join(dataDir, 'delegation')
  }

  private edgePath(parentUuid: string): string {
    return path.join(this.delegationDir, `${parentUuid}.jsonl`)
  }

  async recordEdge(parentUuid: string, childUuid: string, spawnPrompt?: string, detached = false): Promise<void> {
    if (detached) return
    const row: DelegationRow = {
      childUuid,
      spawnedAt: new Date().toISOString(),
      ...(spawnPrompt !== undefined ? { spawnPrompt } : {}),
    }
    await appendJsonl(this.edgePath(parentUuid), row)
  }

  async getChildren(parentUuid: string): Promise<DelegationRow[]> {
    const { lines } = await readJsonlFrom(this.edgePath(parentUuid), 0)
    return lines as DelegationRow[]
  }

  async getDescendants(uuid: string): Promise<string[]> {
    const result: string[] = []
    const queue: string[] = [uuid]
    while (queue.length > 0) {
      const current = queue.shift()!
      const children = await this.getChildren(current)
      for (const child of children) {
        result.push(child.childUuid)
        queue.push(child.childUuid)
      }
    }
    return result
  }

  async killCascade(rootUuid: string, sessionManager: SessionManager): Promise<void> {
    const descendants = await this.getDescendants(rootUuid)
    for (const uuid of descendants.reverse()) {
      try {
        await sessionManager.kill(uuid)
      } catch {
        // best-effort: session may already be terminal
      }
    }
  }

  async getAncestorChain(uuid: string): Promise<string[]> {
    const files = await listDir(this.delegationDir)
    const childToParent = new Map<string, string>()

    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue
      const parentUuid = file.replace(/\.jsonl$/, '')
      const { lines } = await readJsonlFrom(path.join(this.delegationDir, file), 0)
      for (const row of lines as DelegationRow[]) {
        childToParent.set(row.childUuid, parentUuid)
      }
    }

    const ancestors: string[] = []
    let current = uuid
    while (childToParent.has(current)) {
      const parent = childToParent.get(current)!
      ancestors.push(parent)
      current = parent
    }
    return ancestors
  }
}
