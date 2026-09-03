import { useEffect, useState, useCallback } from 'react'

export interface ApiConfig {
  baseUrl: string
  token?: string
}

export function getHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) h['Authorization'] = `Bearer ${token}`
  return h
}

export function useApi<T>(
  path: string,
  config: ApiConfig,
  pollMs = 3000,
): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  const reload = useCallback(() => setTick((t) => t + 1), [])

  useEffect(() => {
    let cancelled = false

    async function fetchData() {
      try {
        const res = await fetch(`${config.baseUrl}${path}`, {
          headers: getHeaders(config.token),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = (await res.json()) as T
        if (!cancelled) {
          setData(json)
          setError(null)
        }
      } catch (e) {
        if (!cancelled) setError(String(e))
      }
    }

    fetchData()
    const id = setInterval(fetchData, pollMs)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [path, config.baseUrl, config.token, pollMs, tick])

  return { data, error, reload }
}

export async function apiPost<T>(
  path: string,
  body: unknown,
  config: ApiConfig,
): Promise<T> {
  const res = await fetch(`${config.baseUrl}${path}`, {
    method: 'POST',
    headers: getHeaders(config.token),
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<T>
}

export async function apiDelete(path: string, config: ApiConfig): Promise<void> {
  const res = await fetch(`${config.baseUrl}${path}`, {
    method: 'DELETE',
    headers: getHeaders(config.token),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
}
