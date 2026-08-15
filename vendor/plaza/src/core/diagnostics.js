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
 * The connection's state, read from the field that tells the truth.
 *
 * `iceConnectionState` is the legacy aggregate and it lies after exactly the
 * renegotiations this stack performs on every call — adding media right after
 * the data channel opens. Chrome can leave it on `checking` indefinitely for
 * a connection that is verifiably carrying traffic, and both field logs of a
 * call "stuck connecting" show that signature: the peer completed its
 * handshake over an open data channel half a second before the state claimed
 * it was still trying. `connectionState` aggregates ICE and DTLS per the
 * modern spec and does not have the bug, so it wins whenever it has an
 * opinion; the legacy state is only a fallback for `new`, where the modern
 * field has nothing to say yet.
 */
export function connectionStateOf(pc) {
  const modern = pc.connectionState
  if (modern && modern !== 'new') return modern
  return pc.iceConnectionState ?? modern ?? 'new'
}

/**
 * Summarise a peer connection.
 *
 * Note which direction each number describes. `packetLoss` is what *we* failed
 * to receive; `remoteLoss` is what the far end reports failing to receive from
 * us. They are routinely nothing alike, and a call where one person cannot be
 * heard is precisely the case where only one of them moves. Reporting the
 * inbound one alone makes the healthy direction look like the story.
 *
 * @param {RTCPeerConnection} pc
 * @returns {Promise<{
 *   state: string, path: string|null, relayed: boolean, rtt: number|null,
 *   address: string|null, protocol: string|null,
 *   inboundKbps: number|null, outboundKbps: number|null, packetLoss: number|null,
 *   remoteLoss: number|null, remoteJitter: number|null,
 *   playoutDelay: number|null, freezeRatio: number|null
 * }>}
 */
