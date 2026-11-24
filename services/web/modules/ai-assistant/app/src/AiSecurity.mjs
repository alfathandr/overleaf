import dns from 'node:dns/promises'
import net from 'node:net'

function isPrivateIpv4(ip) {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some(n => Number.isNaN(n))) return true
  const [a, b] = parts
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a >= 224) return true
  return false
}

function isPrivateIpv6(ip) {
  const lower = ip.toLowerCase()
  if (lower === '::1' || lower === '::') return true
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true
  if (
    lower.startsWith('fe8') ||
    lower.startsWith('fe9') ||
    lower.startsWith('fea') ||
    lower.startsWith('feb')
  ) {
    return true
  }
  const v4Mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (v4Mapped) return isPrivateIpv4(v4Mapped[1])
  return false
}

export function isPrivateIp(ip) {
  const family = net.isIP(ip)
  if (family === 4) return isPrivateIpv4(ip)
  if (family === 6) return isPrivateIpv6(ip)
  return true
}

/**
 * Validates that a remote URL is safe to fetch (prevents SSRF against
 * localhost, cloud metadata endpoints, and private RFC1918/ULA ranges).
 * @param {string} rawUrl
 * @returns {Promise<URL>}
 */
export async function assertSafeExternalUrl(rawUrl) {
  let parsed
  try {
    parsed = new URL(String(rawUrl || '').trim())
  } catch {
    throw new Error('Invalid URL format')
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http:// and https:// URLs are allowed')
  }

  const host = parsed.hostname.toLowerCase()
  if (
    !host ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    throw new Error('Blocked internal or localhost URL (SSRF protection)')
  }

  if (net.isIP(host)) {
    if (isPrivateIp(host)) {
      throw new Error('Blocked private or loopback IP address (SSRF protection)')
    }
    return parsed
  }

  let addresses
  try {
    addresses = await dns.lookup(host, { all: true })
  } catch {
    throw new Error(`Could not resolve hostname: ${host}`)
  }

  if (!addresses || addresses.length === 0) {
    throw new Error(`No DNS records found for hostname: ${host}`)
  }

  for (const addr of addresses) {
    if (isPrivateIp(addr.address)) {
      throw new Error(
        `Hostname ${host} resolves to a private/internal IP (SSRF protection)`
      )
    }
  }

  return parsed
}
