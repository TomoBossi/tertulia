/**
 * Reading what the browser knows about a peer connection.
 *
 * When a call goes wrong the useful question is never "is it broken" but
 * "which part". A peer can be perfectly connected and starved of bandwidth, or
 * connected only through a relay, or stuck because two symmetric NATs could
 * not be talked around. Those need completely different responses from a user,
 * and `getStats()` can tell them apart — it just buries the answer in a few
 * hundred entries of a Map keyed by opaque ids.
 *
 * This module extracts the handful that matter.
 */

/**
 * Summarise a peer connection.
 *
 * @param {RTCPeerConnection} pc
 * @returns {Promise<{
 *   state: string, path: string|null, relayed: boolean, rtt: number|null,
 *   address: string|null, protocol: string|null,
 *   inboundKbps: number|null, outboundKbps: number|null, packetLoss: number|null
 * }>}
 */
export async function watchConnection(pc) {
  const summary = {
    state: pc.iceConnectionState,
    path: null,
    relayed: false,
    rtt: null,
    address: null,
    protocol: null,
    inboundKbps: null,
    outboundKbps: null,
    packetLoss: null,
  }

  let stats
  try {
    stats = await pc.getStats()
  } catch {
    return summary
  }

  const pair = selectedPair(stats)
  if (pair) {
    const local = stats.get(pair.localCandidateId)
    const remote = stats.get(pair.remoteCandidateId)

    if (local && remote) {
      summary.path = `${local.candidateType}/${remote.candidateType}`
      summary.relayed = local.candidateType === 'relay' || remote.candidateType === 'relay'
      summary.address = remote.address ?? null
      summary.protocol = remote.protocol ?? null
    }
    if (typeof pair.currentRoundTripTime === 'number') {
      summary.rtt = Math.round(pair.currentRoundTripTime * 1000)
    }
  }

  const rates = throughput(stats, pc)
  Object.assign(summary, rates)

  return summary
}

/**
 * Find the candidate pair actually carrying traffic.
 *
 * The transport entry names it directly, which is the reliable route. Older
 * implementations do not always populate that, so fall back to scanning for a
 * succeeded, nominated pair.
 */
function selectedPair(stats) {
  let pair = null

  stats.forEach((report) => {
    if (report.type === 'transport' && report.selectedCandidatePairId) {
      pair = stats.get(report.selectedCandidatePairId) ?? pair
    }
  })
  if (pair) return pair

  stats.forEach((report) => {
    if (report.type === 'candidate-pair' && report.state === 'succeeded' && (report.nominated || !pair)) {
      pair = report
    }
  })
  return pair
}

/**
 * Bitrate and loss, derived by differencing successive samples.
 *
 * The stats API reports running totals, so a rate only exists relative to a
 * previous reading. Each connection's last sample is stashed on the connection
 * object itself, which keeps this function free of any registry that would
 * need cleaning up when a peer leaves.
 */
function throughput(stats, pc) {
  let bytesIn = 0
  let bytesOut = 0
  let packetsLost = 0
  let packetsReceived = 0

  stats.forEach((report) => {
    if (report.type === 'inbound-rtp') {
      bytesIn += report.bytesReceived ?? 0
      packetsLost += report.packetsLost ?? 0
      packetsReceived += report.packetsReceived ?? 0
    } else if (report.type === 'outbound-rtp') {
      bytesOut += report.bytesSent ?? 0
    }
  })

  const now = performance.now()
  const previous = pc.__plazaSample
  pc.__plazaSample = { at: now, bytesIn, bytesOut }

  if (!previous) return {}

  const seconds = (now - previous.at) / 1000
  if (seconds <= 0) return {}

  const total = packetsLost + packetsReceived
  return {
    inboundKbps: Math.round(((bytesIn - previous.bytesIn) * 8) / seconds / 1000),
    outboundKbps: Math.round(((bytesOut - previous.bytesOut) * 8) / seconds / 1000),
    packetLoss: total > 0 ? Math.round((packetsLost / total) * 1000) / 10 : null,
  }
}

/**
 * Turn a connection summary into something worth showing a person.
 *
 * The point of surfacing this at all is that "Ana cannot hear Beto" is
 * otherwise indistinguishable from "Beto is not talking". Naming the failure,
 * and saying which pair it affects, turns a baffling call into a fixable one.
 */
export function describeConnection(net) {
  if (!net) return { label: 'unknown', tone: 'muted', detail: '' }

  switch (net.state) {
    case 'failed':
      return {
        label: 'cannot connect',
        tone: 'bad',
        detail: 'No direct path could be found between you, and there is no relay configured. This usually means both networks assign a different outbound port per destination — most often two mobile connections.',
      }
    case 'disconnected':
      return { label: 'reconnecting', tone: 'warn', detail: 'The connection dropped and is being retried.' }
    case 'closed':
      return { label: 'closed', tone: 'muted', detail: '' }
    case 'checking':
    case 'new':
      return { label: 'connecting', tone: 'muted', detail: 'Trying to find a path through both networks.' }
  }

  if (net.relayed) {
    return {
      label: 'relayed',
      tone: 'warn',
      detail: 'Traffic is going through a relay rather than directly, which adds delay.',
    }
  }

  // A call between continents is 250-300ms and there is nothing wrong with
  // it — that is the speed of light through fibre, not a fault. Flagging it
  // teaches people to ignore the warning, so the threshold sits above what
  // distance alone can explain. Past roughly 350ms something other than
  // geography is involved.
  const strained = net.rtt != null && net.rtt > 350

  return {
    label: net.path === 'host/host' ? 'direct (local)' : 'direct',
    tone: strained ? 'warn' : 'good',
    detail: net.rtt == null ? ''
      : strained ? `${net.rtt} ms round trip — higher than distance alone explains`
        : `${net.rtt} ms round trip`,
  }
}
