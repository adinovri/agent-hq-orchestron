'use client'

import { useState } from 'react'
import { useHealthDetail } from '@/lib/server-config'
import { Skeleton } from '@/components/Skeleton'
import {
  Server, Key, FileCog, AlertCircle, CheckCircle2, Copy, Check,
  ShieldCheck, ShieldOff, Palette,
} from 'lucide-react'
import { ThemeSelect } from '@/components/ThemeSwitcher'

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4 py-2.5 border-b border-zinc-100 dark:border-zinc-800 last:border-0">
      <span className="text-xs sm:text-sm text-zinc-500 dark:text-zinc-400 sm:w-44 shrink-0">{label}</span>
      <span className="text-sm font-mono text-zinc-900 dark:text-zinc-100 break-all">{value}</span>
    </div>
  )
}

function Section({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-200 dark:border-zinc-800">
        <span className="text-zinc-400">{icon}</span>
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</h2>
      </div>
      <div className="px-4">{children}</div>
    </div>
  )
}

function CopyableCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* ignore */ }
  }
  return (
    <div className="relative group">
      <pre className="text-xs font-mono bg-zinc-100 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200 px-3 py-2 pr-9 rounded overflow-x-auto whitespace-pre">
        {command}
      </pre>
      <button
        onClick={copy}
        className="absolute top-1.5 right-1.5 p-1 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 transition-colors"
        title={copied ? 'Copied' : 'Copy'}
      >
        {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
      </button>
    </div>
  )
}

export default function SettingsPage() {
  // /api/health is now anonymous {ok:true} only — verbose fields
  // (storage/bindHost/tmux/remoteAuth/maxConcurrent/platform) moved behind
  // Bearer at /api/health/detail after security pass-1 finding #3. This
  // page is authed anyway, so it hits the detail endpoint — via the same
  // shared hook the spawn/project/session dialogs use for the headless flag.
  const { data: health, isLoading, error } = useHealthDetail()

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-zinc-500 mt-0.5">Server configuration — read-only view</p>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 p-3 text-sm text-red-700 dark:text-red-300">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <div className="min-w-0">
            <p className="font-medium">Failed to load server info</p>
            <p className="text-xs mt-0.5 opacity-80 break-all">{(error as Error).message}</p>
          </div>
        </div>
      )}

      <Section title="Server Info" icon={<Server className="w-4 h-4" />}>
        {isLoading ? (
          <div className="py-3 space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex gap-4 py-1.5">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-4 flex-1" />
              </div>
            ))}
          </div>
        ) : health ? (
          <>
            <InfoRow label="Status" value={
              <span className="inline-flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="w-3.5 h-3.5" /> online
              </span>
            } />
            <InfoRow label="Bind host" value={health.bindHost} />
            <InfoRow label="Remote auth" value={
              <span className={`inline-flex items-center gap-1.5 ${
                health.remoteAuth === 'enabled'
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : 'text-zinc-500'
              }`}>
                {health.remoteAuth === 'enabled'
                  ? <ShieldCheck className="w-3.5 h-3.5" />
                  : <ShieldOff className="w-3.5 h-3.5" />}
                {health.remoteAuth}
              </span>
            } />
            <InfoRow label="Max concurrent" value={String(health.maxConcurrent)} />
            <InfoRow label="tmux" value={health.tmux} />
            <InfoRow label="Headless mode" value={
              // Older servers omit the field entirely — those predate the
              // kill switch and always allowed headless.
              (health.enableHeadlessMode ?? true)
                ? <span className="text-emerald-600 dark:text-emerald-400">enabled</span>
                : <span className="text-amber-600 dark:text-amber-400">disabled globally</span>
            } />
            <InfoRow label="Storage dir" value={health.storage} />
          </>
        ) : null}
      </Section>

      <Section title="Configuration" icon={<FileCog className="w-4 h-4" />}>
        <div className="py-3 space-y-3">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Config file:{' '}
            <code className="text-xs font-mono bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded">
              ~/.orchestron/config.json
            </code>
          </p>
          {(() => {
            // Show both restart commands (deploy targets both Linux server
            // + macOS laptop), mark the current host as ACTIVE. Falls back
            // to Linux-marked when platform detection is unavailable.
            //
            // Mac command uses `$(id -u)` shell substitution instead of
            // baking in the API process's uid — the API's uid is the
            // CURRENT HOST's uid, which is wrong when the user is viewing
            // Server Settings and wants the Mac command (or vice versa).
            // Shell substitution resolves at paste-time on the target
            // machine, always correct.
            const isMac = health?.platform === 'darwin'
            const macCmd = 'launchctl kickstart -k gui/$(id -u)/com.orchestron.api && launchctl kickstart -k gui/$(id -u)/com.orchestron.web'
            const linuxCmd = 'systemctl --user restart orchestron-api.service orchestron-web.service'
            return (
              <div className="space-y-2">
                <p className="text-xs text-zinc-500">Restart after editing:</p>
                <div className="space-y-2">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-[10px] font-mono uppercase tracking-wide text-zinc-500">Linux · systemd</span>
                      {!isMac && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300 font-medium uppercase tracking-wide">this host</span>
                      )}
                    </div>
                    <CopyableCommand command={linuxCmd} />
                  </div>
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-[10px] font-mono uppercase tracking-wide text-zinc-500">macOS · launchd</span>
                      {isMac && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300 font-medium uppercase tracking-wide">this host</span>
                      )}
                    </div>
                    <CopyableCommand command={macCmd} />
                  </div>
                </div>
              </div>
            )
          })()}
        </div>
      </Section>

      <Section title="Appearance" icon={<Palette className="w-4 h-4" />}>
        <div className="py-3 space-y-2">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Switch between the default Orchestron dark theme, Tycho's warm-orange dark, or a light theme. Saved per-browser.
          </p>
          <ThemeSelect />
        </div>
      </Section>

      <Section title="Bearer Token" icon={<Key className="w-4 h-4" />}>
        <div className="py-3 space-y-3">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Rotate the token to invalidate all existing PWA sessions.
          </p>
          <CopyableCommand command="orchestron token rotate" />
          <div className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 rounded px-2 py-1.5">
            <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>After rotating, re-scan the QR code on all devices at <code className="font-mono">/pair</code>.</span>
          </div>
        </div>
      </Section>
    </div>
  )
}
