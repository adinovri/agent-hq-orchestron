'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Plus, ChevronDown, Import, Upload } from 'lucide-react'

interface Props {
  onSpawn: () => void
  onAdopt: () => void
  onImport: () => void
}

/** Split-button primary action for the dashboard header.
 *  Spawn = the daily action, wired to the big button. Adopt + Import
 *  tuck under a caret so mobile stays tidy without hiding them behind
 *  an ambiguous kebab. Menu closes on outside click / Escape. */
export function SpawnActionsMenu({ onSpawn, onAdopt, onImport }: Props) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent | TouchEvent) => {
      if (!rootRef.current) return
      if (rootRef.current.contains(e.target as Node)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('touchstart', onDoc, { passive: true })
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('touchstart', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const pick = (fn: () => void) => {
    setOpen(false)
    fn()
  }

  return (
    <div ref={rootRef} className="relative inline-flex shrink-0">
      {/* Split button — Spawn is the primary target, caret opens overflow.
       *  -mr-px + rounded-l/rounded-r cancel the internal seam so the
       *  pair reads as one control. */}
      <Button
        onClick={onSpawn}
        className="rounded-r-none pr-3"
        title="Spawn a new session in the selected project"
      >
        <Plus className="w-4 h-4 mr-1" /> Spawn
      </Button>
      <Button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More session actions"
        className="rounded-l-none border-l border-black/20 dark:border-white/20 px-2"
        title="More: adopt / import"
      >
        <ChevronDown className={`w-4 h-4 transition-transform ${open ? 'rotate-180' : ''}`} />
      </Button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1.5 w-56 z-30 rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-lg overflow-hidden animate-in fade-in-0 zoom-in-95"
        >
          <button
            role="menuitem"
            onClick={() => pick(onAdopt)}
            className="w-full flex items-start gap-2.5 px-3 py-2 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/70 transition-colors"
          >
            <Import className="w-4 h-4 mt-0.5 text-violet-600 dark:text-violet-400 shrink-0" />
            <div className="min-w-0">
              <div className="text-sm font-medium text-zinc-800 dark:text-zinc-100">Adopt</div>
              <div className="text-[11px] text-zinc-500 dark:text-zinc-400 leading-snug">
                Attach a session started outside orchestron by UUID
              </div>
            </div>
          </button>
          <div className="h-px bg-zinc-100 dark:bg-zinc-800" />
          <button
            role="menuitem"
            onClick={() => pick(onImport)}
            className="w-full flex items-start gap-2.5 px-3 py-2 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/70 transition-colors"
          >
            <Upload className="w-4 h-4 mt-0.5 text-sky-600 dark:text-sky-400 shrink-0" />
            <div className="min-w-0">
              <div className="text-sm font-medium text-zinc-800 dark:text-zinc-100">Import bundle</div>
              <div className="text-[11px] text-zinc-500 dark:text-zinc-400 leading-snug">
                Restore a .jsonl / .tar.gz exported from another host
              </div>
            </div>
          </button>
        </div>
      )}
    </div>
  )
}
