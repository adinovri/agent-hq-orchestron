import { useState, useCallback, useEffect, useRef } from 'react'

export type ToastLevel = 'error' | 'warn' | 'info' | 'success'

export interface Toast {
  id: number
  message: string
  level: ToastLevel
  expiry: number
}

let _id = 0

export function useToast(ttlMs = 5000) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const push = useCallback(
    (message: string, level: ToastLevel = 'info') => {
      const id = ++_id
      const expiry = Date.now() + ttlMs
      setToasts((prev) => [...prev.slice(-4), { id, message, level, expiry }])
    },
    [ttlMs],
  )

  useEffect(() => {
    if (toasts.length === 0) return
    const nearest = Math.min(...toasts.map((t) => t.expiry))
    const delay = Math.max(nearest - Date.now(), 0)
    timerRef.current = setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.expiry > Date.now()))
    }, delay + 50)
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [toasts])

  const latest = toasts[toasts.length - 1] ?? null

  return { toasts, latest, push }
}
