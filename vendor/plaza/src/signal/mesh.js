/**
 * A room of peers, presenting the same surface the vendored transport does.
 *
 * Deliberately the same shape so the two can be swapped at runtime and
 * compared against identical application code — the only way to answer "is it
 * the transport or is it us" without a night of theorising.
 *
 * What is intentionally absent, because every failure investigated so far
 * lived in one of them:
 *
 *   - no pool of pre-warmed connections whose offers age before use;
 *   - no connection shared between rooms behind a proxy object, and therefore
 *     no peer being "replaced" and reported as having left while it is still
 *     there;
 *   - no second connection racing the first, because exactly one side opens
 *     the channel;
 *   - no signalling failure that is fatal. The connection state machine
 *     decides what is terminal.
 *
 * Discovery is announce-and-answer. Everyone announces on the room topic on a
 * short interval. Whoever hears an unfamiliar peer answers privately to that
 * peer's own topic, so a newcomer learns about everyone already present within
 * one round trip rather than waiting out an announce cycle. The lower id then
 * opens the connection.
 */
import { Rendezvous, topicOf } from './rendezvous.js'
import { TrackerSwarm, infoHashFor, DEFAULT_TRACKERS } from './tracker.js'
import { roomKey, seal, open } from './secret.js'
import { Link } from './link.js'

const ANNOUNCE_MS = 4000
const ANNOUNCE_WARMUP_MS = [200, 600, 1500]
const PING_TIMEOUT_MS = 5000

/**
 * How hard to chase a peer we know exists but have not connected to.
 *
 * Announcing on a fixed cadence and hoping is what both implementations did,
 * and it has a deadlock in it: discovery is not symmetric. If our announce
 * reaches them but theirs never reaches us — a dropped relay message, a
 * subscription that missed the window, a relay that went away mid-round —
 * then the side that should open the connection never learns there is anyone
 * to open it to, and the side that knows waits forever. Neither is retrying,
 * because neither believes anything is wrong.
 *
 * So a link that has not opened is chased directly, on a widening interval,
 * and rebuilt from scratch if chasing does not work. The escalation matters
 * as much as the retry: re-sending the same announce over the same relay that
 * already lost it is not a strategy.
 */
const CHASE_MS = [1000, 2000, 4000, 6000, 8000]
const REBUILD_AFTER_CHASES = 5

/**
 * How long an unanswered offer stays usable, and how many may wait at once.
 *
 * A tracker forwards offers on its own schedule; two minutes is far longer
 * than any of them takes, so an answer always finds its connection alive.
 */
const OFFER_TTL_MS = 120000
const MAX_PENDING_OFFERS = 12

/**
 * This page's identity, one per load, matching the vendored transport's shape.
 *
 * Deliberately global: a page is one peer, and two rooms open at once are the
 * same person in both. It can be overridden per room, which exists so tests
 * can put two peers in one process — without that, two rooms in one process
 * share an id and each dismisses the other's messages as its own echo.
 */
/**
 * An opaque id labelling an offer before its recipient exists.
 *
 * Twenty characters, because that is what the tracker protocol wants — the
 * same width as a peer id. A shorter one is refused with "Invalid request",
 * which names nothing and is indistinguishable from every other rejection.
 */
const randomId = () => [...crypto.getRandomValues(new Uint8Array(20))]
  .map((b) => (b % 36).toString(36)).join('')

export const selfId = [...crypto.getRandomValues(new Uint8Array(10))]
  .map((b) => b.toString(36).padStart(2, '0'))
  .join('')
  .slice(0, 20)

export const DEFAULT_RELAYS = [
  'wss://nostr.data.haus',
  'wss://nostr.vulpem.com',
  'wss://relay.mostr.pub',
  'wss://nos.lol',
  'wss://relay.damus.io',
]

