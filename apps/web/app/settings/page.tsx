'use client'

import { useQuery } from '@tanstack/react-query'
import { fetchJson } from '@/lib/fetcher'

interface HealthResponse {
  ok: boolean
  tmux: string
  storage: string
  bindHost: string
  remoteAuth: 'enabled' | 'disabled'
  maxConcurrent: number
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4 py-2.5 border-b border-zinc-100 dark:border-zinc-800 last:border-0">
      <span className="text-sm text-zinc-500 dark:text-zinc-400 sm:w-48 shrink-0">{label}</span>
      <span className="text-sm font-mono text-zinc-900 dark:text-zinc-100">{value}</span>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-800">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</h2>
      </div>
      <div className="px-4">{children}</div>
    </div>
  )
}

export default function SettingsPage() {
  const { data: health, isLoading, error } = useQuery<HealthResponse>({
    queryKey: ['health'],
    queryFn: () => fetchJson('/api/health'),
    refetchInterval: 30_000,
  })

  return (
    <div className="max-w-2xl mx-auto px-4 py-8 space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="text-sm text-zinc-500 mt-0.5">Server configuration — read-only view</p>
      </div>

      {isLoading && (
        <div className="text-center py-12 text-zinc-400">Loading…</div>
      )}

      {error && (
        <div className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/20 p-4 text-sm text-red-600 dark:text-red-400">
          Failed to load server info: {(error as Error).message}
        </div>
      )}

      {health && (
        <Section title="Server Info">
          <InfoRow label="Status" value={
            <span className="text-green-600 dark:text-green-400">● online</span>
          } />
          <InfoRow label="Bind host" value={health.bindHost} />
          <InfoRow label="Remote auth" value={
            <span className={health.remoteAuth === 'enabled'
              ? 'text-green-600 dark:text-green-400'
              : 'text-zinc-500'}>
              {health.remoteAuth}
            </span>
          } />
          <InfoRow label="Max concurrent" value={String(health.maxConcurrent)} />
          <InfoRow label="tmux" value={health.tmux} />
          <InfoRow label="Storage dir" value={health.storage} />
        </Section>
      )}

      <Section title="Configuration">
        <div className="py-3 space-y-2">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Config file:{' '}
            <code className="text-xs font-mono bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded">
              ~/.orchestron/config.json
            </code>
          </p>
          <p className="text-sm text-zinc-500">
            Edit manually then restart the service to apply changes.
          </p>
          <code className="block text-xs font-mono bg-zinc-100 dark:bg-zinc-800 px-3 py-2 rounded mt-1">
            systemctl --user restart orchestron-web.service
          </code>
        </div>
      </Section>

      <Section title="Bearer Token">
        <div className="py-3 space-y-2">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            To generate a new bearer token, run the CLI command below. This will invalidate all existing PWA sessions.
          </p>
          <code className="block text-xs font-mono bg-zinc-100 dark:bg-zinc-800 px-3 py-2 rounded">
            orchestron token rotate
          </code>
          <p className="text-xs text-amber-600 dark:text-amber-400">
            ⚠ After rotating, re-scan the QR code on all devices at /pair.
          </p>
        </div>
      </Section>
    </div>
  )
}
