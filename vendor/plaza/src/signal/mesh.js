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
import { roomKey, seal, open } from './secret.js'
import { Link } from './link.js'

const ANNOUNCE_MS = 4000
const ANNOUNCE_WARMUP_MS = [200, 600, 1500]
const PING_TIMEOUT_MS = 5000

/** A room-scoped random identity, matching the vendored transport's shape. */
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

export function joinRoom({ appId, password, rtcConfig, relayUrls } = {}, roomId) {
  if (!appId) throw new Error('plaza/signal: appId is required')
  if (!roomId) throw new Error('plaza/signal: roomId is required')

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

  const sendTo = async (peerId, msg) => {
    if (left || !key) return
    const topic = await topicOf(`plaza/${appId}/${roomId}/${peerId}`)
    const sealed = await seal(key, { from: selfId, ...msg })
    await rendezvous.publish(topic, sealed)
  }

  const linkFor = (peerId) => {
    const existing = links.get(peerId)
    if (existing && !existing.dead) return existing

    const link = new Link({
      selfId,
      peerId,
      rtcConfig,
      send: (msg) => void sendTo(peerId, msg),
      log: (what, detail) => note(peerId, what, detail),
      emit: (event, ...args) => handleLinkEvent(event, ...args),
    })

    links.set(peerId, link)
    note(peerId, 'link-created', link.polite ? 'polite (waits for offer)' : 'impolite (opens channel)')
    return link
  }

  const handleLinkEvent = (event, peerId, ...rest) => {
    if (event === 'open') {
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
    if (!msg || typeof msg.from !== 'string' || msg.from === selfId) return

    if (msg.type === 'announce') {
      const known = links.get(msg.from)
      if (!known || known.dead) {
        note(msg.from, 'discovered', msg.direct ? 'answered our announce' : 'announced')
        linkFor(msg.from)
      }
      // Answer privately so a newcomer does not wait out an announce cycle.
      // Only in response to a broadcast, or two peers answer each other
      // forever.
      if (!msg.direct) void sendTo(msg.from, { type: 'announce', direct: true })
      return
    }

    if (msg.type === 'description' || msg.type === 'candidate') {
      await linkFor(msg.from).accept(msg)
    }
  }

  // -------------------------------------------------------------- lifecycle

  const announce = async () => {
    if (left) return
    const sealed = await seal(key, { from: selfId, type: 'announce' })
    await rendezvous.publish(roomTopic, sealed)

    // Frequent at first so a join feels immediate, then settling to a rate
    // that keeps a room discoverable without being chatty.
    const warmup = ANNOUNCE_WARMUP_MS[announceCount]
    announceCount++
    announceTimer = setTimeout(announce, warmup ?? ANNOUNCE_MS)
  }

  const ready = (async () => {
    key = await roomKey({ appId, roomId, password })
    roomTopic = await topicOf(`plaza/${appId}/${roomId}`)
    selfTopic = await topicOf(`plaza/${appId}/${roomId}/${selfId}`)
    if (left) return

    rendezvous = new Rendezvous(relayUrls ?? DEFAULT_RELAYS, {
      log: (what, detail) => note('-', what, detail),
    })
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

      for (const link of links.values()) link.die('room left')
      links.clear()
      published.clear()
      rendezvous?.close()
    },

    get onPeerJoin() { return listeners.onPeerJoin },
    set onPeerJoin(fn) { listeners.onPeerJoin = fn },
    get onPeerLeave() { return listeners.onPeerLeave },
    set onPeerLeave(fn) { listeners.onPeerLeave = fn },
    get onPeerStream() { return listeners.onPeerStream },
    set onPeerStream(fn) { listeners.onPeerStream = fn },
  }
}
