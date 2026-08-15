/**
 * Finding each other through BitTorrent trackers.
 *
 * A tracker is not a message bus, which is what makes it interesting here. It
 * is a matchmaker: you join a swarm carrying a handful of ready-made offers,
 * the tracker hands those to peers already in the swarm, and it relays their
 * answers back to you. The introduction is the tracker's job rather than
 * something built on top of a general pub/sub — and every discovery bug found
 * in this project so far lived in exactly that "built on top" layer.
 *
 * Two consequences worth being explicit about, because they shape the code
 * that uses this:
 *
 *   - Offers must exist before their recipient does. There is nowhere to send
 *     a message to a specific peer before the tracker has introduced you, so
 *     offers are made speculatively and handed over unaddressed. This is why
 *     a small pool of pending offers is unavoidable here — not an accident of
 *     someone's design, but the protocol's actual shape.
 *
 *   - There is no channel for trickled candidates. An offer has to carry every
 *     candidate it will ever have, which means waiting for gathering to finish
 *     before announcing. That costs a second or two at setup and removes an
 *     entire class of failure in exchange: no candidate arriving after the
 *     description it belongs to, no ufrag moving underneath one in flight, no
 *     duplicate delivered by a second path.
 *
 * Nothing here touches WebRTC. It speaks the tracker protocol and calls back.
 */

const RECONNECT_MS = 4000
const MAX_BACKOFF_MS = 60000
const ANNOUNCE_MS = 20000
const OFFERS_PER_ANNOUNCE = 3

/** Trackers that answered a full offer/answer round trip when last measured. */
export const DEFAULT_TRACKERS = [
  'wss://open.ftorrent.com',
  'wss://tracker.webtorrent.dev',
  'wss://tracker.openwebtorrent.com',
]

/** Trackers key swarms by a 20-character info hash. */
export async function infoHashFor(text) {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 20)
}

export class TrackerSwarm {
  /** Asked for `n` offers to publish. Must resolve to [{offerId, sdp}]. */
  onOffersNeeded = async () => []

  /** Someone offered us a connection. Must resolve to an answer SDP, or null. */
  onOffer = async () => null

  /** Someone answered one of our offers. */
  onAnswer = () => {}

  #urls
  #sockets = new Map()
  #infoHash
  #peerId
  #log
  #closed = false
  #announceTimer = null
  #handled = new Set()
  #lastSent = 'nothing yet'

  constructor(urls, { infoHash, peerId, log = () => {} }) {
    this.#urls = urls
    this.#infoHash = infoHash
    this.#peerId = peerId
    this.#log = log
    for (const url of urls) this.#connect(url)
    this.#announceTimer = setInterval(() => void this.announce(), ANNOUNCE_MS)
  }

  #connect(url, attempt = 0) {
    if (this.#closed) return

    let ws
    try {
      ws = new WebSocket(url)
    } catch (err) {
      this.#retry(url, attempt, err?.message ?? 'construct failed')
      return
    }
    this.#sockets.set(url, ws)

    ws.onopen = () => {
      this.#log('tracker-open', url)
      void this.announce(ws)
    }
    ws.onclose = () => {
      if (this.#sockets.get(url) === ws) this.#sockets.delete(url)
      this.#retry(url, attempt, 'closed')
    }
    ws.onerror = () => { /* onclose follows */ }
    ws.onmessage = (event) => void this.#receive(url, ws, event.data)
  }

  #retry(url, attempt, why) {
    if (this.#closed) return
    const delay = Math.min(RECONNECT_MS * 2 ** attempt, MAX_BACKOFF_MS)
    this.#log('tracker-retry', `${url} (${why}) in ${delay}ms`)
    setTimeout(() => this.#connect(url, attempt + 1), delay)
  }

  async #receive(url, ws, raw) {
    let msg
    try { msg = JSON.parse(raw) } catch { return }

    if (msg['failure reason']) {
      // Include what we sent. A refusal with no context is unactionable, and
      // trackers describe every rejection the same unhelpful way.
      this.#log('tracker-refused', `${url}: ${msg['failure reason']} — sent ${this.#lastSent}`)
      return
    }

    // Every tracker we are on introduces us to the same peers, so the same
    // offer arrives repeatedly. Answering it more than once would build a
    // second connection to somebody we are already connecting to.
    if (msg.offer_id) {
      if (this.#handled.has(msg.offer_id)) return
      this.#handled.add(msg.offer_id)
      if (this.#handled.size > 500) this.#handled.delete(this.#handled.values().next().value)
    }

    if (msg.offer && msg.peer_id && msg.offer_id) {
      this.#log('tracker-offer', `from ${msg.peer_id.slice(0, 6)} via ${url}`)
      const answer = await this.onOffer({
        peerId: msg.peer_id, offerId: msg.offer_id, sdp: msg.offer.sdp,
      })
      if (!answer || this.#closed) return
      this.#send(ws, {
        to_peer_id: msg.peer_id,
        offer_id: msg.offer_id,
        answer: { type: 'answer', sdp: answer },
      })
      return
    }

    if (msg.answer && msg.peer_id && msg.offer_id) {
      this.#log('tracker-answer', `from ${msg.peer_id.slice(0, 6)} via ${url}`)
      this.onAnswer({ peerId: msg.peer_id, offerId: msg.offer_id, sdp: msg.answer.sdp })
    }
  }

  #send(ws, payload) {
    if (ws?.readyState !== 1) return
    try {
      const body = JSON.stringify({
        action: 'announce',
        info_hash: this.#infoHash,
        peer_id: this.#peerId,
        uploaded: 0,
        downloaded: 0,
        left: 0,
        ...payload,
      })
      this.#lastSent = `${body.length}B ${Object.keys(payload).join(',')}` +
        (payload.offers ? ` offers=${payload.offers.length}` : '') +
        ` hash=${this.#infoHash.length}ch peer=${this.#peerId.length}ch`
      ws.send(body)
    } catch { /* the socket is going away */ }
  }

  /**
   * Join the swarm, carrying offers.
   *
   * The offers are what makes this an introduction rather than a headcount:
   * a peer already in the swarm receives one and can answer it immediately.
   * Announcing without any would tell the tracker we are here and give it
   * nothing to hand out.
   */
  async announce(only = null) {
    if (this.#closed) return
    const sockets = only ? [only] : [...this.#sockets.values()].filter((ws) => ws.readyState === 1)
    if (sockets.length === 0) return

    // Every caller fires this without awaiting, so a rejection here would be
    // discarded and the swarm would sit there having silently never announced.
    let offers
    try {
      offers = await this.onOffersNeeded(OFFERS_PER_ANNOUNCE)
    } catch (err) {
      this.#log('offers-failed', err?.message ?? String(err))
      return
    }
    if (this.#closed) return

    for (const ws of sockets) {
      this.#send(ws, {
        numwant: OFFERS_PER_ANNOUNCE,
        offers: offers.map(({ offerId, sdp }) => ({
          offer_id: offerId,
          offer: { type: 'offer', sdp },
        })),
      })
    }
  }

  get liveCount() {
    let n = 0
    for (const ws of this.#sockets.values()) if (ws.readyState === 1) n++
    return n
  }

  close() {
    this.#closed = true
    clearInterval(this.#announceTimer)
    for (const ws of this.#sockets.values()) {
      try { ws.close() } catch { /* already gone */ }
    }
    this.#sockets.clear()
  }
}
