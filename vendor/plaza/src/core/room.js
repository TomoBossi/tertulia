import { joinRoom as trysteroJoin, selfId } from '../../vendor/trystero.mjs'
import { Emitter } from './emitter.js'
import { watchConnection } from './diagnostics.js'

/**
 * A room: the people in it, what they are broadcasting about themselves, and
 * the channels anything else can talk over.
 *
 * plaza is the substrate, not the application. It knows how to get people
 * connected and how to move bytes between them; it has no opinion about what
 * those bytes mean. There is no concept of a camera, a mute button or a game
 * in this file, and there should never be one — those belong to the layers
 * above, and keeping them out is what lets a video call and a chess app share
 * the same foundation.
 *
 * Nothing here touches the DOM either. The library hands you `MediaStream`
 * objects and tells you when things change; rendering is somebody else's job.
 *
 * @fires peer:join    (peer)
 * @fires peer:leave   (peer)
 * @fires peer:update  (peer)                presence changed
 * @fires peer:stream  (peer, stream, kind)  stream arrived, or null if ended
 * @fires peer:net     (peer, net)           connection quality changed
 * @fires chat         (message)
 * @fires error        (error)
 */
export class Room extends Emitter {
  /** Our own peer id. Stable for the lifetime of the page. */
  selfId = selfId

  /** @type {Map<string, Peer>} everyone else in the room */
  peers = new Map()

  /**
   * Whatever we are telling the room about ourselves.
   *
   * plaza does not interpret any of it. A call layer might put mute state in
   * here; a game might put a chosen colour. Anything JSON-serialisable works,
   * and it is re-sent automatically to anyone who joins later.
   */
  presence = {}

  /**
   * A rolling record of what the connections have been doing.
   *
   * Call failures are almost never observable at the moment someone notices
   * them — by then the interesting transition is minutes gone. Keeping the
   * transitions makes a post-mortem possible instead of guesswork.
   */
  log = []

  #room
  #channels = new Map()
  #rawChannels = new Map()
  #published = new Map()
  #netTimer = null
  #left = false
  #bitrate = null
  #playout = null
  #bitrateJob = Promise.resolve()
  #restarts = new Map()
  #strained = new Set()

  constructor(trysteroRoom, { presence = {} } = {}) {
    super()
    this.#room = trysteroRoom
    this.presence = { ...presence }

    this.#wirePresence()
    this.#wireStreams()
    this.#wireChat()
    this.#wirePeers()

    // Connection quality has no events in the underlying API, so it is polled.
    // Two seconds notices a peer degrading without draining a phone battery.
    this.#netTimer = setInterval(() => this.#pollNet(), 2000)
  }

  /**
   * Join a room.
   *
   * Everyone who passes the same `room` string ends up connected to each
   * other. The string is hashed before it reaches the relay network, so the
   * code your users type never becomes visible to whoever runs the relays.
   *
   * `password` additionally encrypts the connection handshake, which is worth
   * setting: the handshake carries ICE candidates, and ICE candidates carry
   * the IP address of everyone in the room.
   */
  static async join({ room, appId = 'plaza', password, nick, presence, rtcConfig } = {}) {
    if (!room || !String(room).trim()) {
      throw new Error('plaza: a room name is required')
    }

    // A display name is presence like any other, but it is the field every
    // application ends up wanting, so it gets a shortcut rather than making
    // everyone reach into the bag for it.
    const initial = { ...(nick ? { nick: String(nick).slice(0, 60) } : {}), ...(presence ?? {}) }

    const tr = trysteroJoin(
      {
        appId,
        ...(password ? { password } : {}),
        ...(rtcConfig ? { rtcConfig } : {}),
      },
      String(room).trim(),
    )

    return new Room(tr, { presence: initial })
  }

  // ---------------------------------------------------------------- presence

