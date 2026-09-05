'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { LayoutDashboard, FolderKanban, BarChart3, Network, Settings } from 'lucide-react'

const NAV_LINKS = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/projects', label: 'Projects', icon: FolderKanban },
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
        <span className="inline-block w-6 h-6 rounded-md bg-gradient-to-br from-blue-500 to-blue-700 text-white text-xs flex items-center justify-center font-bold">O</span>
        <span className="hidden sm:inline">Orchestron</span>
      </Link>

      <div className="flex items-center gap-0.5 flex-1 overflow-x-auto no-scrollbar">
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

      <span
        title={`Build ${process.env.NEXT_PUBLIC_BUILD_STAMP ?? 'unknown'}`}
        className="hidden sm:inline text-[10px] font-mono text-zinc-400 dark:text-zinc-500 shrink-0"
      >
        {process.env.NEXT_PUBLIC_BUILD_STAMP?.slice(-8) ?? '?'}
      </span>

      {pwaInstalled && (
        <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-400 shrink-0 font-medium">
          PWA
        </span>
      )}
    </nav>
  )
}
