/**
 * Finding each other over public Nostr relays.
 *
 * This is the part of a serverless P2P stack that people expect to be the hard
 * part, and it is not. Relays are dumb pipes: you open a websocket, subscribe
 * to a topic, publish to a topic. Measured against the five relays this app is
 * assigned, every signalling-sized message was delivered, so nothing here is
 * trying to be clever about redundancy — it publishes to all of them and lets
 * duplicates be deduplicated at the other end, which costs a few hundred bytes
 * and removes an entire class of "the one relay we picked was slow".
 *
 * Event construction and signing live in ./nostr.js. Only the signature
 * primitive itself is borrowed — BIP-340 Schnorr, which browsers do not
 * provide — because reimplementing cryptography to avoid a dependency is a
 * bad trade at any size.
 */
import { createEvent, subscriptionFor } from './nostr.js'

const RECONNECT_MS = 3000
const MAX_BACKOFF_MS = 30000

/** Hex SHA-1 of a string, matching the topic derivation relays are keyed on. */
export async function topicOf(text) {
  const bytes = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-1', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * A set of relay connections, presented as one subscribe/publish surface.
 *
 * Every relay gets every subscription and every publish. A relay that is down,
 * slow, or rejecting simply contributes nothing; nothing waits on it.
 */
export class Rendezvous {
  #urls
  #sockets = new Map()
  #topics = new Map() // topic -> handler
  #seen = new Set()
  #seenOrder = []
  #closed = false
  #log

  constructor(urls, { log = () => {} } = {}) {
    this.#urls = urls
    this.#log = log
    for (const url of urls) this.#connect(url)
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
      this.#log('relay-open', url)
      // Re-subscribe on every open, including reconnects: a relay that
      // dropped remembers nothing about us.
      for (const topic of this.#topics.keys()) this.#send(ws, subscriptionFor(subIdFor(topic), topic))
    }

    ws.onclose = () => {
      if (this.#sockets.get(url) === ws) this.#sockets.delete(url)
      this.#retry(url, attempt, 'closed')
    }

    ws.onerror = () => { /* onclose follows; nothing useful to add here */ }

    ws.onmessage = (event) => {
      let parsed
      try { parsed = JSON.parse(event.data) } catch { return }
      const [kind, , payload] = parsed
      if (kind !== 'EVENT' || !payload?.content) return

      // The same message arrives once per relay by design. Ignore repeats by
      // event id, which is a hash of the content, so duplicates across relays
      // collapse without any coordination between them.
      if (this.#seen.has(payload.id)) return
      this.#remember(payload.id)

      const tag = (payload.tags ?? []).find((t) => t[0] === 'x')
      const handler = tag?.[1] ? this.#topics.get(tag[1]) : null
      handler?.(payload.content)
    }
  }

  #retry(url, attempt, why) {
    if (this.#closed) return
    const delay = Math.min(RECONNECT_MS * 2 ** attempt, MAX_BACKOFF_MS)
    this.#log('relay-retry', `${url} (${why}) in ${delay}ms`)
    setTimeout(() => this.#connect(url, attempt + 1), delay)
  }

  #remember(id) {
    this.#seen.add(id)
    this.#seenOrder.push(id)
    if (this.#seenOrder.length > 2000) this.#seen.delete(this.#seenOrder.shift())
  }

  #send(ws, data) {
    if (ws?.readyState === 1) {
      try { ws.send(data) } catch { /* the socket is going away */ }
    }
  }

  /** Listen on a topic. Applied to every relay, now and on reconnect. */
  listen(topic, handler) {
    this.#topics.set(topic, handler)
    const request = subscriptionFor(subIdFor(topic), topic)
    for (const ws of this.#sockets.values()) this.#send(ws, request)
  }

  /** Publish to a topic on every relay. Best effort by design. */
  async publish(topic, content) {
    if (this.#closed) return
    let event
    try {
      event = await createEvent(topic, content)
    } catch (err) {
      this.#log('publish-failed', err?.message ?? String(err))
      return
    }
    for (const ws of this.#sockets.values()) this.#send(ws, event)
  }

  /** How many relays are currently usable, for diagnostics. */
  get liveCount() {
    let n = 0
    for (const ws of this.#sockets.values()) if (ws.readyState === 1) n++
    return n
  }

  close() {
    this.#closed = true
    for (const ws of this.#sockets.values()) {
      try { ws.close() } catch { /* already gone */ }
    }
    this.#sockets.clear()
    this.#topics.clear()
  }
}

/**
 * A stable subscription id per topic.
 *
 * Relays key subscriptions by this string, so deriving it from the topic means
 * a reconnect replaces its own subscription rather than accumulating a new one
 * beside the old.
 */
function subIdFor(topic) {
  return 'plz' + topic.slice(0, 24)
}
