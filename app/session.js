import { Emitter } from 'plaza'
import { SpeakerTracker, videoProfileFor, estimateUpload } from 'mirador'

/**
 * The call session: everything that makes a room full of streams behave like a
 * conversation.
 *
 * This is deliberately application code rather than library code. Deciding who
 * gets the big tile, what a screen share does to the layout, and how
 * participants are ordered are *product* decisions — a video call wants the
 * speaker centre stage, and a games room would want the board there instead
 * with faces shrunk to a strip. Baking either rule into a shared library would
 * force the other to fight it with configuration flags.
 *
 * plaza carries the streams. mirador captures them and measures them. What any
 * of it *means* is decided here.
 *
 * @fires change  the view model changed and the interface should re-render
 * @fires chat    (message)
 * @fires notice  (text)  something worth telling the user, in passing
 */
export class CallSession extends Emitter {
  /** @type {string|null} explicitly pinned participant, overriding everything */
  pinned = null

  /** @type {string|null} whoever is currently loudest */
  speaking = null

  /**
   * 'auto' lets a screen share or the speaker take the big tile; 'grid' gives
   * everyone equal space; 'spotlight' always has one large tile.
   */
  layout = 'auto'

  /** Peers whose arrival has been announced, so it is announced only once. */
  #greeted = new Set()

  constructor({ room, media, nick }) {
    super()
    this.room = room
    this.media = media
    this.nick = nick

    this.speakers = new SpeakerTracker({
      onChange: (loudest) => {
        if (loudest === this.speaking) return
        this.speaking = loudest
        this.emit('change')
      },
    })

    this.#wire()
    this.#syncPresence()
  }

  #wire() {
    const room = this.room

    room.on('peer:join', (peer) => {
      // Deliberately not announced here. A peer's name arrives on its own
      // message a moment after the connection opens, so announcing now would
      // greet "someone" every single time.
      setTimeout(() => this.#greet(peer), 2000)
      this.#adaptQuality()
      this.emit('change')
    })

    room.on('peer:leave', (peer) => {
      this.speakers.remove(peer.id)
      this.#greeted.delete(peer.id)
      if (this.pinned === peer.id) this.pinned = null

      // A peer that was mid-call and never reached a healthy state did not
      // leave, it was lost — and saying "left" for both hides the failure that
      // is worth knowing about. The other end may not even have noticed yet.
      const dropped = peer.net?.state === 'disconnected' || peer.net?.state === 'failed'
      this.emit('notice', dropped
        ? `${peer.nick || 'someone'} dropped — connection lost, not a goodbye`
        : `${peer.nick || 'someone'} left`)

      this.#adaptQuality()
      this.emit('change')
    })

    room.on('peer:update', (peer) => {
      this.#greet(peer)
      this.emit('change')
    })
    room.on('peer:net', () => this.emit('change'))
    room.on('chat', (msg) => this.emit('chat', msg))
    room.on('error', (err) => this.emit('notice', err.message))

    room.on('peer:stream', (peer, stream, kind) => {
      if (kind === 'camera') {
        // Only camera audio feeds speaker detection. A shared screen playing a
        // video would otherwise permanently "win" the spotlight.
        if (stream) this.speakers.add(peer.id, stream)
        else this.speakers.remove(peer.id)
      }
      this.emit('change')
    })

    // Our own mute and share state is part of what we tell the room, so the
    // interface can grey out a muted participant without waiting for silence.
    this.media.on('state', () => {
      this.#syncPresence()
      this.emit('change')
    })

    this.media.on('screen', (stream) => {
      if (stream) this.room.addStream(stream, { kind: 'screen' })
      this.emit('change')
    })

    this.media.on('track', (swaps) => {
      for (const { oldTrack, newTrack } of swaps) this.room.replaceTrack(oldTrack, newTrack)
    })

    this.media.on('error', (err) => this.emit('notice', err.message))
  }

  /** Announce an arrival once, and only once we know who it was. */
  #greet(peer) {
    if (!peer || this.#greeted.has(peer.id)) return
    this.#greeted.add(peer.id)
    this.emit('notice', `${peer.nick || 'someone'} joined`)
  }

