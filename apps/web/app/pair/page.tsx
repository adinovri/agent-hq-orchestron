'use client'

import { useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Suspense } from 'react'

function PairInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [status, setStatus] = useState<'pairing' | 'done' | 'no_token'>('pairing')
  const [showInstall, setShowInstall] = useState(false)
  const [deferredPrompt, setDeferredPrompt] = useState<Event | null>(null)

  useEffect(() => {
    const token = searchParams.get('token')
    if (!token) {
      setStatus('no_token')
      return
    }

    try {
      sessionStorage.setItem('orchestron_token', token)
    } catch {
      // sessionStorage blocked
    }

    setStatus('done')

    const timer = setTimeout(() => {
      router.push('/dashboard')
    }, 1_200)

    return () => clearTimeout(timer)
  }, [searchParams, router])

  useEffect(() => {
    function handleBeforeInstall(e: Event) {
      e.preventDefault()
      setDeferredPrompt(e)
      setShowInstall(true)
    }
    window.addEventListener('beforeinstallprompt', handleBeforeInstall)
    return () => window.removeEventListener('beforeinstallprompt', handleBeforeInstall)
  }, [])

  async function installPwa() {
    if (!deferredPrompt) return
    const prompt = deferredPrompt as BeforeInstallPromptEvent
    prompt.prompt()
    const { outcome } = await prompt.userChoice
    if (outcome === 'accepted') setShowInstall(false)
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-6 bg-zinc-50 dark:bg-zinc-950 px-4">
      <div className="text-center space-y-2">
        {status === 'pairing' && (
          <>
            <div className="w-10 h-10 border-4 border-zinc-300 border-t-zinc-700 rounded-full animate-spin mx-auto" />
            <p className="text-sm text-zinc-500">Pairing…</p>
          </>
        )}
        {status === 'done' && (
          <>
            <div className="text-4xl">✓</div>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Token stored. Redirecting to Dashboard…
            </p>
          </>
        )}
        {status === 'no_token' && (
          <>
            <div className="text-4xl">✗</div>
            <p className="text-sm text-red-500">No token found in URL.</p>
            <p className="text-xs text-zinc-500">
              Open the pairing link from the CLI: <code className="font-mono">orchestron pair</code>
            </p>
          </>
        )}
      </div>

      {showInstall && (
        <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-6 max-w-sm w-full text-center shadow-sm">
          <p className="font-semibold mb-1">Install as app</p>
          <p className="text-sm text-zinc-500 mb-4">
            Add Orchestron to your home screen for quick access.
          </p>
          <button
            onClick={installPwa}
            className="w-full py-2 bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 rounded-lg text-sm font-medium hover:opacity-90 transition-opacity"
          >
            Install
          </button>
          <button
            onClick={() => setShowInstall(false)}
            className="mt-2 text-xs text-zinc-400 hover:text-zinc-600"
          >
            Skip
          </button>
        </div>
      )}
    </div>
  )
}

// BeforeInstallPromptEvent is not in standard TS lib
declare global {
  interface BeforeInstallPromptEvent extends Event {
    prompt(): Promise<void>
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
  }
}

export default function PairPage() {
  return (
    <Suspense>
      <PairInner />
    </Suspense>
  )
}