export async function watchConnection(pc) {
  const summary = {
    state: connectionStateOf(pc),
    path: null,
    relayed: false,
    rtt: null,
    address: null,
    protocol: null,
    inboundKbps: null,
    outboundKbps: null,
    packetLoss: null,
    remoteLoss: null,
    remoteJitter: null,
    playoutDelay: null,
    freezeRatio: null,
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

  // How long the receiver is holding audio and video back before playing it.
  // This is the number that explains a call where the connection is healthy
  // and the person still answers a second late: the jitter buffer grew during
  // a rough patch and, in continuous speech, has no quiet moment in which to
  // shrink again. It is a *delay*, not a fault, and nothing else reports it.
  let jitterDelay = 0
  let jitterCount = 0

  // Freezes are the visible half of the same story.
  let freezeSeconds = 0
  let videoSeconds = 0

  // The far end's opinion of what we send it, carried back in RTCP receiver
  // reports. Without this a sender is blind to its own outbound direction.
  let remoteLost = null
  let remoteJitter = null

  stats.forEach((report) => {
    if (report.type === 'inbound-rtp') {
      bytesIn += report.bytesReceived ?? 0
      packetsLost += report.packetsLost ?? 0
      packetsReceived += report.packetsReceived ?? 0
      jitterDelay += report.jitterBufferDelay ?? 0
      jitterCount += report.jitterBufferEmittedCount ?? 0
      if (report.kind === 'video') {
        freezeSeconds += report.totalFreezesDuration ?? 0
        videoSeconds += report.totalInterFrameDelay ?? 0
      }
    } else if (report.type === 'outbound-rtp') {
      bytesOut += report.bytesSent ?? 0
    } else if (report.type === 'remote-inbound-rtp') {
      if (typeof report.fractionLost === 'number') {
        remoteLost = Math.max(remoteLost ?? 0, report.fractionLost)
      }
      if (typeof report.jitter === 'number') {
        remoteJitter = Math.max(remoteJitter ?? 0, report.jitter)
      }
    }
  })

  const derived = {
    // jitterBufferDelay is cumulative seconds across every frame emitted, so
    // dividing by the count gives the average hold time per frame.
    playoutDelay: jitterCount > 0 ? Math.round((jitterDelay / jitterCount) * 1000) : null,
    remoteLoss: remoteLost == null ? null : Math.round(remoteLost * 1000) / 10,
    remoteJitter: remoteJitter == null ? null : Math.round(remoteJitter * 1000),
    freezeRatio: videoSeconds > 0 ? Math.round((freezeSeconds / videoSeconds) * 1000) / 10 : null,
  }

  const now = performance.now()
  const previous = pc.__plazaSample
  pc.__plazaSample = { at: now, bytesIn, bytesOut }

  if (!previous) return derived

  const seconds = (now - previous.at) / 1000
  if (seconds <= 0) return derived

  const total = packetsLost + packetsReceived
  return {
    ...derived,
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
    case 'connecting':
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

  // Held media outranks a slow path, because it is the failure people
  // actually notice and the one no other number reveals. A round trip of 5ms
  // and a playout delay of 900ms is a call nobody can hold a conversation on,
  // and every other reading looks perfect.
  if (net.playoutDelay != null && net.playoutDelay > 400) {
    return {
      label: 'delayed',
      tone: 'warn',
      detail: `${net.playoutDelay} ms of buffering on top of a ${net.rtt ?? '?'} ms path — `
        + 'their side is holding media back to smooth over uneven arrival',
    }
  }

  // Loss we are causing them, which a sender is otherwise blind to. The
  // inbound figure describes the direction that is working.
  if (net.remoteLoss != null && net.remoteLoss > 5) {
    return {
      label: 'lossy outbound',
      tone: 'warn',
      detail: `they are losing ${net.remoteLoss}% of what we send, `
        + `while we lose ${net.packetLoss ?? 0}% of theirs`,
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

/**
 * Ask what kind of NAT this machine is behind.
 *
 * This is the question that decides whether two people can be connected
 * directly at all, and until now nothing in the stack could answer it. A
 * handshake that hangs at `checking` looks identical whether the cause is a
 * temporary blip, a stale address, or a NAT that makes direct connection
 * permanently impossible — and only the last one is worth changing plans over.
 *
 * The test is to ask several STUN servers from the *same* local socket. A
 * router that assigns one external port per internal socket gives the same
 * answer to all of them, and a peer told that address can reach you on it.
 * One that assigns a fresh port per destination gives a different answer to
 * each, which means the address your peer is given is by construction not the
 * one they will arrive on — the mapping is dead before it is sent. No amount
 * of hole punching fixes that. It needs a relay.
 *
 * Running several STUN servers on one connection rather than one each is the
 * whole trick: separate connections use separate sockets, so they would report
 * different ports even behind the most cooperative router in the world, and
 * the test would say "symmetric" everywhere.
 */
export async function probeNat({ iceServers, timeout = 6000 } = {}) {
  const result = { mapping: 'unknown', candidates: [], detail: '' }

  let pc
  try {
    pc = new RTCPeerConnection({ iceServers })
  } catch (err) {
    result.detail = err.message
    return result
  }

  try {
    pc.createDataChannel('nat-probe')

    const srflx = []
    const hostPorts = new Set()

    const done = new Promise((resolve) => {
      const finish = () => resolve()
      pc.onicecandidate = ({ candidate }) => {
        if (!candidate) return finish() // gathering complete
        if (candidate.type === 'host') hostPorts.add(candidate.port)
        if (candidate.type === 'srflx') srflx.push({ address: candidate.address, port: candidate.port })
      }
      setTimeout(finish, timeout)
    })

    await pc.setLocalDescription(await pc.createOffer())
    await done

    const mappings = new Set(srflx.map((c) => `${c.address}:${c.port}`))
    result.candidates = [...mappings]

    if (mappings.size === 0) {
      result.detail = 'no reflexive candidate was gathered; STUN did not answer'
      return result
    }

    // The counting is subtle and worth stating, because getting it backwards
    // inverts the verdict.
    //
    // Browsers discard a reflexive candidate identical to one already found,
    // so several STUN servers all reporting the same mapping produce exactly
    // one candidate. One mapping is therefore the *good* answer, not a
    // shortage of evidence. A router that hands out a port per destination
    // produces a distinct candidate per server instead.
    //
    // Comparing against the number of local sockets is what keeps that honest:
    // a machine on wifi and ethernet at once legitimately has two of
    // everything, and would otherwise look symmetric for having two mappings.
    // Local ports are readable even when the addresses are hidden behind mDNS,
    // which the relatedPort field is not — it reads zero there, which is why
    // this does not group by it.
    const sockets = Math.max(1, hostPorts.size)

    if (mappings.size > sockets) {
      result.mapping = 'address-dependent'
      result.detail = `${mappings.size} external addresses for ${sockets} local socket`
        + `${sockets === 1 ? '' : 's'} — a different port per destination, so direct connections cannot be made`
    } else {
      result.mapping = 'endpoint-independent'
      result.detail = 'every STUN server saw the same address — direct connections work'
    }
    return result
  } catch (err) {
    result.detail = err.message
    return result
  } finally {
    try { pc.close() } catch { /* already gone */ }
  }
}
