'use client'

import { useEffect } from 'react'
import { Info, AlertCircle, X } from 'lucide-react'
import { useNotices, dismissNotice, NOTICE_TTL_MS, type Notice } from '@/lib/notice'

/**
 * Toast stack for transient server-side notices. Mounted once in the root
 * layout; publishers call `pushNotice()` from anywhere.
 *
 * Bottom-right, offset above where VersionCheck's own fixed banner sits.
 * That one is a persistent "reload me" prompt and these are self-retiring,
 * so they stack upward from a higher offset rather than fight for the
 * same corner.
 */
export function NoticeToast() {
  const notices = useNotices()
  if (notices.length === 0) return null
  return (
    <div className="fixed bottom-20 right-3 z-50 flex flex-col gap-2 w-[min(22rem,calc(100vw-1.5rem))]">
      {notices.map(n => <Row key={n.id} notice={n} />)}
    </div>
  )
}

/**
 * Per-tone presentation. A table rather than the pair of ternaries this used
 * to be: those read the tone five times to answer one question, and a third
 * tone (NF27's failures) would have made it eight.
 *
 * 'error' is assertive rather than polite — a screen reader should not sit on
 * "Kill failed" until the user happens to move focus.
 */
const TONES: Record<Notice['tone'], {
  shell: string; icon: string; body: string; sub: string
  Glyph: typeof Info; live: 'polite' | 'assertive'
}> = {
  info: {
    shell: 'bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800',
    icon: 'text-blue-600 dark:text-blue-400',
    body: 'text-zinc-800 dark:text-zinc-100',
    sub: 'text-zinc-500 dark:text-zinc-400',
    Glyph: Info,
    live: 'polite',
  },
  warn: {
    shell: 'bg-amber-50 dark:bg-amber-950 border-amber-300 dark:border-amber-800',
    icon: 'text-amber-600 dark:text-amber-400',
    body: 'text-amber-900 dark:text-amber-100',
    sub: 'text-amber-700 dark:text-amber-300',
    Glyph: AlertCircle,
    live: 'polite',
  },
  error: {
    shell: 'bg-red-50 dark:bg-red-950 border-red-300 dark:border-red-800',
    icon: 'text-red-600 dark:text-red-400',
    body: 'text-red-900 dark:text-red-100',
    sub: 'text-red-700 dark:text-red-300',
    Glyph: AlertCircle,
    live: 'assertive',
  },
}

function Row({ notice }: { notice: Notice }) {
  useEffect(() => {
    const t = setTimeout(() => dismissNotice(notice.id), NOTICE_TTL_MS)
    return () => clearTimeout(t)
  }, [notice.id])

  const { shell, icon, body, sub, Glyph, live } = TONES[notice.tone]

  return (
    <div
      role="status"
      aria-live={live}
      className={`border rounded-lg shadow-lg p-3 flex items-start gap-2 ${shell}`}
    >
      <Glyph className={`w-4 h-4 mt-0.5 shrink-0 ${icon}`} />
      <div className={`flex-1 min-w-0 text-xs ${body}`}>
        <p className="font-medium">{notice.text}</p>
        {notice.detail && (
          <p className={`text-[11px] mt-0.5 leading-snug ${sub}`}>{notice.detail}</p>
        )}
      </div>
      <button
        onClick={() => dismissNotice(notice.id)}
        aria-label="Dismiss"
        className={`shrink-0 p-0.5 rounded hover:bg-black/5 dark:hover:bg-white/10 transition ${sub}`}
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}
