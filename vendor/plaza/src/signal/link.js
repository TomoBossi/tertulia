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
  constructor({ selfId, peerId, rtcConfig, send, emit, log }) {
    this.peerId = peerId
    this.polite = isPolite(selfId, peerId)
    this.#send = send
    this.#emit = emit
    this.#log = log

    this.pc = new RTCPeerConnection(rtcConfig)
    this.#wire()

    // The impolite side owns the channel, which is also what starts
    // negotiation: creating it fires negotiationneeded. The polite side waits
    // for the offer. One opener means no duplicate connection can exist.
    if (!this.polite) {
      this.#adopt(this.pc.createDataChannel('plaza', { ordered: true }))
    } else {
      this.pc.ondatachannel = ({ channel }) => this.#adopt(channel)
    }
  }

  #wire() {
    const pc = this.pc

    pc.onnegotiationneeded = async () => {
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
      if (candidate) this.#send({ type: 'candidate', candidate: candidate.toJSON() })
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

  addStream(stream) {
    for (const track of stream.getTracks()) {
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
