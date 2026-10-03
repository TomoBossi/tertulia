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
import { Link, DEFAULT_REPAIR } from './link.js'
import { describe, summarize } from './candidates.js'

/**
 * Two connections to the same peer, and which one survives.
 *
 * Both peers look for each other at once — at join, and again after a drop —
 * so a tracker routinely introduces them in both directions. Choosing between
 * the two before either works needs both sides to see both, and they do not:
 * a tracker answer goes missing, and each side ends up keeping a connection
 * whose other half the other side already threw away. Caught exactly that way
 * in a real two-browser run, twice, by two successively cleverer rules.
 *
 * So nothing is chosen in advance. Both are kept — at most one in each
 * direction — and whichever opens first wins. Opening is a fact both ends
 * share, because it is the same connection; the loser is dropped then. Only
 * when both have opened does a rule decide, and by then both sides can see
 * both: the connection offered by the lower id wins.
 */
const outranks = (offererA, offererB) => offererA < offererB

/** How long a connection that lost the race may still open and be weighed. */
const RACE_GRACE_MS = 1500

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

/** How often to announce while a dropped peer is being sought. */
const SEEK_MS = [2000, 2000, 3000, 3000, 5000, 5000, 10000]

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
 * How long a connection may fail to open before the peer is freed.
 *
 * `NEVER_STARTED_MS` is short because the state it watches for is terminal
 * rather than slow: ICE leaves `new` within milliseconds of both descriptions
 * being applied, and a connection still sitting there has no candidate pair in
 * existence to try. Waiting longer cannot help it and does harm, because the
 * peer is blocked from being introduced again for the whole time.
 *
 * `OPENING_DEADLINE_MS` covers a connection that is genuinely checking. That
 * one may legitimately take many seconds between distant networks, so it is
 * given far more room, and still bounded so it cannot hold the peer forever.
 */
const NEVER_STARTED_MS = 6000
const OPENING_DEADLINE_MS = 25000

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

/**
 * Join a room.
 *
 * `discovery` selects how peers find each other, and defaults to trackers.
 * A tracker introduces peers itself and carries a complete offer, so nothing
 * can arrive after the description it belongs to; relays are a general message
 * bus that matchmaking is built on top of, and are the fallback when a swarm
 * cannot be reached. The two fail independently, which is the point of having
 * both.
 */
