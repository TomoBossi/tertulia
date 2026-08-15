/**
 * One connection to one peer.
 *
 * This is the whole reason the alternative signalling exists. Everything here
 * is a single connection's life: no pool of pre-warmed connections, no
 * connection shared between rooms behind a proxy, no second connection racing
 * the first. A peer has exactly one link, it is created when the peer is
 * discovered, and it is discarded when it dies. Every state change is
 * reported, so a failure explains itself instead of being inferred afterwards.
 *
 * Negotiation follows WebRTC's perfect-negotiation pattern verbatim
 * (webrtc/samples, peerconnection/perfect-negotiation), including the parts
 * that look like paranoia:
 *
 *   - the polite peer rolls back *implicitly*, by setting the remote
 *     description while its own offer is outstanding, rather than issuing an
 *     explicit rollback that is illegal from the stable state;
 *   - the impolite peer ignores a colliding offer and remembers that it did,
 *     so the candidates that follow can fail quietly instead of being treated
 *     as an error;
 *   - a candidate that cannot be applied is never fatal. Trickle keeps sending
 *     after a pair is nominated, renegotiation moves the ufrag underneath one
 *     in flight, and the same candidate arrives twice when two relays both
 *     deliver it. None of that is a reason to end a call.
 */

/** Role, decided by comparing ids, so both sides always agree without asking. */
export const isPolite = (selfId, peerId) => selfId > peerId

/**
 * How long to wait for candidate gathering when candidates cannot be trickled.
 *
 * A tracker carries one offer and one answer and nothing else, so everything a
 * connection will ever know about itself has to be in them. Gathering usually
 * finishes in well under a second; this is the ceiling before giving up and
 * sending what we have, which is often enough on its own.
 */
const GATHER_TIMEOUT_MS = 4000

/**
 * Public STUN servers, always included.
 *
 * Without these a connection gathers host candidates only — the machine's own
 * LAN addresses — which work beautifully between two tabs on one computer and
 * cannot possibly work between two networks. That combination is a trap: every
 * local test passes and every real call fails with `ice failed` after ten
 * seconds of trying addresses nobody outside the house can reach.
 *
 * They are merged with the caller's configuration rather than replaced by it,
 * so supplying a TURN server adds a relay without silently removing the means
 * of avoiding one.
 */
export const DEFAULT_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
]

/** Merge caller configuration over the defaults, keeping both sets of servers. */
export function iceConfiguration(rtcConfig) {
  return {
    ...rtcConfig,
    iceServers: [...DEFAULT_ICE_SERVERS, ...(rtcConfig?.iceServers ?? [])],
  }
}

export class Link {
  /** @type {RTCPeerConnection} */ pc
  /** @type {RTCDataChannel|null} */ channel = null

  peerId
  polite
  open = false
  dead = false

  #send
  #emit
  #log
  #makingOffer = false
  #ignoringOffer = false
  #settingRemoteAnswer = false
  #pendingCandidates = []
  #queuedOut = []

  /**
   * @param {object} options
   * @param {string} options.selfId
   * @param {string} options.peerId
   * @param {RTCConfiguration} options.rtcConfig
   * @param {(msg: object) => void} options.send      deliver a signal to the peer
   * @param {(event: string, ...args: any[]) => void} options.emit
   * @param {(what: string, detail?: string) => void} options.log
   */
  /**
   * @param {object} options
   * @param {string} options.selfId
   * @param {string} [options.peerId]   unknown up front in tracker mode
   * @param {'offer'|'answer'} [options.role]  set explicitly when there is no
   *   peer id to compare against, which is the case for a speculative offer
   * @param {boolean} [options.trickle] false when candidates cannot be sent
   *   separately from the description that carries them
   */
  constructor({ selfId, peerId, rtcConfig, send, emit, log, role, trickle = true }) {
    this.peerId = peerId
    this.trickle = trickle
    // With a tracker there is no id to compare — whoever's offer the tracker
    // handed out is the offerer, and there is exactly one offer per
    // connection, so a collision cannot arise in the first place.
    this.polite = role ? role === 'answer' : isPolite(selfId, peerId)
    this.#send = send
    this.#emit = emit
    this.#log = log

    this.pc = new RTCPeerConnection(iceConfiguration(rtcConfig))
    this.#wire()

    // The offering side owns the channel, which is also what starts
    // negotiation: creating it fires negotiationneeded. The answering side
    // waits. One opener means no duplicate connection can exist.
    if (!this.polite) {
      this.#adopt(this.pc.createDataChannel('plaza', { ordered: true }))
    } else {
      this.pc.ondatachannel = ({ channel }) => this.#adopt(channel)
    }
  }

