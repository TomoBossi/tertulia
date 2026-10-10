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
 *
 * One addition, for what the reference cannot untangle in Chromium: once the
 * channel is open, the polite peer asks for a turn before it offers, so the
 * two sides' offers never cross (see #askTurn). The collision rules stay, for
 * the handshake and for anything that slips past.
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

/** How long to keep gathering once a public candidate has arrived. */
const PUBLIC_GRACE_MS = 400

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

/**
 * How a connection that breaks after opening is repaired, or given up on.
 *
 * `restartAfterMs` is the grace before an ICE restart. `disconnected` arrives
 * after a few missed consent checks and most of those clear on their own, so
 * restarting at once would rebuild a working path. Only the offering side
 * restarts — two sides restarting at once collide — and the answering side,
 * which sees the same outage, waits twice as long and then asks it to, as a
 * backstop for an offerer that did not notice.
 *
 * `giveUpMs` is how long a connection may stay broken before it is abandoned
 * outright. The browser's own verdict takes roughly twenty seconds to arrive,
 * and nothing is gained by waiting for it: a restart only helps while some
 * path can still carry its offer, and when none can — the network went away,
 * or came back under a new address — the way back is a new introduction,
 * which cannot start until this one is let go. The room holds the peer's
 * place meanwhile, so letting go early costs a reconnection, not the person.
 */
/**
 * How long the polite side waits for the turn before asking again, and how
 * long the impolite side holds its own offers for an offer that does not come.
 */
const TURN_RETRY_MS = 1000
const TURN_LEND_MS = 5000

export const DEFAULT_REPAIR = { restartAfterMs: 2000, giveUpMs: 8000 }

/**
 * How long an answering connection may have a working path and no handshake.
 *
 * The answering side waits for the offerer to start the handshake, which it
 * does the moment our answer reaches it. A path that connects with no
 * handshake following means the answer never arrived — trackers lose them,
 * and hold them for many seconds after an outage — and the connection cannot
 * progress at all. Holding it blocks every later offer from that peer, so it
 * is let go, and the next introduction gets through.
 */
const HANDSHAKE_STALL_MS = 4000

/** Make an answer the side that waits for the DTLS handshake. */
export const waitForHandshake = (sdp) => sdp.replace(/^a=setup:active\r?$/gm, (line) =>
  line.replace('active', 'passive'))

export class Link {
  /** @type {RTCPeerConnection} */ pc
  /** @type {RTCDataChannel|null} */ channel = null

  peerId
  polite
  open = false
  dead = false
  /**
   * Whether the channel ever opened. `open` is cleared on death, so whoever
   * hears about the death needs this to tell a dropped peer from a handshake
   * that never got anywhere.
   */
  opened = false

