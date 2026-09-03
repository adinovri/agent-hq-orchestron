import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { networkInterfaces } from 'node:os'

const execFileAsync = promisify(execFile)

const PRIVATE_RANGES = [
  /^192\.168\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
]

function isPrivate(ip: string): boolean {
  return PRIVATE_RANGES.some((r) => r.test(ip))
}

export async function resolveHost(): Promise<{ host: string; source: string }> {
  // 1. Try Tailscale
  try {
    const { stdout } = await execFileAsync('tailscale', ['ip', '-4'])
    const ip = stdout.trim()
    if (ip) return { host: ip, source: 'tailscale' }
  } catch {
    // not available
  }

  // 2. Scan network interfaces
  const ifaces = networkInterfaces()
  const candidates: string[] = []
  for (const ifaceList of Object.values(ifaces)) {
    if (!ifaceList) continue
    for (const iface of ifaceList) {
      if (iface.family !== 'IPv4' || iface.internal) continue
      if (isPrivate(iface.address)) {
        // Prefer 192.168.*
        if (iface.address.startsWith('192.168.')) {
          candidates.unshift(iface.address)
        } else {
          candidates.push(iface.address)
        }
      }
    }
  }

  if (candidates.length > 0) {
    return { host: candidates[0]!, source: 'network-interface' }
  }

  // 3. Fallback
  process.stderr.write(
    'Warning: could not detect LAN IP — falling back to 127.0.0.1 (remote access will not work)\n',
  )
  return { host: '127.0.0.1', source: 'fallback' }
}