export function joinRoom(
  {
    appId, password, rtcConfig, relayUrls, makeRendezvous, makeSwarm, selfId: idOverride,
    chaseSchedule = CHASE_MS, rebuildAfter = REBUILD_AFTER_CHASES,
    neverStartedMs = NEVER_STARTED_MS, openingDeadlineMs = OPENING_DEADLINE_MS,
    discovery = 'tracker', trackerUrls,
    repair = DEFAULT_REPAIR,
    seekSchedule = SEEK_MS,
  } = {},
  roomId,
) {
  if (!appId) throw new Error('plaza/signal: appId is required')
  if (!roomId) throw new Error('plaza/signal: roomId is required')

  const id = idOverride ?? selfId

  const listeners = { onPeerJoin: null, onPeerLeave: null, onPeerStream: null }
  const links = new Map()      // peerId -> Link
  const contenders = new Map() // peerId -> Link racing the one in `links`
  const actions = new Map()    // name -> {onMessage}
  const published = new Map()  // stream -> metadata
  const pings = new Map()      // peerId -> [{resolve, reject}]
  const streamMeta = new Map() // peerId -> Map(streamId -> metadata)
  const pendingTracks = new Map() // peerId -> Map(streamId -> {stream, timer})
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

  /** Who made the offer behind a connection: the answering side's peer, or us. */
  const offererOf = (link) => (link.polite ? link.peerId : id)

  const linkFor = (peerId) => {
    const existing = links.get(peerId)
    if (existing && !existing.dead) return existing

    const link = new Link({
      selfId: id,
      peerId,
      rtcConfig,
      repair,
      send: (msg) => signalTo(peerId, msg),
      log: (what, detail) => note(peerId, what, detail),
      emit: (event, ...args) => handleLinkEvent(event, ...args),
    })

    links.set(peerId, link)
    note(peerId, 'link-created', link.polite ? 'polite (waits for offer)' : 'impolite (opens channel)')
    chase(peerId)
    return link
  }

  /**
   * Surface an arriving stream, once it can be named.
   *
   * Metadata travels over the data channel and tracks arrive by
   * renegotiation, so the label almost always lands first — but "almost
   * always" is not a guarantee, and a stream surfaced with the wrong name is
   * indistinguishable from one that never stops. A brief wait costs nothing
   * and removes the race.
   */
  const announceStream = (peerId, stream) => {
    const known = streamMeta.get(peerId)?.get(stream.id)
    if (known !== undefined) {
      listeners.onPeerStream?.(stream, peerId, known)
      return
    }

    const waiting = pendingTracks.get(peerId) ?? new Map()
    if (waiting.has(stream.id)) return

    const timer = setTimeout(() => {
      waiting.delete(stream.id)
      // Give up waiting and surface it unlabelled rather than losing it.
      note(peerId, 'stream-unlabelled', `${stream.id.slice(0, 8)} arrived with no metadata`)
      listeners.onPeerStream?.(stream, peerId, undefined)
    }, 2000)

    waiting.set(stream.id, { stream, timer })
    pendingTracks.set(peerId, waiting)
  }

  /**
   * Give up on a connection that is not going to open, and free the peer.
   *
   * The relay path has `chase`, which rebuilds a link that never came up. The
   * tracker path had nothing: a link was created when the tracker introduced
   * us and then lived forever whatever it did. That is worse than it sounds,
   * because `answerOffer` refuses an incoming offer while a link for that peer
   * exists — so one dead connection did not merely fail, it permanently
   * blocked the reverse direction, which is a fresh offer with a fresh
   * candidate set and an independent chance of working. Whichever direction
   * happened to be established first won the peer for good.
   *
   * The two deadlines are deliberately far apart, because they mean different
   * things. A connection still in `new` has no candidate pair to try and never
   * will: ICE starts checking within milliseconds of a description being
   * applied, so `new` after a few seconds is not slowness, it is a connection
   * with nothing on either side that the other can route to. One that reached
   * `connecting` really is trying, and across continents it deserves patience.
   */
  const watchOpening = (peerId, link) => {
    const abandon = (why) => {
      if (left || link.dead || link.open) return
      // Only if this is still a live candidate for that peer — it may have
      // been replaced already, and killing its successor would be a new bug.
      if (links.get(peerId) !== link && contenders.get(peerId) !== link) return
      note(peerId, 'abandoned', why)
      link.die(why)
      if (links.get(peerId) === link) links.delete(peerId)
    }

    setTimeout(() => {
      if (link.pc.connectionState !== 'new') return
      abandon('never started — ICE had no pair to try; freeing the peer to be introduced again')
    }, neverStartedMs)

    setTimeout(
      () => abandon(`still ${link.pc.connectionState} after ${openingDeadlineMs / 1000}s`),
      openingDeadlineMs,
    )
  }

  const sought = new Set() // peerIds dropped and not yet back
  let seekTimer = null
  let seekRound = 0

  /**
   * Look for a peer whose connection just failed, now rather than eventually.
   *
   * A dropped peer is almost always still in the room, and is most likely
   * looking for us too. Left to the routine cadence, a tracker would not
   * introduce us again for up to twenty seconds, which is most of the time a
   * room is willing to hold someone's place. So the swarm announces at once,
   * carrying fresh offers; on the relay path the link is rebuilt and chased
   * until it opens or the room gives up on the peer with `forget`.
   */
  const seekAgain = (peerId) => {
    if (left) return
    note(peerId, 'seeking', swarm ? 'announcing to the swarm now' : 'rebuilding the link')
    if (!swarm) { linkFor(peerId); return }
    void swarm.announce()
    sought.add(peerId)
    swarm.urgent = true
    if (!seekTimer) seekTimer = setTimeout(seekTick, seekSchedule[0])
  }

  /**
   * Keep announcing, briskly, while anyone is being sought.
   *
   * One announce at the moment of the drop is not enough, because the drop
   * is usually the network going away: that announce goes nowhere, and the
   * routine one is twenty seconds off. Measured in a real run — the network
   * came back and nobody was introduced until the next routine announce,
   * twenty-five seconds later. Offers are reused rather than rebuilt, so each
   * of these is one small message per tracker.
   */
  const seekTick = () => {
    seekTimer = null
    if (left) return
    for (const peerId of sought) {
      if (links.get(peerId)?.open) sought.delete(peerId)
    }
    if (sought.size === 0) { seekRound = 0; if (swarm) swarm.urgent = false; return }
    seekRound++
    void swarm?.announce()
    seekTimer = setTimeout(seekTick, seekSchedule[Math.min(seekRound, seekSchedule.length - 1)])
  }

  // The browser noticing the network come back is the best moment of all.
  const onOnline = () => {
    if (left || !swarm) return
    // Fresh tracker connections — the old ones are deaf for a while after an
    // outage — and back to the brisk end of the schedule, which a long
    // outage has long since left behind. Reopening announces by itself.
    note('-', 'online', 'network is back; reopening tracker connections')
    swarm.refresh?.()
    if (sought.size === 0) return
    seekRound = 0
    clearTimeout(seekTimer)
    seekTimer = setTimeout(seekTick, seekSchedule[0])
  }
  globalThis.addEventListener?.('online', onOnline)

  const handleLinkEvent = (event, peerId, ...rest) => {
    if (event === 'open') {
      const opened = rest[0]
      const current = links.get(peerId)
      if (opened && current !== opened) {
        if (contenders.get(peerId) === opened) contenders.delete(peerId)
        if (current?.open) {
          // Both made it. Both sides can see both now, so the rule decides,
          // and decides the same way on each end.
          if (!outranks(offererOf(opened), offererOf(current))) {
            opened.die('duplicate connection; the other one wins')
            return
          }
          // Ours displaces a working connection. To everything above, that
          // is the peer dropping and returning at once — and handled as one,
          // so streams and channels move across to the new connection.
          note(peerId, 'superseded', 'both connections opened; keeping the one the lower id offered')
          links.set(peerId, opened)
          current.die('superseded by the connection both sides keep')
          listeners.onPeerLeave?.(peerId, Object.assign(new Error('connection replaced'), { dropped: true }))
        } else {
          links.set(peerId, opened)
          if (current && !current.dead) current.die('the other connection opened first')
        }
      }
      // First to open wins — but the two ends may see the two connections
      // open in opposite orders when they finish moments apart. So the one
      // still racing gets a brief grace: if it opens within it, both ends
      // can see both, and the rule above settles it the same way on each.
      const loser = contenders.get(peerId)
      if (loser && loser !== opened) {
        setTimeout(() => {
          if (contenders.get(peerId) !== loser || loser.open) return
          contenders.delete(peerId)
          loser.die('the other connection opened first')
        }, RACE_GRACE_MS)
      }

      stopChasing(peerId)
      note(peerId, 'connected')
      // Anything already being shared goes to the newcomer immediately.
      const link = links.get(peerId)
      if (link) {
        for (const [stream, metadata] of published) {
          link.addStream(stream)
          link.send({ __plaza: 'stream-meta', streamId: stream.id, metadata })
        }
      }
      listeners.onPeerJoin?.(peerId)
      return
    }

    if (event === 'dead') {
      const why = rest[0]
      const dying = rest[1]
      // A connection that lost a race, or was replaced, says nothing about
      // the peer: whatever is current for them is still current.
      if (dying && links.get(peerId) !== dying) {
        if (contenders.get(peerId) === dying) contenders.delete(peerId)
        return
      }
      const link = links.get(peerId)
      const wasOpen = link?.opened
      // A rebuild kills the old link deliberately; that is not a departure and
      // must not be reported as one.
      if (why === 'rebuilding after failed discovery') return
      links.delete(peerId)
      // An attempt to reach someone we are looking for just failed. The next
      // one should not wait for the schedule.
      if (!wasOpen && sought.has(peerId) && swarm && !left) {
        note(peerId, 'seeking', `attempt failed (${why}); announcing again now`)
        void swarm.announce()
      }
      // Reject anything waiting on this peer rather than leaving it hanging.
      for (const waiter of pings.get(peerId) ?? []) waiter.reject(new Error(why))
      pings.delete(peerId)
      for (const entry of pendingTracks.get(peerId)?.values() ?? []) clearTimeout(entry.timer)
      pendingTracks.delete(peerId)
      streamMeta.delete(peerId)
      note(peerId, 'gone', why)
      if (wasOpen) {
        // Nobody said goodbye, so this is a failure rather than a departure,
        // and the peer is very likely still there. Saying which lets the room
        // hold their place instead of forgetting them.
        const reason = new Error(why)
        reason.dropped = true
        listeners.onPeerLeave?.(peerId, reason)
        seekAgain(peerId)
      }
      return
    }

    if (event === 'track') {
      const [, stream] = rest
      announceStream(peerId, stream)
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
      // Keyed by stream id, not held in a single slot. A peer sharing a
      // camera and a screen sends two of these, and one slot means the second
      // overwrites the first — the screen then arrives labelled as a camera,
      // and the message that later says "the screen stopped" finds nothing
      // under that name and leaves its last frame on the wall forever.
      //
      // Stream ids survive the trip: they travel in the SDP, so both sides
      // agree on them.
      const forPeer = streamMeta.get(peerId) ?? new Map()
      forPeer.set(data.streamId, data.metadata)
      streamMeta.set(peerId, forPeer)

      // A track may already be waiting on this label.
      const waiting = pendingTracks.get(peerId)?.get(data.streamId)
      if (waiting) {
        clearTimeout(waiting.timer)
        pendingTracks.get(peerId).delete(data.streamId)
        listeners.onPeerStream?.(waiting.stream, peerId, data.metadata)
      }
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
  let offerJob = Promise.resolve()
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
  /**
   * Build offers, one caller at a time.
   *
   * Every tracker socket announces as it opens, and they open together — so
   * without this, three callers read an empty pool, each decide they need a
   * full batch, and three batches get built. A field log caught exactly that:
   * nine connections where three were wanted, and a peer answering two of
   * them, the second of which had to be thrown away as a duplicate.
   *
   * Read-modify-write across an await is the same hazard the send-rate cap
   * had. Serialising is the whole fix; a queued caller re-reads and finds the
   * pool already full.
   */
  const makeOffers = (n) => {
    const run = () => makeOffersOnce(n)
    offerJob = offerJob.then(run, run)
    return offerJob
  }

  const makeOffersOnce = async (n) => {
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
    // Least-published first. A tracker hands offers out in order, so with a
    // single other peer it is always the first one that reaches them — and
    // if their answer to it was lost, they have marked it handled and ignore
    // it from then on. Re-announcing in a fixed order handed them that same
    // offer every time until it expired, two minutes later. Rotating means
    // each announce carries one they have not seen.
    const reusable = [...offered.entries()]
      .sort(([, a], [, b]) => a.published - b.published)
      .map(([offerId, entry]) => ({ offerId, sdp: entry.sdp, entry }))
    const wanted = Math.max(0, Math.min(n, MAX_PENDING_OFFERS - reusable.length))

    const made = []
    for (let i = 0; i < wanted; i++) {
      const offerId = randomId()
      const link = new Link({
        selfId: id,
        role: 'offer',
        trickle: false,
        rtcConfig,
        repair,
        send: (msg) => { if (link.peerId) signalTo(link.peerId, msg) },
        log: (what, detail) => note(offerId, what, detail),
        emit: (event, ...args) => handleLinkEvent(event, ...args),
      })
      try {
        const sdp = await link.completeOffer()
        if (!sdp) { link.die('no offer produced'); continue }

        // Built while the network was down. It would be published, answered
        // and never connect, and it would keep being handed out for its whole
        // lifetime — long after the network came back.
        if (summarize(sdp).total === 0) {
          note(offerId, 'offer-discarded', 'no candidates at all; the network is probably down')
          link.die('offer had no candidates')
          break // the rest of the batch would gather nothing either
        }

        // An offer advertising nothing the outside world can route is answered
        // normally and then simply never connects, because there is no pair
        // for ICE to try. That is silent unless it is counted here — and the
        // address family matters as much as the count, since two peers with no
        // family in common fail exactly the same way while both look healthy.
        note(offerId, 'offer-built', describe(sdp))

        offered.set(offerId, { link, at: Date.now(), sdp, published: 1 })
        made.push({ offerId, sdp })
      } catch (err) {
        note('-', 'offer-failed', err?.message ?? String(err))
        link.die('offer failed')
      }
    }
    // Everything still outstanding goes out again alongside the new ones, so
    // a tracker that introduces someone late still has something to hand over.
    const publishing = [...made, ...reusable.map(({ offerId, sdp }) => ({ offerId, sdp }))]
    for (const { entry } of reusable) entry.published++
    note('-', 'offers-published',
      `${publishing.length} for the swarm (${made.length} new, ${reusable.length} still open)`)
    return publishing
  }

  const answerOffer = async ({ peerId, offerId, sdp }) => {
    if (left) return null
    const existing = links.get(peerId)
    let racing = false
    if (existing && !existing.dead) {
      // A working connection is never traded for a hypothetical one, and
      // there is at most one connection in each direction. Otherwise theirs
      // races ours, and whichever opens first wins.
      if (existing.open || existing.polite || contenders.has(peerId)) {
        note(peerId, 'offer-skipped', existing.open ? 'already connected' : 'already answering one of theirs')
        return null
      }
      racing = true
    }

    const link = new Link({
      selfId: id,
      peerId,
      role: 'answer',
      trickle: false,
      rtcConfig,
      repair,
      send: (msg) => signalTo(peerId, msg),
      log: (what, detail) => note(peerId, what, detail),
      emit: (event, ...args) => handleLinkEvent(event, ...args),
    })
    if (racing) contenders.set(peerId, link)
    else links.set(peerId, link)
    watchOpening(peerId, link)
    note(peerId, 'answering', `offer ${offerId.slice(0, 6)} from the swarm${racing ? ', racing ours' : ''}`)

    try {
      return await link.completeAnswer(sdp)
    } catch (err) {
      note(peerId, 'answer-failed', err?.message ?? String(err))
      link.die('answer failed')
      if (links.get(peerId) === link) links.delete(peerId)
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
    let racing = false
    if (existing && !existing.dead) {
      // Two of our offers answered by the same peer is one too many; an
      // answer while we are answering theirs races it.
      if (existing.open || !existing.polite || contenders.has(peerId)) {
        link.die('duplicate introduction')
        return
      }
      racing = true
    }

    link.identify(peerId)
    if (racing) {
      contenders.set(peerId, link)
      note(peerId, 'racing', 'answered while we were answering theirs; first to open wins')
    } else {
      links.set(peerId, link)
    }

    // Their half of the same question. Reported together with ours below, so
    // a missing overlap reads as one fact rather than two logs to compare.
    const theirs = summarize(sdp)
    const ours = summarize(entry.sdp)
    const shared = [ours.ip4 && theirs.ip4 && 'IPv4', ours.ip6 && theirs.ip6 && 'IPv6'].filter(Boolean)
    note(peerId, 'answered',
      `our offer ${offerId.slice(0, 6)}; they offered ${describe(sdp)}` +
      (shared.length
        ? ` — shared: ${shared.join('+')}`
        : ' — NO SHARED ADDRESS FAMILY, this connection cannot succeed'))

    // A connection with no pair to try never leaves `new`, so it never reports
    // a state change at all and reads as nothing happening rather than as a
    // failure. The watchdog is what turns that silence back into another try.
    watchOpening(peerId, link)
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
      const swarmOptions = {
        infoHash: await infoHashFor(`plaza/${appId}/${roomId}`),
        peerId: id.padEnd(20, '0').slice(0, 20),
        log: (what, detail) => note('-', what, detail),
      }
      swarm = makeSwarm
        ? makeSwarm(swarmOptions)
        : new TrackerSwarm(trackerUrls ?? DEFAULT_TRACKERS, swarmOptions)
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
        link.send({ __plaza: 'stream-meta', streamId: stream.id, metadata })
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

    /**
     * Stop looking for a peer whose place is no longer being held.
     *
     * Only the relay path keeps looking for someone in particular; a swarm
     * introduces whoever is there. Either way, whatever half-built connection
     * exists for them is dropped.
     */
    forget(peerId) {
      stopChasing(peerId)
      sought.delete(peerId)
      if (swarm && sought.size === 0) swarm.urgent = false
      contenders.get(peerId)?.die('no longer looking for this peer')
      const link = links.get(peerId)
      if (link && !link.open) {
        links.delete(peerId)
        link.die('no longer looking for this peer')
      }
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
      clearTimeout(seekTimer)
      globalThis.removeEventListener?.('online', onOnline)

      // Say goodbye before tearing down, so peers show a departure rather than
      // waiting for a timeout to call it a failure.
      broadcast({ __plaza: 'leaving' })
      await new Promise((r) => setTimeout(r, 60))

      for (const peerId of [...chases.keys()]) stopChasing(peerId)
      for (const link of links.values()) link.die('room left')
      for (const link of contenders.values()) link.die('room left')
      contenders.clear()
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