  #send
  #emit
  #log
  #makingOffer = false
  /** Polite: a turn to offer has been asked for and not yet given. */
  #turnAsked = null
  /** Impolite: asked for a turn while busy, to be given once stable. */
  #turnOwed = false
  /** Impolite: the turn is lent out; our own offers wait until it is back. */
  #lent = null
  /** Impolite: an offer of ours that waited for the turn to come back. */
  #offerHeld = false
  #ignoringOffer = false
  #settingRemoteAnswer = false
  #pendingCandidates = []
  #queuedOut = []
  #repair
  #restartTimer = null
  #giveUpTimer = null
  #stallTimer = null
  #lastRestart = 0
  /** ICE restarts attempted on this connection, for anyone diagnosing it. */
  restarts = 0

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
  constructor({ selfId, peerId, rtcConfig, send, emit, log, role, trickle = true, repair = DEFAULT_REPAIR }) {
    this.peerId = peerId
    this.trickle = trickle
    // With a tracker there is no id to compare — whoever's offer the tracker
    // handed out is the offerer, and there is exactly one offer per
    // connection, so a collision cannot arise in the first place.
    this.polite = role ? role === 'answer' : isPolite(selfId, peerId)
    this.role = role ?? null
    this.#send = send
    this.#emit = emit
    this.#log = log
    this.#repair = repair

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
      let grace = null
      const done = () => {
        this.pc.removeEventListener('icegatheringstatechange', check)
        this.pc.removeEventListener('icecandidate', onCandidate)
        clearTimeout(timer)
        clearTimeout(grace)
        resolve()
      }
      const check = () => { if (this.pc.iceGatheringState === 'complete') done() }

      // Good enough beats complete. On a machine with many interfaces —
      // VPNs, container bridges, a phone's several radios — gathering never
      // completes before the deadline, because some STUN request on some
      // interface never comes back, and every offer and every answer then
      // waited the full four seconds. Measured between a laptop and a phone.
      // What a connection across the internet needs is a public address; once
      // one has arrived, a moment's grace collects any siblings and the
      // description goes.
      const onCandidate = ({ candidate }) => {
        if (grace || !candidate) return
        if (/ typ (srflx|relay)/.test(candidate.candidate)) grace = setTimeout(done, PUBLIC_GRACE_MS)
      }

      const timer = setTimeout(() => {
        this.#log('gather-timeout', `sending ${this.pc.localDescription ? 'partial' : 'no'} candidates`)
        done()
      }, GATHER_TIMEOUT_MS)
      this.pc.addEventListener('icegatheringstatechange', check)
      this.pc.addEventListener('icecandidate', onCandidate)
      check()
    })
  }

  /** A complete offer, candidates included. For rendezvous without trickle. */
  async completeOffer() {
    await this.pc.setLocalDescription(await this.pc.createOffer())
    await this.#gathered()
    return this.pc.localDescription?.sdp ?? null
  }

  /**
   * A complete answer to a complete offer.
   *
   * The answer makes us the side that waits for the encryption handshake
   * (`setup:passive`) instead of the side that starts it. Started from here,
   * the handshake begins the moment our candidates connect — which is before
   * the offerer has even received this answer, because a tracker relays it
   * on its own schedule. The offerer can do nothing with those attempts, and
   * they back off exponentially from 50ms, so an answer delayed by a few
   * seconds left the next attempt up to thirteen seconds away. Measured in a
   * real run: twenty-five seconds in `connecting` on a path that worked.
   * Started by the offerer, it begins exactly when the answer arrives.
   */
  async completeAnswer(offerSdp) {
    await this.pc.setRemoteDescription({ type: 'offer', sdp: offerSdp })
    const answer = await this.pc.createAnswer()
    await this.pc.setLocalDescription({ type: 'answer', sdp: waitForHandshake(answer.sdp) })
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

    pc.onnegotiationneeded = () => {
      // Without trickle the description is carried once, by the rendezvous, and
      // there is no path for a later one. Media added after the fact simply
      // is not renegotiated rather than producing an offer nobody receives.
      if (!this.trickle) return
      if (this.polite) return this.#askTurn()
      if (this.#lent) {
        this.#offerHeld = true
        return
      }
      void this.#offer()
    }

    pc.onsignalingstatechange = () => {
      if (pc.signalingState === 'stable' && this.#turnOwed) this.#lendTurn()
    }

    pc.onicecandidate = ({ candidate }) => {
      if (candidate && this.trickle) this.#send({ type: 'candidate', candidate: candidate.toJSON() })
    }

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState
      this.#log('state', state)
      this.#emit('state', this.peerId, state)

      // Only failed and closed are terminal. `disconnected` is routinely
      // transient — a few missed consent checks will do it — so it starts the
      // repair clock rather than ending anything.
      if (state === 'failed' || state === 'closed') {
        this.die(state === 'failed' ? 'connection failed' : 'connection closed')
      } else if (state === 'connected') {
        this.#healed()
      } else if (state === 'disconnected' && this.opened) {
        this.#broken()
      }
    }

    pc.oniceconnectionstatechange = () => {
      // Recorded, and only ever used as the start of a clock: this is the
      // legacy aggregate and it reports `checking` indefinitely on
      // connections that are verifiably up, so nothing is decided on it.
      this.#log('ice', pc.iceConnectionState)
      if (this.role === 'answer' && !this.opened && !this.#stallTimer
        && (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed')) {
        this.#stallTimer = setTimeout(() => {
          if (this.dead || this.opened) return
          this.die('path up but no handshake; our answer never reached them')
        }, HANDSHAKE_STALL_MS)
      }
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
      this.opened = true

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
      this.#emit('open', this.peerId, this)
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
      this.#emit('message', this.peerId, parsed, this)
    }
  }

  /** The path went quiet: schedule a restart, and a deadline. */
  #broken() {
    if (!this.#repair || this.#giveUpTimer || this.dead) return
    const { restartAfterMs, giveUpMs } = this.#repair

    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null
      if (this.dead || this.pc.connectionState === 'connected') return
      if (this.polite) {
        this.#log('restart-asked', 'still broken; asking the offering side to restart')
        this.#send({ type: 'restart' })
      } else {
        this.restart('path went quiet')
      }
    }, this.polite ? restartAfterMs * 2 : restartAfterMs)

    this.#giveUpTimer = setTimeout(() => {
      this.#giveUpTimer = null
      if (this.dead || this.pc.connectionState === 'connected') return
      this.die(`no path for ${giveUpMs / 1000}s`)
    }, giveUpMs)
  }

  #healed() {
    if (this.#giveUpTimer) this.#log('healed', `after ${this.restarts} restart(s)`)
    clearTimeout(this.#restartTimer)
    clearTimeout(this.#giveUpTimer)
    this.#restartTimer = null
    this.#giveUpTimer = null
  }

  /**
   * Make an offer and send it. Only ever while the turn is ours: the impolite
   * side whenever it has not lent the turn out, the polite side once it has
   * been given it.
   */
  async #offer() {
    try {
      this.#makingOffer = true
      await this.pc.setLocalDescription()
      this.#send({ type: 'description', description: this.pc.localDescription })
    } catch (err) {
      this.#log('negotiation-failed', err?.message ?? String(err))
    } finally {
      this.#makingOffer = false
    }
  }

  /**
   * Polite: ask the impolite side for a turn to offer, instead of offering.
   *
   * Two offers that cross cannot be untangled in Chromium once their media
   * differ. The one that yields is rolled back, but the media sections it
   * numbered keep their RTP header extension ids, so the other offer, which
   * numbers the same sections differently, is refused ("RTP extension ID
   * reassignment not supported") — and after that neither side can apply the
   * other's offer, the media never flows, and the next track added crashes the
   * page. Offers that never cross need no untangling: the impolite side offers
   * freely, and the polite one only when handed the turn. Asked again if the
   * answer is lost.
   */
  #askTurn() {
    if (this.#turnAsked || this.dead) return
    this.#send({ type: 'turn' })
    this.#turnAsked = setTimeout(() => {
      this.#turnAsked = null
      this.#log('turn-retry', 'no answer to a request for the turn')
      this.#askTurn()
    }, TURN_RETRY_MS)
  }

  /**
   * Impolite: hand the turn over, once nothing of ours is in flight, and hold
   * our own offers until the polite side's offer has been answered. Taken
   * back after a while in case that offer never comes.
   */
  #lendTurn() {
    if (this.pc.signalingState !== 'stable' || this.#makingOffer) {
      this.#turnOwed = true
      return
    }
    this.#turnOwed = false
    clearTimeout(this.#lent)
    this.#lent = setTimeout(() => this.#turnBack('the lent turn was never used'), TURN_LEND_MS)
    this.#send({ type: 'your-turn' })
  }

  #turnBack(why) {
    if (!this.#lent) return
    clearTimeout(this.#lent)
    this.#lent = null
    if (why) this.#log('turn-back', why)
    if (this.#offerHeld && !this.dead) {
      this.#offerHeld = false
      void this.#offer()
    }
  }

  /**
   * Renegotiate the path underneath this connection.
   *
   * Not a reconnection: the connection, its channels and its media survive,
   * and only the candidate pair beneath them is replaced. Throttled, because
   * a restart needs time to land and a second one on top of the first only
   * restarts the restart.
   */
  restart(why) {
    if (this.dead || this.polite) return false
    const now = Date.now()
    if (now - this.#lastRestart < (this.#repair?.restartAfterMs ?? 0)) return false
    this.#lastRestart = now
    this.restarts++
    this.#log('ice-restart', `${why} (restart ${this.restarts})`)
    try {
      this.pc.restartIce()
      return true
    } catch (err) {
      this.#log('ice-restart-failed', err?.message ?? String(err))
      return false
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
      if (msg.type === 'restart') {
        // They think the path is broken. They may be right before we notice,
        // so trust them: an unnecessary restart costs a renegotiation, a
        // missed one costs the connection.
        this.restart('they asked')
        return
      }

      if (msg.type === 'candidate') {
        // Sent the moment it is found, a candidate can overtake the description
        // it belongs to. It waits for it rather than being thrown away.
        if (!this.pc.remoteDescription && !this.#ignoringOffer) {
          this.#pendingCandidates.push(msg.candidate)
          return
        }
        try {
          await this.pc.addIceCandidate(msg.candidate)
        } catch (err) {
          // Expected while an offer is being ignored, and harmless otherwise.
          if (!this.#ignoringOffer) this.#log('candidate-dropped', err?.name ?? 'error')
        }
        return
      }

      if (msg.type === 'turn') {
        if (!this.polite) this.#lendTurn()
        return
      }

      if (msg.type === 'your-turn') {
        if (!this.polite) return
        clearTimeout(this.#turnAsked)
        this.#turnAsked = null
        // Offered even if nothing is left to negotiate: the impolite side is
        // holding its own offers until ours is answered.
        await this.#offer()
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
        // The offer the turn was lent for is answered: the turn is ours again.
        if (!this.polite) this.#turnBack()
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
    clearTimeout(this.#turnAsked)
    clearTimeout(this.#lent)
    clearTimeout(this.#restartTimer)
    clearTimeout(this.#giveUpTimer)
    clearTimeout(this.#stallTimer)
    this.dead = true
    this.open = false
    this.#log('dead', why)
    try { this.channel?.close() } catch { /* already gone */ }
    try { this.pc.close() } catch { /* already gone */ }
    this.#emit('dead', this.peerId, why, this)
  }
}