  #syncPresence() {
    this.room.updatePresence({ nick: this.nick, ...this.media.state() })
  }

  setNick(nick) {
    this.nick = String(nick ?? '').slice(0, 40)
    this.#syncPresence()
    this.emit('change')
  }

  // ------------------------------------------------------------------ media

  /** Begin capturing and send it to the room. */
  async start({ audio = true, video = true } = {}) {
    const stream = await this.media.start({ audio, video })
    if (stream) {
      this.room.addStream(stream, { kind: 'camera' })
      this.speakers.add('self', stream)
    }
    this.#adaptQuality()
    this.emit('change')
    return stream
  }

  toggleAudio() { this.media.toggleAudio() }
  toggleVideo() { this.media.toggleVideo() }

  async toggleScreen() {
    if (this.media.screenStream) {
      this.room.removeStream(this.media.screenStream)
      this.media.stopScreen()
      return
    }
    try {
      await this.media.startScreen()
    } catch (err) {
      if (err.name !== 'NotAllowedError') this.emit('notice', err.message)
    }
  }

  /**
   * Step video quality down as the room grows.
   *
   * In a mesh each participant uploads one copy per peer, so the cost of a
   * camera multiplies by the size of the room. Sending 720p to five people is
   * about 7.5 Mbps of upload, which most home connections do not have.
   *
   * Applying constraints to the live track rather than restarting capture
   * means the camera light never blinks and nobody's video cuts out.
   */
  async #adaptQuality() {
    const others = this.room.peers.size
    const profile = videoProfileFor(others)

    // The ceiling matters more than the resolution. Constraining the capture
    // asks the camera for fewer pixels; capping the sender is what stops the
    // encoder spending an unbounded bitrate on whatever pixels it gets, and
    // burying a receiver that cannot decode that fast.
    await this.room.limitBitrate({ video: profile.maxBitrateKbps, audio: 48 })

    for (const track of this.media.stream?.getVideoTracks() ?? []) {
      try {
        await track.applyConstraints({
          width: { ideal: profile.width },
          height: { ideal: profile.height },
          frameRate: { ideal: profile.frameRate },
        })
      } catch { /* some devices refuse; the call continues either way */ }
    }
  }

  /** What this room currently costs us in upload. */
  bandwidth() {
    return estimateUpload({
      peerCount: this.room.peers.size,
      video: this.media.videoEnabled && !!this.media.stream,
      audio: this.media.audioEnabled && !!this.media.stream,
      screen: !!this.media.screenStream,
    })
  }

  // ---------------------------------------------------------------- layout

  pin(id) {
    this.pinned = this.pinned === id ? null : id
    this.emit('change')
  }

  /** Cycle through the layouts, the way a tiling window manager would. */
  cycleLayout() {
    const order = ['auto', 'grid', 'spotlight']
    this.layout = order[(order.indexOf(this.layout) + 1) % order.length]
    this.emit('change')
    return this.layout
  }

  /**
   * Who belongs in the big tile.
   *
   * The order of precedence is the product decision this whole class exists to
   * make. An explicit pin always wins, because a person who chose deserves to
   * keep it. A screen share comes next — someone presenting is almost always
   * the thing to look at. Only then does the loudest voice matter.
   */
  spotlight() {
    if (this.layout === 'grid') return null
    if (this.pinned && this.#exists(this.pinned)) return this.pinned

    const sharing = this.participants().find((p) => p.streams.screen)
    if (sharing) return sharing.id

    if (this.speaking && this.#exists(this.speaking)) return this.speaking

    // Spotlight was asked for explicitly, so something has to hold it even
    // when nobody is talking.
    if (this.layout === 'spotlight') return this.participants()[0]?.id ?? null
    return null
  }

  #exists(id) {
    return id === 'self' || this.room.peers.has(id)
  }

  /**
   * Everyone in the call, ourselves included, in a stable order.
   *
   * Stability matters more than cleverness here: tiles that reshuffle every
   * time somebody speaks are disorienting, so ordering is by arrival and self
   * goes last. Emphasis is applied by the spotlight, not by reordering.
   */
  participants() {
    const self = {
      id: 'self',
      self: true,
      nick: this.nick || 'you',
      presence: { nick: this.nick, ...this.media.state() },
      streams: {
        camera: this.media.stream,
        screen: this.media.screenStream,
      },
      net: null,
      speaking: this.speakers.speaking('self'),
      level: this.speakers.level('self'),
    }

    const others = [...this.room.peers.values()]
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((peer) => ({
        id: peer.id,
        self: false,
        nick: peer.nick || peer.id.slice(0, 6),
        presence: peer.presence ?? {},
        streams: peer.streams,
        net: peer.net,
        speaking: this.speakers.speaking(peer.id),
        level: this.speakers.level(peer.id),
      }))

    return [...others, self]
  }

  send(text) { this.room.chat(text) }

  async leave() {
    this.speakers.destroy()
    this.media.stop()
    await this.room.leave()
    this.clearListeners()
  }
}