export function joinRoom(
  {
    appId, password, rtcConfig, relayUrls, makeRendezvous, selfId: idOverride,
    chaseSchedule = CHASE_MS, rebuildAfter = REBUILD_AFTER_CHASES,
    discovery = 'relay', trackerUrls,
  } = {},
  roomId,
) {
  if (!appId) throw new Error('plaza/signal: appId is required')
  if (!roomId) throw new Error('plaza/signal: roomId is required')

  const id = idOverride ?? selfId

  const listeners = { onPeerJoin: null, onPeerLeave: null, onPeerStream: null }
  const links = new Map()      // peerId -> Link
  const actions = new Map()    // name -> {onMessage}
  const published = new Map()  // stream -> metadata
  const pings = new Map()      // peerId -> [{resolve, reject}]
  const log = []

  let left = false
  let key = null
  let rendezvous = null
  let roomTopic = null
  let selfTopic = null
  let announceTimer = null
  let announceCount = 0

  const note = (peerId, what, detail) => {
    const entry = { at: Date.now(), peer: peerId?.slice(0, 6) ?? '-', what, detail }
    log.push(entry)
    if (log.length > 300) log.shift()
  }

  // ------------------------------------------------------------- signalling

  /**
   * Get a signal to a peer by the best path available.
   *
   * An open data channel beats any rendezvous: it is direct, ordered, and
   * needs no third party. The rendezvous is only for reaching someone we
   * cannot yet talk to — which, once connected, is nobody.
   */
  const signalTo = (peerId, msg) => {
    const link = links.get(peerId)
    if (link?.open) {
      link.send({ __plaza: 'signal', msg })
      return
    }
    void sendTo(peerId, msg)
  }

  const sendTo = async (peerId, msg) => {
    // Tracker discovery has no channel to a specific peer: the introduction is
    // the whole conversation. Nothing here has anywhere to go.
    if (left || !key || !rendezvous) return
    const topic = await topicOf(`plaza/${appId}/${roomId}/${peerId}`)
    const sealed = await seal(key, { from: id, ...msg })
    await rendezvous.publish(topic, sealed)
  }

  const chases = new Map() // peerId -> {timer, attempts, rebuilds}

  /** Stop chasing a peer, whether because it connected or because it left. */
  const stopChasing = (peerId) => {
    const chase = chases.get(peerId)
    if (chase) clearTimeout(chase.timer)
    chases.delete(peerId)
  }

  /**
   * Keep telling a peer we are here until the connection opens.
   *
   * Sent to their own topic rather than the room's: a direct message is the
   * one thing that can rescue the asymmetric case, where they never heard our
   * broadcast. Marked as a chase so it cannot ping-pong — a chase is answered
   * by connecting, not by chasing back.
   */
  const chase = (peerId) => {
    if (left || chases.has(peerId)) return
    const state = { timer: null, attempts: 0, rebuilds: 0 }
    chases.set(peerId, state)

    const tick = () => {
      if (left || !chases.has(peerId)) return
      const link = links.get(peerId)

      if (link && link.open) { stopChasing(peerId); return }

      state.attempts++
      const delay = chaseSchedule[Math.min(state.attempts - 1, chaseSchedule.length - 1)]

      if (state.attempts > rebuildAfter) {
        // Chasing has not worked. The connection itself may be the problem —
        // a half-open handshake, candidates that went nowhere — so throw it
        // away and build a fresh one rather than nursing it. Announce first,
        // so they are ready for the new offer.
        state.attempts = 0
        state.rebuilds++
        note(peerId, 'rebuilding', `no connection after ${rebuildAfter} attempts (rebuild ${state.rebuilds})`)
        link?.die('rebuilding after failed discovery')
        links.delete(peerId)
        void sendTo(peerId, { type: 'announce', chase: true })
        linkFor(peerId)
      } else {
        note(peerId, 'chasing', `attempt ${state.attempts}, still ${link ? link.pc.connectionState : 'no link'}`)
        void sendTo(peerId, { type: 'announce', chase: true })
      }

      state.timer = setTimeout(tick, delay)
    }

    state.timer = setTimeout(tick, chaseSchedule[0])
  }

  const linkFor = (peerId) => {
    const existing = links.get(peerId)
    if (existing && !existing.dead) return existing

    const link = new Link({
      selfId: id,
      peerId,
      rtcConfig,
      send: (msg) => signalTo(peerId, msg),
      log: (what, detail) => note(peerId, what, detail),
      emit: (event, ...args) => handleLinkEvent(event, ...args),
    })

    links.set(peerId, link)
    note(peerId, 'link-created', link.polite ? 'polite (waits for offer)' : 'impolite (opens channel)')
    chase(peerId)
    return link
  }

  const handleLinkEvent = (event, peerId, ...rest) => {
    if (event === 'open') {
      stopChasing(peerId)
      note(peerId, 'connected')
      // Anything already being shared goes to the newcomer immediately.
      const link = links.get(peerId)
      if (link) {
        for (const [stream, metadata] of published) {
          link.addStream(stream)
          link.send({ __plaza: 'stream-meta', metadata })
        }
      }
      listeners.onPeerJoin?.(peerId)
      return
    }

    if (event === 'dead') {
      const why = rest[0]
      const link = links.get(peerId)
      const wasOpen = link?.open
      // A rebuild kills the old link deliberately; that is not a departure and
      // must not be reported as one.
      if (why === 'rebuilding after failed discovery') return
      links.delete(peerId)
      // Reject anything waiting on this peer rather than leaving it hanging.
      for (const waiter of pings.get(peerId) ?? []) waiter.reject(new Error(why))
      pings.delete(peerId)
      note(peerId, 'gone', why)
      if (wasOpen) listeners.onPeerLeave?.(peerId, new Error(why))
      return
    }

    if (event === 'track') {
      const [track, stream] = rest
      const link = links.get(peerId)
      const metadata = link?.__pendingMeta ?? undefined
      listeners.onPeerStream?.(stream, peerId, metadata)
      return
    }

    if (event === 'message') {
      const [data] = rest
      handleMessage(peerId, data)
    }
  }

  const handleMessage = (peerId, data) => {
    if (data?.__plaza === 'ping') {
      links.get(peerId)?.send({ __plaza: 'pong', id: data.id })
      return
    }
    if (data?.__plaza === 'pong') {
      const waiter = pings.get(peerId)?.shift()
      waiter?.resolve()
      return
    }
    if (data?.__plaza === 'signal') {
      void links.get(peerId)?.accept(data.msg)
      return
    }
    if (data?.__plaza === 'stream-meta') {
      // Metadata arrives beside the tracks, not inside them; hold it so the
      // next ontrack can be labelled.
      const link = links.get(peerId)
      if (link) link.__pendingMeta = data.metadata
      return
    }
    if (data?.__plaza === 'leaving') {
      const link = links.get(peerId)
      links.delete(peerId)
      note(peerId, 'said-goodbye')
      if (link?.open) listeners.onPeerLeave?.(peerId, new Error('peer left room'))
      link?.die('peer left room')
      return
    }
    if (typeof data?.a === 'string') {
      actions.get(data.a)?.onMessage?.(data.d, { peerId })
    }
  }

  const receive = async (raw) => {
    if (left) return
    const msg = await open(key, raw)
    // Not ours: another room sharing this topic hash, or a different password.
    if (!msg || typeof msg.from !== 'string' || msg.from === id) return

    if (msg.type === 'announce') {
      const known = links.get(msg.from)
      if (!known || known.dead) {
        const how = msg.chase ? 'they chased us' : msg.direct ? 'answered our announce' : 'announced'
        note(msg.from, 'discovered', how)
        linkFor(msg.from)
      } else if (msg.chase && !known.open && !known.polite) {
        // They are still waiting on us and we are the side that opens. Our
        // offer evidently never landed, so make another.
        if (known.resendOffer()) {
          note(msg.from, 'reoffering', 'they chased us while our offer was outstanding')
        }
      }

      // Answer privately so a newcomer does not wait out an announce cycle.
      // Only to a broadcast: answering a direct message, or a chase, would
      // have two peers replying to each other forever.
      if (!msg.direct && !msg.chase) void sendTo(msg.from, { type: 'announce', direct: true })
      return
    }

    if (msg.type === 'description' || msg.type === 'candidate') {
      await linkFor(msg.from).accept(msg)
    }
  }

  // -------------------------------------------------------------- lifecycle

  const announce = async () => {
    if (left) return
    const sealed = await seal(key, { from: id, type: 'announce' })
    await rendezvous.publish(roomTopic, sealed)

    // Frequent at first so a join feels immediate, then settling to a rate
    // that keeps a room discoverable without being chatty.
    const warmup = ANNOUNCE_WARMUP_MS[announceCount]
    announceCount++
    announceTimer = setTimeout(announce, warmup ?? ANNOUNCE_MS)
  }

  // ------------------------------------------------------------- trackers

  const offered = new Map() // offerId -> Link awaiting an answer
  let swarm = null

  /**
   * Make offers before knowing who they are for.
   *
   * A tracker introduces peers by handing out offers, so they have to exist
   * first. This is the one place a pool of pending connections is genuinely
   * required rather than inherited.
   *
   * Offers outlive the announce that published them. They used to be
   * discarded as each new announce went out, which raced the tracker: an
   * offer is held and forwarded on the tracker's schedule, not ours, so a
   * peer would receive one, answer it faithfully, and find the connection
   * behind it already destroyed. Both sides then spent ten seconds failing
   * to reach a socket that had been closed before the answer was written.
   * They now expire on their own clock, comfortably longer than any tracker
   * takes to make an introduction.
   */
  const makeOffers = async (n) => {
    if (left) return []

    const now = Date.now()
    for (const [offerId, entry] of offered) {
      if (now - entry.at < OFFER_TTL_MS) continue
      entry.link.die('offer expired unanswered')
      offered.delete(offerId)
    }

    // Top up to a target rather than minting a fresh batch every time.
    //
    // Announcing every twenty seconds while offers live for two minutes means
    // a fixed batch per announce accumulates far past any sensible bound, and
    // capping it just makes the cap fight the lifetime: offers were being
    // destroyed seconds after publication purely to make room for their
    // replacements, which is the very race the lifetime was added to stop.
    // Unanswered offers are still perfectly good, so they are re-announced
    // rather than replaced.
    const reusable = [...offered.entries()].map(([offerId, entry]) => ({
      offerId, sdp: entry.sdp,
    }))
    const wanted = Math.max(0, Math.min(n, MAX_PENDING_OFFERS - reusable.length))

    const made = []
    for (let i = 0; i < wanted; i++) {
      const offerId = randomId()
      const link = new Link({
        selfId: id,
        role: 'offer',
        trickle: false,
        rtcConfig,
        send: (msg) => { if (link.peerId) signalTo(link.peerId, msg) },
        log: (what, detail) => note(offerId, what, detail),
        emit: (event, ...args) => handleLinkEvent(event, ...args),
      })
      try {
        const sdp = await link.completeOffer()
        if (!sdp) { link.die('no offer produced'); continue }
        offered.set(offerId, { link, at: Date.now(), sdp })
        made.push({ offerId, sdp })
      } catch (err) {
        note('-', 'offer-failed', err?.message ?? String(err))
        link.die('offer failed')
      }
    }
    // Everything still outstanding goes out again alongside the new ones, so
    // a tracker that introduces someone late still has something to hand over.
    const publishing = [...reusable, ...made]
    note('-', 'offers-published',
      `${publishing.length} for the swarm (${made.length} new, ${reusable.length} still open)`)
    return publishing
  }

  const answerOffer = async ({ peerId, offerId, sdp }) => {
    if (left) return null
    const existing = links.get(peerId)
    if (existing && !existing.dead) {
      note(peerId, 'offer-skipped', 'already connecting or connected')
      return null
    }

    const link = new Link({
      selfId: id,
      peerId,
      role: 'answer',
      trickle: false,
      rtcConfig,
      send: (msg) => signalTo(peerId, msg),
      log: (what, detail) => note(peerId, what, detail),
      emit: (event, ...args) => handleLinkEvent(event, ...args),
    })
    links.set(peerId, link)
    note(peerId, 'answering', `offer ${offerId.slice(0, 6)} from the swarm`)

    try {
      return await link.completeAnswer(sdp)
    } catch (err) {
      note(peerId, 'answer-failed', err?.message ?? String(err))
      link.die('answer failed')
      links.delete(peerId)
      return null
    }
  }

  const takeAnswer = ({ peerId, offerId, sdp }) => {
    const entry = offered.get(offerId)
    if (!entry) {
      note(peerId, 'answer-unmatched', `offer ${offerId.slice(0, 6)} is no longer held`)
      return
    }
    const link = entry.link
    offered.delete(offerId)

    const existing = links.get(peerId)
    if (existing && !existing.dead) {
      // Two of our offers were answered by the same peer, or they answered
      // while we were already answering theirs. One connection each.
      link.die('duplicate introduction')
      return
    }

    link.identify(peerId)
    links.set(peerId, link)
    note(peerId, 'answered', `our offer ${offerId.slice(0, 6)}`)
    void link.applyAnswer(sdp)
  }

  const ready = (async () => {
    key = await roomKey({ appId, roomId, password })
    roomTopic = await topicOf(`plaza/${appId}/${roomId}`)
    selfTopic = await topicOf(`plaza/${appId}/${roomId}/${id}`)
    if (left) return

    // Injectable so discovery can be tested against a relay that loses
    // traffic in one direction — the failure the chase exists for, and one
    // that cannot be provoked reliably against real relays.
    if (discovery !== 'tracker') {
      rendezvous = makeRendezvous
        ? makeRendezvous({ log: (what, detail) => note('-', what, detail) })
        : new Rendezvous(relayUrls ?? DEFAULT_RELAYS, {
          log: (what, detail) => note('-', what, detail),
        })
    }
    if (discovery === 'tracker') {
      // No relay topics and no announce loop: the swarm carries introductions
      // itself, and the offers are the announcement.
      swarm = new TrackerSwarm(trackerUrls ?? DEFAULT_TRACKERS, {
        infoHash: await infoHashFor(`plaza/${appId}/${roomId}`),
        peerId: id.padEnd(20, '0').slice(0, 20),
        log: (what, detail) => note('-', what, detail),
      })
      swarm.onOffersNeeded = makeOffers
      swarm.onOffer = answerOffer
      swarm.onAnswer = takeAnswer
      note('-', 'joined', `swarm via ${(trackerUrls ?? DEFAULT_TRACKERS).length} trackers`)
      return
    }

    rendezvous.listen(roomTopic, receive)
    rendezvous.listen(selfTopic, receive)
    note('-', 'joined', `room topic ${roomTopic.slice(0, 8)}`)
    void announce()
  })()

  const broadcast = (data, target) => {
    const targets = target
      ? [links.get(target)].filter(Boolean)
      : [...links.values()]
    for (const link of targets) link.send(data)
  }

  return {
    __plazaSignal: 'own',
    selfId: id,
    ready,
    log,

    makeAction(name) {
      const action = {
        onMessage: null,
        send: async (data, options) => {
          broadcast({ a: name, d: data }, options?.target)
        },
      }
      actions.set(name, action)
      return action
    },

    getPeers: () => Object.fromEntries(
      [...links.entries()].filter(([, l]) => !l.dead).map(([id, l]) => [id, l.pc]),
    ),

    addStream(stream, options = {}) {
      const { metadata, target } = options
      if (!target) published.set(stream, metadata)
      const targets = target ? [links.get(target)].filter(Boolean) : [...links.values()]
      for (const link of targets) {
        link.addStream(stream)
        link.send({ __plaza: 'stream-meta', metadata })
      }
    },

    removeStream(stream) {
      published.delete(stream)
      for (const link of links.values()) link.removeStream(stream)
    },

    addTrack(track, stream) {
      for (const link of links.values()) {
        try { link.pc.addTrack(track, stream) } catch { /* duplicate */ }
      }
    },

    removeTrack(track) {
      for (const link of links.values()) {
        const sender = link.pc.getSenders().find((s) => s.track === track)
        if (sender) { try { link.pc.removeTrack(sender) } catch { /* gone */ } }
      }
    },

    replaceTrack(oldTrack, newTrack) {
      return Promise.all([...links.values()].map((l) => l.replaceTrack(oldTrack, newTrack)))
    },

    async ping(peerId) {
      const link = links.get(peerId)
      if (!link || !link.open) throw new Error(`no active peer with id ${peerId}`)

      const started = Date.now()
      const id = Math.random().toString(36).slice(2)
      await new Promise((resolve, reject) => {
        const queue = pings.get(peerId) ?? []
        queue.push({ resolve, reject })
        pings.set(peerId, queue)
        link.send({ __plaza: 'ping', id })
        setTimeout(() => reject(new Error('ping timed out')), PING_TIMEOUT_MS)
      })
      return Date.now() - started
    },

    async leave() {
      if (left) return
      left = true
      clearTimeout(announceTimer)

      // Say goodbye before tearing down, so peers show a departure rather than
      // waiting for a timeout to call it a failure.
      broadcast({ __plaza: 'leaving' })
      await new Promise((r) => setTimeout(r, 60))

      for (const peerId of [...chases.keys()]) stopChasing(peerId)
      for (const link of links.values()) link.die('room left')
      for (const entry of offered.values()) entry.link.die('room left')
      links.clear()
      offered.clear()
      published.clear()
      rendezvous?.close()
      swarm?.close()
    },

    get onPeerJoin() { return listeners.onPeerJoin },
    set onPeerJoin(fn) { listeners.onPeerJoin = fn },
    get onPeerLeave() { return listeners.onPeerLeave },
    set onPeerLeave(fn) { listeners.onPeerLeave = fn },
    get onPeerStream() { return listeners.onPeerStream },
    set onPeerStream(fn) { listeners.onPeerStream = fn },
  }
}