  #wirePresence() {
    this.#hello = this.#room.makeAction('plz.hello')
    this.#hello.onMessage = (data, { peerId }) => {
      const peer = this.#ensure(peerId)
      peer.presence = data && typeof data === 'object' ? data : {}
      // Mirrored onto the peer so callers can write peer.nick without
      // reaching through presence for the one field they always want.
      peer.nick = String(peer.presence.nick ?? '').slice(0, 60)
      this.emit('peer:update', peer)
    }
  }

  #hello

  /**
   * Replace what we are broadcasting about ourselves.
   *
   * Presence is sent whole rather than as a patch. It is small, it arrives
   * rarely, and a peer that missed one update would otherwise be permanently
   * out of step with no way to notice.
   */
  setPresence(next) {
    this.presence = { ...(next ?? {}) }
    this.#announce()
    this.emit('self', this.presence)
    return this.presence
  }

  /** Merge fields into presence, leaving the rest alone. */
  updatePresence(patch) {
    return this.setPresence({ ...this.presence, ...(patch ?? {}) })
  }

  /** This peer's display name, if it has set one. */
  get nick() {
    return this.presence?.nick ?? ''
  }

  /**
   * Set a display name.
   *
   * Shorthand for updating the `nick` field of presence, which is where it
   * lives — plaza has no notion of identity beyond what peers choose to say
   * about themselves.
   */
  setNick(nick) {
    return this.updatePresence({ nick: String(nick ?? '').slice(0, 60) })
  }

  #announce(target) {
    this.#hello.send(this.presence, target ? { target } : undefined).catch(() => {})
  }

  // ------------------------------------------------------------------- peers

  #wirePeers() {
    this.#room.onPeerJoin = async (peerId) => {
      const peer = this.#ensure(peerId)

      // Announced first, and before anything that can fail.
      //
      // Someone being in the room is a fact. Sending them our streams, capping
      // an encoder and bounding a jitter buffer are all things we would like
      // to do about that fact, and none of them are allowed a vote on whether
      // it happened. When the announcement came last, any of those throwing
      // left a peer that had genuinely connected sitting at "connecting"
      // forever, with the application never told it had arrived — the failure
      // presenting as the one thing it was not, a connection problem.
      this.#note(peerId, 'join')
      this.emit('peer:join', peer)

      // Someone arriving late has missed everything said so far, so both our
      // identity and our streams are repeated privately for them.
      this.#announce(peerId)

      // Raw channels are per peer connection and must be created for each one.
      for (const raw of this.#rawChannels.values()) raw.attach(peerId)

      // Each step is independently survivable, so one failing does not cancel
      // the rest. A new peer means new senders and receivers, which inherit
      // neither the send cap nor the playout bound.
      for (const [what, step] of [
        ['resend-streams', () => this.#resendStreams(peerId)],
        ['bitrate', () => this.#applyBitrate()],
        ['playout', () => this.#applyPlayoutDelay()],
      ]) {
        try {
          await step()
        } catch (err) {
          this.#note(peerId, `${what}-failed`, err?.message ?? String(err))
        }
      }
    }

    this.#room.onPeerLeave = (peerId) => {
      const peer = this.peers.get(peerId)
      if (!peer) return
      this.peers.delete(peerId)
      this.#restarts.delete(peerId)
      this.#strained.delete(peerId)
      for (const raw of this.#rawChannels.values()) raw.detach(peerId)

      this.#note(peerId, 'leave', `last seen ${peer.net.state}, path ${peer.net.path ?? '-'}`)
      this.emit('peer:leave', peer)
    }
  }

  /** Record a connection event, keeping only the recent past. */
  #note(peerId, what, detail) {
    const entry = { at: Date.now(), peer: peerId?.slice(0, 6) ?? '-', what, detail }
    this.log.push(entry)
    if (this.log.length > 200) this.log.shift()
    this.emit('log', entry)
    return entry
  }

  #ensure(peerId) {
    let peer = this.peers.get(peerId)
    if (!peer) {
      peer = {
        id: peerId,
        nick: '',
        presence: {},
        /** streams by kind, whatever kinds the application chooses to send */
        streams: {},
        net: { state: 'connecting', path: null, relayed: false, rtt: null },
        joinedAt: Date.now(),
      }
      this.peers.set(peerId, peer)
    }
    return peer
  }

  // ----------------------------------------------------------------- streams

  #wireStreams() {
    this.#room.onPeerStream = (stream, peerId, metadata) => {
      const peer = this.#ensure(peerId)
      const kind = metadata?.kind ?? 'default'

      peer.streams[kind] = stream
      this.emit('peer:stream', peer, stream, kind)
      this.emit('peer:update', peer)

      // The receiver carrying this stream did not exist a moment ago, so
      // whatever playout bound was set for the room has to be put on it now.
      // Applying it only once, at join, would silently miss every track.
      void this.#applyPlayoutDelay()

      // A remote stream stops by its tracks ending, not by a message, so the
      // only reliable notice that someone stopped sharing is this.
      for (const track of stream.getTracks()) {
        track.addEventListener('ended', () => {
          if (peer.streams[kind] !== stream) return
          if (stream.getTracks().some((t) => t.readyState === 'live')) return

          delete peer.streams[kind]
          this.emit('peer:stream', peer, null, kind)
          this.emit('peer:update', peer)
        })
      }
    }
  }

  /**
   * Send a stream to the room.
   *
   * `kind` is an opaque label echoed back to receivers, which use it to tell a
   * camera from a screen share — or from anything else an application invents.
   * plaza never inspects it.
   */
  addStream(stream, { kind = 'default', target } = {}) {
    if (!stream) return
    if (!target) this.#published.set(stream, kind)

    return this.#room.addStream(stream, {
      metadata: { kind },
      ...(target ? { target } : {}),
    })
  }

  removeStream(stream) {
    if (!stream) return
    this.#published.delete(stream)
    try { this.#room.removeStream(stream) } catch { /* never sent */ }
  }

  /**
   * Swap one track for another on every peer connection.
   *
   * Used when switching camera or microphone. Replacing the track on the
   * existing sender avoids renegotiating the connection, so nobody else's
   * video stutters because one person changed webcam.
   */
  replaceTrack(oldTrack, newTrack) {
    try {
      return this.#room.replaceTrack(oldTrack, newTrack)
    } catch (err) {
      console.warn('plaza: replaceTrack failed', err)
    }
  }

  async #resendStreams(peerId) {
    const jobs = []
    for (const [stream, kind] of this.#published) {
      jobs.push(this.#room.addStream(stream, { target: peerId, metadata: { kind } }))
    }
    await Promise.allSettled(jobs.flat())
  }

  // -------------------------------------------------------------------- chat

  #wireChat() {
    this.#chatAction = this.#room.makeAction('plz.chat')
    this.#chatAction.onMessage = (data, { peerId }) => {
      const peer = this.#ensure(peerId)
      this.emit('chat', {
        from: peerId,
        nick: peer.nick || peerId.slice(0, 6),
        text: String(data?.text ?? '').slice(0, 2000),
        at: Date.now(),
        self: false,
      })
    }
  }

  #chatAction

  /**
   * Send a chat message.
   *
   * Chat lives in plaza rather than a call layer because text is not a call
   * feature — a game room wants it just as much. It is a thin convention over
   * a channel, and any application wanting different semantics can ignore it
   * and open its own.
   */
  chat(text) {
    const clean = String(text ?? '').trim().slice(0, 2000)
    if (!clean) return null

    this.#chatAction.send({ text: clean }).catch(() => {})

    const msg = {
      from: this.selfId,
      nick: this.nick || 'you',
      text: clean,
      at: Date.now(),
      self: true,
    }
    this.emit('chat', msg)
    return msg
  }

  // ---------------------------------------------------------------- channels

  /**
   * Open a named channel for application data — a game's moves, a shared
   * cursor, anything.
   *
   * Delivery is reliable and ordered, which is exactly right for turn-based
   * play: a move must arrive, and must arrive after the one before it. For
   * anything realtime enough to prefer a dropped update over a late one, use
   * {@link Room#dataChannel} instead.
   */
  channel(name) {
    const key = String(name)
    const existing = this.#channels.get(key)
    if (existing) return existing

    const action = this.#room.makeAction(shortName(key))
    const emitter = new Emitter()
    action.onMessage = (data, { peerId }) => emitter.emit('message', data, peerId)

    const channel = {
      name: key,
      send: (data, target) => action.send(data, target ? { target } : undefined).catch(() => {}),
      on: (event, fn) => emitter.on(event, fn),
      close: () => {
        emitter.clearListeners()
        this.#channels.delete(key)
      },
    }

    this.#channels.set(key, channel)
    return channel
  }

  /**
   * Open a raw, optionally unreliable data channel to every peer.
   *
   * This is the escape hatch for realtime netcode. Reliable ordered delivery
   * is the wrong shape for rollback: a retransmission costs a full round trip
   * — precisely the latency rollback exists to hide — and one lost packet
   * stalls every later frame behind it. Such a system wants
   * `{ordered: false, maxRetransmits: 0}` and repeats its own state instead.
   *
   * The channel is created with `negotiated: true` and an id derived from the
   * label, so both sides construct it identically with no offer/answer
   * exchange. Without that, opening a channel mid-session would renegotiate
   * the peer connection and interrupt any media already flowing.
   */
  dataChannel(label, opts = {}) {
    const key = String(label)
    const existing = this.#rawChannels.get(key)
    if (existing) return existing.handle

    const id = channelId(key)
    const config = {
      negotiated: true,
      id,
      ordered: opts.ordered ?? false,
      ...(opts.maxPacketLifeTime != null
        ? { maxPacketLifeTime: opts.maxPacketLifeTime }
        : { maxRetransmits: opts.maxRetransmits ?? 0 }),
    }

    const emitter = new Emitter()
    const channels = new Map()

    const attach = (peerId) => {
      if (channels.has(peerId)) return
      const pc = this.#room.getPeers()[peerId]
      if (!pc) return

      let dc
      try {
        dc = pc.createDataChannel(key, config)
      } catch (err) {
        console.warn(`plaza: could not open raw channel "${key}" to ${peerId}`, err)
        return
      }

      dc.binaryType = 'arraybuffer'
      dc.addEventListener('open', () => emitter.emit('open', peerId, dc))
      dc.addEventListener('close', () => emitter.emit('close', peerId))
      dc.addEventListener('message', (e) => emitter.emit('message', peerId, e.data))
      channels.set(peerId, dc)
    }

    const detach = (peerId) => {
      const dc = channels.get(peerId)
      if (!dc) return
      channels.delete(peerId)
      try { dc.close() } catch { /* already closed */ }
    }

    const handle = {
      label: key,
      id,
      peers: () => [...channels.keys()],
      send: (peerId, data) => {
        const dc = channels.get(peerId)
        if (dc?.readyState === 'open') dc.send(data)
      },
      broadcast: (data) => {
        for (const dc of channels.values()) {
          if (dc.readyState === 'open') dc.send(data)
        }
      },
      on: (event, fn) => emitter.on(event, fn),
      close: () => {
        for (const peerId of [...channels.keys()]) detach(peerId)
        emitter.clearListeners()
        this.#rawChannels.delete(key)
      },
    }

    this.#rawChannels.set(key, { handle, attach, detach })
    for (const peerId of this.peers.keys()) attach(peerId)
    return handle
  }

  /** The underlying RTCPeerConnections, keyed by peer id. */
  connections() {
    return this.#room.getPeers()
  }

  /**
   * Cap what we send, per peer.
   *
   * Without a cap, WebRTC ramps up to whatever the *sender's* uplink appears
   * to allow, which says nothing about whether the receiver can decode it. A
   * laptop on good broadband will happily flood a budget phone until its
   * decoder falls behind, its frames queue, and — because encoding and the
   * STUN keepalives share the same starved CPU and radio — its outbound stops
   * entirely. The far end then sees a dead peer and tears the call down.
   *
   * Capping the send rate is the only lever that addresses that directly.
   * Resolution alone does not: the encoder will spend an unlimited bitrate on
   * whatever resolution it is given.
   *
   * The cap is remembered and reapplied to peers who join later.
   */
  async limitBitrate({ video = null, audio = null } = {}) {
    this.#bitrate = { video, audio }
    await this.#applyBitrate()
    return this.#bitrate
  }

  /**
   * Apply the cap, one run at a time.
   *
   * setParameters is a read-modify-write against state the browser also owns.
   * getParameters hands out a snapshot stamped with a transaction id, and the
   * moment any write lands every other outstanding snapshot is stale — the
   * browser rejects it rather than applying it, and the cap silently does not
   * happen. Two callers overlapping is enough, and there are several: the room
   * reapplies on join while the application reapplies on its own schedule,
   * neither aware of the other.
   *
   * Serialising is the whole fix. Each run re-reads, so a call that queues
   * behind another still writes current values.
   */
  #applyBitrate() {
    // The chain must never carry a rejection forward. A queue that poisons
    // itself on one bad run would take every later caller down with it, and
    // callers include the join handler.
    const run = () => this.#applyBitrateOnce().catch((err) => {
      this.#note('-', 'bitrate-failed', err?.message ?? String(err))
    })
    this.#bitrateJob = this.#bitrateJob.then(run, run)
    return this.#bitrateJob
  }

  async #applyBitrateOnce() {
    if (!this.#bitrate) return
    const { video, audio } = this.#bitrate

    for (const [peerId, pc] of Object.entries(this.#room.getPeers())) {
      for (const sender of pc.getSenders()) {
        const kind = sender.track?.kind
        const cap = kind === 'video' ? video : kind === 'audio' ? audio : null
        if (!cap) continue

        const write = async () => {
          const params = sender.getParameters()
          // Firefox hands back parameters with no encodings until the first
          // negotiation completes; writing one in is harmless and required.
          if (!params.encodings?.length) params.encodings = [{}]
          for (const encoding of params.encodings) {
            encoding.maxBitrate = cap * 1000

            // When a path cannot carry everything, it should give up video
            // before voice. A frozen picture is a call that continues; broken
            // audio is a call that stops working. Left unset these compete as
            // equals, and video — being far larger — wins by volume.
            encoding.networkPriority = kind === 'audio' ? 'high' : 'low'
            encoding.priority = kind === 'audio' ? 'high' : 'low'
          }
          await sender.setParameters(params)
        }

        try {
          await write()
        } catch {
          // One retry against a fresh snapshot. Renegotiation can invalidate
          // one mid-flight through no fault of ours, and this is the mechanism
          // that stops a sender burying a receiver — too important to let a
          // single lost race turn it off for the rest of the call.
          try {
            await write()
          } catch (err) {
            this.#note(peerId, 'bitrate-failed', `${kind}: ${err.message}`)
          }
        }
      }
    }
  }

  /**
   * Bound how long receivers may hold incoming media before playing it.
   *
   * A receiver buffers to smooth out uneven arrival, and grows that buffer
   * whenever packets come late. What it will not readily do is shrink it
   * again: in continuous speech there is no quiet moment to catch up in, so a
   * single rough patch can leave a conversation permanently a second behind
   * while every other statistic reads perfectly healthy. The round trip says
   * 5ms and the person still answers late, which is baffling until you know
   * the delay is on the receiving end and self-inflicted.
   *
   * This is a genuine trade rather than a free win. A smaller buffer conceals
   * less jitter, so some of what was delay becomes an audible glitch instead.
   * For a conversation that is the right side of the trade — people talk over
   * each other at half a second of delay, and stop being able to converse at
   * all by a second — and for watching a screen share it is the wrong one.
   *
   * Values are milliseconds; null leaves the browser to decide.
   */
  async limitPlayoutDelay({ audio = null, video = null } = {}) {
    this.#playout = { audio, video }
    await this.#applyPlayoutDelay()
    return this.#playout
  }

  async #applyPlayoutDelay() {
    if (!this.#playout) return
    const { audio, video } = this.#playout

    for (const [peerId, pc] of Object.entries(this.#room.getPeers())) {
      for (const receiver of pc.getReceivers()) {
        const kind = receiver.track?.kind
        const target = kind === 'video' ? video : kind === 'audio' ? audio : null
        if (target == null) continue

        try {
          // jitterBufferTarget is the standard property, in milliseconds.
          // playoutDelayHint predates it and takes seconds; browsers that have
          // one generally lack the other, so both are offered and whichever
          // exists takes effect.
          if ('jitterBufferTarget' in receiver) {
            receiver.jitterBufferTarget = target
          } else if ('playoutDelayHint' in receiver) {
            receiver.playoutDelayHint = target / 1000
          } else {
            continue
          }
        } catch (err) {
          this.#note(peerId, 'playout-failed', `${kind}: ${err.message}`)
        }
      }
    }
  }

  // ------------------------------------------------------------- diagnostics

  async #pollNet() {
    if (this.#left) return

    for (const [peerId, pc] of Object.entries(this.#room.getPeers())) {
      const peer = this.peers.get(peerId)
      if (!peer) continue

      const net = await watchConnection(pc)
      const changed =
        net.state !== peer.net.state ||
        net.relayed !== peer.net.relayed ||
        net.path !== peer.net.path

      if (changed) {
        this.#note(peerId, net.state, `path ${net.path ?? '-'}, rtt ${net.rtt ?? '-'}ms`)
      }

      peer.net = net
      if (changed) this.emit('peer:net', peer, net)

      this.#noteStrain(peerId, net)
      this.#maybeRestart(peerId, pc, net)
    }
  }

  /**
   * Record when a link starts or stops struggling, in a way the log survives.
   *
   * The log is the only artefact that outlives a call, and until now it only
   * recorded state changes — join, connected, disconnected. A call that stayed
   * "connected" throughout while being unusable left no trace at all, so the
   * log agreed with the connection and disagreed with the person on it.
   *
   * Edge-triggered on purpose: a poll every two seconds writing a line every
   * two seconds would bury the state changes that make the log readable.
   */
  #noteStrain(peerId, net) {
    const strained =
      (net.playoutDelay != null && net.playoutDelay > 400) ||
      (net.remoteLoss != null && net.remoteLoss > 5)

    const was = this.#strained.has(peerId)
    if (strained === was) return

    if (strained) {
      this.#strained.add(peerId)
      this.#note(peerId, 'strained',
        `held ${net.playoutDelay ?? '-'}ms, they lose ${net.remoteLoss ?? '-'}% of ours, `
        + `we lose ${net.packetLoss ?? '-'}% of theirs, rtt ${net.rtt ?? '-'}ms`)
    } else {
      this.#strained.delete(peerId)
      this.#note(peerId, 'recovered', `held ${net.playoutDelay ?? '-'}ms`)
    }
  }

  /**
   * Try to rebuild a path that has gone quiet, before it is too late.
   *
   * A disconnected connection is closed for good five seconds later, and
   * neither peer gets it back — the one that was starved never even learns it
   * happened, because it is still playing out video that already arrived.
   * Restarting ICE gathers fresh candidates and renegotiates, which is the
   * one recovery available, and it only works inside that window.
   *
   * Once per episode: a restart storm would make a struggling link worse.
   */
  #maybeRestart(peerId, pc, net) {
    if (net.state !== 'disconnected') {
      if (net.state === 'connected' || net.state === 'completed') {
        this.#restarts.delete(peerId)
      }
      return
    }
    if (this.#restarts.has(peerId)) return

    this.#restarts.set(peerId, Date.now())
    try {
      pc.restartIce()
      this.#note(peerId, 'ice-restart', 'path went quiet; regathering')
    } catch (err) {
      this.#note(peerId, 'ice-restart-failed', err.message)
    }
  }

  /** Measure round-trip time to a peer. */
  async ping(peerId) {
    try {
      return await this.#room.ping(peerId)
    } catch {
      return null
    }
  }

  // ---------------------------------------------------------------- teardown

  async leave() {
    if (this.#left) return
    this.#left = true

    clearInterval(this.#netTimer)
    for (const channel of [...this.#channels.values()]) channel.close()
    for (const raw of [...this.#rawChannels.values()]) raw.handle.close()

    this.#published.clear()
    try { await this.#room.leave() } catch { /* already gone */ }

    this.peers.clear()
    this.clearListeners()
  }
}

/** Convenience alias matching the package entry point. */
export const join = Room.join.bind(Room)

/**
 * Trystero caps action names at 32 bytes. Rather than push that limit onto
 * every caller, anything longer folds into a short deterministic token — so an
 * application can name its channel whatever it likes and two differently named
 * channels still never collide.
 */
function shortName(name) {
  const bytes = new TextEncoder().encode(name)
  if (bytes.length <= 32) return name
  return `x${hash32(name).toString(36)}`
}

/**
 * Derive a stable SCTP stream id from a label.
 *
 * Both peers must choose the same number without discussing it, which a hash
 * gives for free. Ids start at 1000 to stay clear of the low, sequentially
 * assigned ids that in-band negotiated channels use.
 */
function channelId(label) {
  return 1000 + (hash32(label) % 60000)
}

function hash32(str) {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}