  /**
   * Wait until this connection knows every address it is going to offer.
   *
   * Resolves early when gathering completes, which is the normal case, and on
   * a deadline otherwise: a partial candidate set still connects far more
   * often than no offer at all.
   */
  #gathered() {
    if (this.pc.iceGatheringState === 'complete') return Promise.resolve()
    return new Promise((resolve) => {
      const done = () => {
        this.pc.removeEventListener('icegatheringstatechange', check)
        clearTimeout(timer)
        resolve()
      }
      const check = () => { if (this.pc.iceGatheringState === 'complete') done() }
      const timer = setTimeout(() => {
        this.#log('gather-timeout', `sending ${this.pc.localDescription ? 'partial' : 'no'} candidates`)
        done()
      }, GATHER_TIMEOUT_MS)
      this.pc.addEventListener('icegatheringstatechange', check)
      check()
    })
  }

  /** A complete offer, candidates included. For rendezvous without trickle. */
  async completeOffer() {
    await this.pc.setLocalDescription(await this.pc.createOffer())
    await this.#gathered()
    return this.pc.localDescription?.sdp ?? null
  }

  /** A complete answer to a complete offer. */
  async completeAnswer(offerSdp) {
    await this.pc.setRemoteDescription({ type: 'offer', sdp: offerSdp })
    await this.pc.setLocalDescription(await this.pc.createAnswer())
    await this.#gathered()
    return this.pc.localDescription?.sdp ?? null
  }

  /** Apply the answer to an offer we published speculatively. */
  async applyAnswer(sdp) {
    try {
      await this.pc.setRemoteDescription({ type: 'answer', sdp })
      return true
    } catch (err) {
      this.#log('answer-rejected', err?.message ?? String(err))
      return false
    }
  }

  /** Name the peer once the rendezvous has said who answered. */
  identify(peerId) {
    this.peerId = peerId
  }

  #wire() {
    const pc = this.pc

    pc.onnegotiationneeded = async () => {
      // Without trickle the description is carried once, by the rendezvous, and
      // there is no path for a later one. Media added after the fact simply
      // is not renegotiated rather than producing an offer nobody receives.
      if (!this.trickle) return
      try {
        this.#makingOffer = true
        await pc.setLocalDescription()
        this.#send({ type: 'description', description: pc.localDescription })
      } catch (err) {
        this.#log('negotiation-failed', err?.message ?? String(err))
      } finally {
        this.#makingOffer = false
      }
    }

    pc.onicecandidate = ({ candidate }) => {
      if (candidate && this.trickle) this.#send({ type: 'candidate', candidate: candidate.toJSON() })
    }

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState
      this.#log('state', state)
      this.#emit('state', this.peerId, state)

      // Only failed and closed are terminal. `disconnected` is routinely
      // transient — a few missed consent checks will do it — and killing a
      // call over it is how a working connection gets thrown away.
      if (state === 'failed' || state === 'closed') {
        this.die(state === 'failed' ? 'connection failed' : 'connection closed')
      }
    }

    pc.oniceconnectionstatechange = () => {
      // Recorded but never acted on: this is the legacy aggregate and it
      // reports `checking` indefinitely on connections that are verifiably up.
      this.#log('ice', pc.iceConnectionState)
    }

    pc.ontrack = ({ track, streams }) => {
      const stream = streams[0]
      if (stream) this.#emit('track', this.peerId, track, stream)
    }
  }

  #adopt(channel) {
    this.channel = channel
    channel.binaryType = 'arraybuffer'

    channel.onopen = () => {
      this.open = true

      // From here the channel carries its own negotiation. That matters most
      // for a rendezvous that could not trickle: a speculative offer is made
      // before anyone knows who it is for and therefore carries no media, so
      // without this the camera could never be negotiated at all.
      if (!this.trickle) {
        this.trickle = true
        this.#log('trickle-enabled', 'renegotiation now rides the data channel')
      }

      this.#log('channel-open')
      const queued = this.#queuedOut.splice(0)
      for (const data of queued) this.send(data)
      this.#emit('open', this.peerId)
    }

    channel.onclose = () => this.die('data channel closed')

    channel.onerror = ({ error }) => {
      // A channel error that also closed the channel is reported by onclose;
      // one that did not is not worth ending a call over.
      this.#log('channel-error', error?.message ?? 'unknown')
    }

    channel.onmessage = ({ data }) => {
      let parsed
      try {
        parsed = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data))
      } catch {
        return
      }
      this.#emit('message', this.peerId, parsed)
    }
  }

  /**
   * Apply a signal from the peer.
   *
   * The collision rules are the whole point of this method; see the class
   * comment. Nothing in here throws outward: a signal that cannot be applied
   * is logged and dropped, because the alternative — which is what the
   * previous transport did — is that one late candidate ends a working call.
   */
  async accept(msg) {
    if (this.dead) return

    try {
      if (msg.type === 'candidate') {
        try {
          await this.pc.addIceCandidate(msg.candidate)
        } catch (err) {
          // Expected while an offer is being ignored, and harmless otherwise.
          if (!this.#ignoringOffer) this.#log('candidate-dropped', err?.name ?? 'error')
        }
        return
      }

      if (msg.type !== 'description') return
      const description = msg.description

      // "Stable enough": an answer already in flight will leave us stable by
      // the time the next description is applied, so it does not count as a
      // collision. Getting this wrong makes the impolite peer ignore offers it
      // should accept, and the two never converge.
      const stableEnough =
        this.pc.signalingState === 'stable' ||
        (this.pc.signalingState === 'have-local-offer' && this.#settingRemoteAnswer)

      this.#ignoringOffer =
        description.type === 'offer' && !this.polite && (this.#makingOffer || !stableEnough)

      if (this.#ignoringOffer) {
        this.#log('offer-ignored', 'collision; the polite side will yield')
        return
      }

      this.#settingRemoteAnswer = description.type === 'answer'
      try {
        await this.pc.setRemoteDescription(description)
      } finally {
        this.#settingRemoteAnswer = false
      }

      await this.#flushCandidates()

      if (description.type === 'offer') {
        await this.pc.setLocalDescription()
        this.#send({ type: 'description', description: this.pc.localDescription })
      }
    } catch (err) {
      // Logged, not fatal. The connection state machine decides what is
      // terminal; a single bad signal does not.
      this.#log('signal-dropped', err?.message ?? String(err))
    }
  }

  async #flushCandidates() {
    const queued = this.#pendingCandidates.splice(0)
    for (const candidate of queued) {
      try { await this.pc.addIceCandidate(candidate) } catch { /* stale */ }
    }
  }

  /** Send application data. Queued until the channel opens. */
  send(data) {
    if (this.dead) return false
    if (!this.open || this.channel?.readyState !== 'open') {
      this.#queuedOut.push(data)
      return false
    }
    try {
      this.channel.send(JSON.stringify(data))
      return true
    } catch (err) {
      this.#log('send-failed', err?.message ?? String(err))
      return false
    }
  }

  /**
   * Publish our current offer again.
   *
   * For the case where the peer is still waiting on us: the offer was made,
   * but the message carrying it did not arrive. Re-sending the description we
   * already hold is the whole fix — renegotiating would create a second offer
   * and a collision to resolve, for a problem that is only a lost message.
   */
  resendOffer() {
    if (this.dead) return false
    const description = this.pc.localDescription
    if (description?.type !== 'offer') return false
    this.#send({ type: 'description', description })
    return true
  }

  addStream(stream) {
    // Idempotent: the room adds streams to every link, and a link adds
    // whatever is already published when it opens. Both are right, and one of
    // them is always second.
    const existing = new Set(this.pc.getSenders().map((s) => s.track).filter(Boolean))
    for (const track of stream.getTracks()) {
      if (existing.has(track)) continue
      try { this.pc.addTrack(track, stream) } catch (err) { this.#log('addtrack-failed', err?.message) }
    }
  }

  removeStream(stream) {
    const tracks = new Set(stream.getTracks())
    for (const sender of this.pc.getSenders()) {
      if (sender.track && tracks.has(sender.track)) {
        try { this.pc.removeTrack(sender) } catch { /* already gone */ }
      }
    }
  }

  replaceTrack(oldTrack, newTrack) {
    const sender = this.pc.getSenders().find((s) => s.track === oldTrack)
    return sender ? sender.replaceTrack(newTrack) : undefined
  }

  die(why) {
    if (this.dead) return
    this.dead = true
    this.open = false
    this.#log('dead', why)
    try { this.channel?.close() } catch { /* already gone */ }
    try { this.pc.close() } catch { /* already gone */ }
    this.#emit('dead', this.peerId, why)
  }
}
