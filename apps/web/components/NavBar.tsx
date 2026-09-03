'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'

const NAV_LINKS = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/metrics', label: 'Metrics' },
  { href: '/graph', label: 'Graph' },
  { href: '/pair', label: 'Settings' },
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
    <nav className="sticky top-0 z-40 h-14 border-b border-zinc-200 dark:border-zinc-800 bg-white/80 dark:bg-zinc-950/80 backdrop-blur flex items-center px-4 gap-6">
      <Link href="/dashboard" className="font-semibold text-sm shrink-0">
        Orchestron
      </Link>

      <div className="flex items-center gap-1 flex-1">
        {NAV_LINKS.map((l) => {
          const active = pathname?.startsWith(l.href)
          return (
            <Link
              key={l.href}
              href={l.href}
              className={`px-3 py-1.5 rounded-md text-sm transition-colors ${
                active
                  ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 font-medium'
                  : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-900'
              }`}
            >
              {l.label}
            </Link>
          )
        })}
      </div>

      {pwaInstalled && (
        <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300 shrink-0">
          PWA
        </span>
      )}
    </nav>
  )
}
