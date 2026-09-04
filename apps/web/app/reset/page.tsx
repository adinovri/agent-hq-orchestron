'use client'

import { useEffect, useState } from 'react'

export default function ResetPage() {
  const [status, setStatus] = useState<string>('Resetting...')

  useEffect(() => {
    async function reset() {
      const steps: string[] = []
      try {
        // 1. Unregister all service workers
        if ('serviceWorker' in navigator) {
          const regs = await navigator.serviceWorker.getRegistrations()
          for (const reg of regs) {
            await reg.unregister()
            steps.push(`✓ Unregistered SW: ${reg.scope}`)
          }
          if (regs.length === 0) steps.push('- No SW registered')
        }

        // 2. Clear all caches (Cache Storage API)
        if ('caches' in window) {
          const keys = await caches.keys()
          for (const key of keys) {
            await caches.delete(key)
            steps.push(`✓ Deleted cache: ${key}`)
          }
          if (keys.length === 0) steps.push('- No caches')
        }

        // 3. Clear sessionStorage + localStorage
        try {
          sessionStorage.clear()
          localStorage.clear()
          steps.push('✓ Cleared session + local storage')
        } catch {
          steps.push('⚠ Could not clear storage')
        }

        // 4. Clear IndexedDB (if any orchestron key)
        if ('indexedDB' in window && 'databases' in indexedDB) {
          try {
            const dbs = await indexedDB.databases()
            for (const db of dbs) {
              if (db.name) {
                indexedDB.deleteDatabase(db.name)
                steps.push(`✓ Deleted DB: ${db.name}`)
              }
            }
          } catch {
            /* ignore */
          }
        }

        setStatus(steps.join('\n') + '\n\nDone. Refreshing in 3s...')
        setTimeout(() => {
          window.location.href = '/pair'
        }, 3000)
      } catch (err) {
        setStatus('Error: ' + (err as Error).message)
      }
    }
    reset()
  }, [])

  return (
    <div style={{
      padding: 20,
      fontFamily: 'monospace',
      whiteSpace: 'pre-wrap',
      color: 'white',
      background: 'black',
      minHeight: '100vh',
    }}>
      <h1 style={{ fontSize: 20, marginBottom: 16 }}>Orchestron Reset</h1>
      <div>{status}</div>
    </div>
  )
}
