import type { SessionManager } from '../domain/session-manager.js'
import type { SnapshotService } from '../domain/snapshot-service.js'

export async function scanOrphans(
  snapshotService: SnapshotService,
  sessionManager: SessionManager,
): Promise<void> {
  let ledgers: Awaited<ReturnType<SnapshotService['listLedgers']>>
  try {
    ledgers = await snapshotService.listLedgers()
  } catch {
    return
  }

  if (ledgers.length === 0) return

  const activeSessions = await sessionManager.list()
  const activeUuids = new Set(activeSessions.map((s) => s.id))

  for (const ledger of ledgers) {
    if (!activeUuids.has(ledger.sessionUuid)) {
      try {
        await snapshotService.cleanup(ledger.sessionUuid)
      } catch {
        // best-effort
      }
    }
  }
}
