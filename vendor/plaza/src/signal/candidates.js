/**
 * What an address can actually reach.
 *
 * Two peers connect only over an address family they both have. That sounds
 * too obvious to write down, and it is exactly the failure this module exists
 * to make visible: a phone on a modern mobile network is frequently IPv6-only,
 * a home connection whose ISP has not enabled IPv6 is IPv4-only, and those two
 * cannot reach each other by any route. No amount of STUN, retrying, or
 * signalling fixes it, because there is no path to find.
 *
 * That case used to be reported here as "STUN did not answer", which is both
 * wrong and actively misleading. It is wrong because a global IPv6 host
 * address needs no STUN — there is no NAT in front of it to discover, so the
 * browser gathers it directly and discards the reflexive candidate that would
 * duplicate it. Zero reflexive candidates is what perfect connectivity looks
 * like on IPv6. Reading that as failure inverts the diagnosis.
 */

/**
 * Classify one address.
 *
 * Returns the family and whether the address means anything outside the local
 * network, which is the only distinction the rest of the code cares about.
 */
export function classify(address) {
  if (!address) return { family: null, global: false, why: 'absent' }

  // Chrome replaces host addresses with a random `.local` name until the page
  // has been granted camera or microphone access. Nothing can be concluded
  // from one, and pretending otherwise produces confident wrong answers.
  if (address.endsWith('.local')) return { family: null, global: false, why: 'hidden by mDNS' }

  if (address.includes(':')) {
    const head = address.toLowerCase()
    if (head.startsWith('fe80')) return { family: 6, global: false, why: 'link-local' }
    // fc00::/7 — unique local, the IPv6 equivalent of a private range.
    if (/^f[cd]/.test(head)) return { family: 6, global: false, why: 'unique-local' }
    // 2000::/3 is global unicast; everything routable on the public internet
    // lives there, and it needs no NAT traversal of any kind.
    if (/^[23]/.test(head)) return { family: 6, global: true, why: 'global' }
    return { family: 6, global: false, why: 'reserved' }
  }

  const octets = address.split('.').map(Number)
  if (octets.length !== 4 || octets.some((n) => !Number.isFinite(n))) {
    return { family: null, global: false, why: 'unparseable' }
  }
  const [a, b] = octets
  if (a === 10 || a === 127 || (a === 192 && b === 168)) return { family: 4, global: false, why: 'private' }
  if (a === 172 && b >= 16 && b <= 31) return { family: 4, global: false, why: 'private' }
  if (a === 169 && b === 254) return { family: 4, global: false, why: 'link-local' }
  // 100.64.0.0/10 — the range carriers use for CGNAT. Routable-looking and
  // not routable, which is precisely why it gets its own label.
  if (a === 100 && b >= 64 && b <= 127) return { family: 4, global: false, why: 'carrier NAT' }
  return { family: 4, global: true, why: 'global' }
}

/** Every candidate line in an SDP, parsed to {type, address}. */
export function candidatesIn(sdp) {
  const out = []
  for (const line of (sdp ?? '').split(/\r?\n/)) {
    // a=candidate:<foundation> <component> <transport> <priority> <address> <port> typ <type> …
    const m = line.match(/^a=candidate:\S+ \d+ \S+ \d+ (\S+) (\d+) typ (\w+)/)
    if (m) out.push({ address: m[1], port: Number(m[2]), type: m[3] })
  }
  return out
}

/**
 * Summarise what an offer or answer is actually offering.
 *
 * `reachable` is the question worth asking, and it is deliberately not "did we
 * get a reflexive candidate": a global IPv6 host address is reachable, a relay
 * candidate is reachable, and a LAN address behind a NAT nobody has probed is
 * not. The families are reported separately because a connection needs an
 * overlap, and the absence of one is invisible from either side alone.
 */
export function summarize(sdp) {
  const all = candidatesIn(sdp)
  const seen = { host: 0, srflx: 0, relay: 0, prflx: 0 }
  const families = new Set()
  let globalV6 = null

  for (const c of all) {
    if (c.type in seen) seen[c.type]++
    const { family, global } = classify(c.address)
    if (global && family) families.add(family)
    if (global && family === 6 && !globalV6) globalV6 = c.address
  }

  return {
    ...seen,
    total: all.length,
    ip4: families.has(4),
    ip6: families.has(6),
    globalV6,
    reachable: families.size > 0 || seen.relay > 0,
  }
}

/** A one-line description for the log, naming the families that matter. */
export function describe(sdp) {
  const s = summarize(sdp)
  const families = [s.ip4 && 'IPv4', s.ip6 && 'IPv6'].filter(Boolean).join('+')
  const parts = `${s.host} host, ${s.srflx} reflexive, ${s.relay} relayed`

  if (!s.reachable) {
    return `${parts} — NOTHING REACHABLE (no public address of either family)`
  }
  return `${parts} — reachable over ${families}`
}
