'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { LayoutDashboard, FolderKanban, BarChart3, Network, Settings, Clock } from 'lucide-react'

const NAV_LINKS = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/projects', label: 'Projects', icon: FolderKanban },
  { href: '/schedules', label: 'Schedules', icon: Clock },
  { href: '/metrics', label: 'Metrics', icon: BarChart3 },
  { href: '/graph', label: 'Graph', icon: Network },
  { href: '/settings', label: 'Settings', icon: Settings },
]

export function NavBar() {
  const pathname = usePathname()
  const [pwaInstalled, setPwaInstalled] = useState(false)

  useEffect(() => {
    const mq = window.matchMedia('(display-mode: standalone)')
    setPwaInstalled(mq.matches)
    const handler = (e: MediaQueryListEvent) => setPwaInstalled(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  return (
    <nav className="sticky top-0 z-40 h-14 border-b border-zinc-200 dark:border-zinc-800 bg-white/85 dark:bg-zinc-950/85 backdrop-blur flex items-center px-3 sm:px-4 gap-4 sm:gap-6">
      <Link href="/dashboard" className="font-semibold text-sm shrink-0 flex items-center gap-1.5">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/icons/source.svg" alt="Orchestron" className="w-6 h-6 rounded-md" />
        <span className="hidden sm:inline">Orchestron</span>
        {/* Mobile-only mini SHA chip — 4 chars fits ~35px, well within
         *  what the space that used to hold the full chip would allow, and
         *  keeps a version indicator visible even at 375px viewports where
         *  the desktop-only chip on the far right gets hidden. */}
        <span
          title={`Build ${process.env.NEXT_PUBLIC_BUILD_STAMP ?? 'unknown'}`}
          className="sm:hidden text-[10px] font-mono leading-none px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400"
        >
          {process.env.NEXT_PUBLIC_BUILD_STAMP?.slice(0, 4) ?? '?'}
        </span>
      </Link>

      {/* Nav strip. `flex-1 overflow-x-auto` lets it scroll when links don't
       *  fit (narrow mobile, big label sets). The right-edge gradient hint
       *  (`after:` pseudo) surfaces scrollability since we hide the actual
       *  scrollbar via `no-scrollbar`. */}
      <div className="relative flex-1 min-w-0">
        <div className="flex items-center gap-0.5 overflow-x-auto no-scrollbar">
          {NAV_LINKS.map((l) => {
            const active = pathname?.startsWith(l.href)
            const Icon = l.icon
            return (
              <Link
                key={l.href}
                href={l.href}
                className={`px-2.5 sm:px-3 py-1.5 rounded-md text-sm transition-colors shrink-0 flex items-center gap-1.5 ${
                  active
                    ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 font-medium'
                    : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-900'
                }`}
              >
                <Icon className="w-4 h-4" />
                <span className="hidden sm:inline">{l.label}</span>
              </Link>
            )
          })}
        </div>
        {/* Right-edge fade — visual "there's more, scroll →" hint. Pointer-
         *  events-none so it doesn't intercept taps on the last nav icon. */}
        <div className="pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-white/85 to-transparent dark:from-zinc-950/85 sm:hidden" />
      </div>

      {/* Version chip + PWA badge — hidden on mobile so the nav row has room
       *  for all 6 links; both still visible on ≥sm where the strip has
       *  breathing room. Details still available on the Settings page. */}
      <span
        title={`Build ${process.env.NEXT_PUBLIC_BUILD_STAMP ?? 'unknown'}`}
        className="hidden sm:inline text-xs font-mono px-2 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 shrink-0"
      >
        v {process.env.NEXT_PUBLIC_BUILD_STAMP?.slice(-8) ?? '?'}
      </span>

      {pwaInstalled && (
        <span className="hidden sm:inline text-xs px-2 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-400 shrink-0 font-medium">
          PWA
        </span>
      )}
    </nav>
  )
}
