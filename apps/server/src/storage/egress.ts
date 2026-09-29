import { lookup, type LookupAddress, type LookupAllOptions } from 'node:dns'
import { BlockList, isIP } from 'node:net'
import { Agent } from 'undici'

/**
 * Keeps requests to storage that people set up themselves on the public internet: they can't point the server at
 * itself, the machine's network, or a cloud provider's internal addresses (SSRF). The check happens when the
 * connection is made, on the address actually used, so a name that later changes where it points (DNS rebinding)
 * doesn't get around it. The platform's own storage (set by its admins) isn't restricted: it may well be a MinIO
 * on the local network.
 */

const blocked = new BlockList()
const V4: [string, number][] = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, including cloud metadata (169.254.169.254)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
]
const V6: [string, number][] = [
  ['::', 96], // unspecified, loopback, and IPv4-compatible (::a.b.c.d, deprecated)
  ['100::', 64], // discard
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 (carries an IPv4 address)
  ['fc00::', 7], // unique local (private)
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
]
for (const [net, prefix] of V4) blocked.addSubnet(net, prefix, 'ipv4')
for (const [net, prefix] of V6) blocked.addSubnet(net, prefix, 'ipv6')

/** The IPv4 address inside an IPv4-mapped (::ffff:a.b.c.d) or NAT64 (64:ff9b::a.b.c.d) IPv6 address, if any. */
function embeddedV4(address: string): string | null {
  const a = address.toLowerCase()
  const m = /^(?:::ffff:|64:ff9b::)(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(a)
  if (!m) return null
  if (m[1]) return m[1]
  const hi = parseInt(m[2], 16)
  const lo = parseInt(m[3], 16)
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.')
}

/** Whether the server may connect to this IP address for someone's own storage. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return !blocked.check(address, 'ipv4')
  if (family === 6) {
    const v4 = embeddedV4(address)
    if (v4) return !blocked.check(v4, 'ipv4')
    return !blocked.check(address, 'ipv6')
  }
  return false
}

export class PrivateAddressError extends Error {
  code = 'EPRIVATEADDRESS'
}

/** Refuses the names that point anywhere private (all of their addresses must be public). */
export function publicLookup(hostname: string, options: LookupAllOptions | object, callback: (...args: unknown[]) => void) {
  lookup(hostname, { ...(options as object), all: true }, (err, addresses: LookupAddress[]) => {
    if (err) return callback(err)
    const bad = addresses.find((a) => !isPublicAddress(a.address))
    if (bad || !addresses.length)
      return callback(new PrivateAddressError(`${hostname} points to a private network address${bad ? ` (${bad.address})` : ''}`))
    if ((options as { all?: boolean }).all) callback(null, addresses)
    else callback(null, addresses[0].address, addresses[0].family)
  })
}

/** Connections for someone's own storage: only to public addresses. */
export const publicOnly = new Agent({ connect: { lookup: publicLookup as never } })

/**
 * Checks an endpoint before any connection: a literal IP address skips name lookups entirely, so it's checked here.
 * Throws a readable reason for a private one.
 */
export function assertPublicEndpoint(endpoint: string) {
  const host = new URL(endpoint).hostname.replace(/^\[|\]$/g, '')
  if (isIP(host) && !isPublicAddress(host)) throw new PrivateAddressError(`${host} is a private network address`)
  if (/^localhost$|\.localhost$|\.local$|\.internal$/i.test(host)) throw new PrivateAddressError(`${host} is a private network name`)
}
