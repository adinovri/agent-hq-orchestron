'use client'

import { useEffect, useState } from 'react'
import { Palette } from 'lucide-react'

export type Theme = 'orchestron' | 'tycho' | 'light'

const LABEL: Record<Theme, string> = {
  orchestron: 'Orchestron (default dark)',
  tycho: 'Tycho (warm orange)',
  light: 'Light',
}

const KEY = 'orchestron_theme'

export function applyTheme(theme: Theme) {
  const html = document.documentElement
  if (theme === 'tycho') {
    html.setAttribute('data-theme', 'tycho')
    html.classList.add('dark')
    html.classList.remove('light')
  } else if (theme === 'light') {
    html.setAttribute('data-theme', 'light')
    html.classList.remove('dark')
    html.classList.add('light')
  } else {
    html.setAttribute('data-theme', 'orchestron')
    html.classList.add('dark')
    html.classList.remove('light')
  }
}

/**
 * Applies the persisted theme on mount. Renders nothing — pair with
 * ThemeSelect component in Settings for user-facing UI.
 */
export function ThemeApplier() {
  useEffect(() => {
    let stored: string | null = null
    try { stored = localStorage.getItem(KEY) } catch { /* ignore */ }
    const theme = (stored === 'tycho' || stored === 'light' || stored === 'orchestron') ? stored : 'orchestron'
    applyTheme(theme)
  }, [])
  return null
}

export function ThemeSelect() {
  const [theme, setTheme] = useState<Theme>('orchestron')

  useEffect(() => {
    let stored: string | null = null
    try { stored = localStorage.getItem(KEY) } catch { /* ignore */ }
    const t = (stored === 'tycho' || stored === 'light' || stored === 'orchestron') ? stored : 'orchestron'
    setTheme(t)
    applyTheme(t)
  }, [])

  const pick = (t: Theme) => {
    setTheme(t)
    applyTheme(t)
    try { localStorage.setItem(KEY, t) } catch { /* ignore */ }
  }

  return (
    <div className="flex items-center gap-2">
      <Palette className="w-4 h-4 text-zinc-500" />
      <select
        value={theme}
        onChange={(e) => pick(e.target.value as Theme)}
        className="h-9 px-2 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 text-sm text-zinc-900 dark:text-zinc-100"
      >
        {(Object.keys(LABEL) as Theme[]).map((t) => (
          <option key={t} value={t}>{LABEL[t]}</option>
        ))}
      </select>
    </div>
  )
}
