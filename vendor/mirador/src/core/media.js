import { Emitter } from './emitter.js'

/**
 * Local capture: camera, microphone and screen.
 *
 * This module owns everything that happens before the network gets involved —
 * asking for permission, enumerating devices, switching between them, muting,
 * and starting or stopping a screen share. It knows nothing about peers or
 * rooms, so it can be used on its own to build a device-picker preview screen.
 *
 * Two decisions worth knowing about:
 *
 * **Muting disables tracks, it does not stop them.** Setting `track.enabled =
 * false` keeps the connection intact and transmits silence or black frames.
 * Stopping the track instead would tear down and renegotiate the peer
 * connection on every mute, and the camera light would flicker off and on.
 *
 * **Screen share is a second stream, not a replacement.** Swapping your camera
 * track for the screen would make you vanish from the call while presenting.
 * Sending both means viewers can show your face beside your slides, which is
 * what every real conferencing tool does.
 *
 * Events: `stream`, `screen`, `state`, `track`, `devices`, `error`.
 */
export class LocalMedia extends Emitter {
  /** @type {MediaStream|null} */
  stream = null
  /** @type {MediaStream|null} */
  screenStream = null

  audioEnabled = true
  videoEnabled = true

  #deviceIds = { audioinput: null, videoinput: null }
  #devicesBound = false

  /** True when this browser can share a screen at all. */
  static get canShareScreen() {
    return typeof navigator !== 'undefined' &&
      !!navigator.mediaDevices?.getDisplayMedia
  }

  /**
   * Request camera and microphone.
   *
   * Both are optional; passing `{audio: true, video: false}` gives a
   * voice-only participant, which is the right default on a weak connection.
   */
  async start({ audio = true, video = true } = {}) {
    if (!audio && !video) {
      this.stop()
      return null
    }

    const constraints = {
      audio: audio ? this.#audioConstraints() : false,
      video: video ? this.#videoConstraints() : false,
    }

    let stream
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints)
    } catch (err) {
      // The described error is thrown, not just emitted. Throwing the raw one
      // means any caller using try/catch shows "Permission denied" while
      // listeners get the sentence explaining where to fix it — the same
      // failure told two different ways depending on how you happened to
      // listen. The original is preserved as `cause`.
      const described = describeMediaError(err, { audio, video })
      this.emit('error', described)
      throw described
    }

    this.#adopt(stream)
    this.#watchDevices()
    return this.stream
  }

  #audioConstraints() {
    const id = this.#deviceIds.audioinput
    return {
      ...(id ? { deviceId: { exact: id } } : {}),
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    }
  }

  #videoConstraints() {
    const id = this.#deviceIds.videoinput
    return {
      ...(id ? { deviceId: { exact: id } } : {}),
      // A ceiling rather than a demand. In a mesh every participant uploads
      // one copy per peer, so asking for 1080p from four people is a good way
      // to saturate a home connection.
      width: { ideal: 1280, max: 1280 },
      height: { ideal: 720, max: 720 },
      frameRate: { ideal: 30, max: 30 },
    }
  }

  /** Replace the current stream, preserving mute state. */
  #adopt(stream) {
    const previous = this.stream
    this.stream = stream

    for (const track of stream.getAudioTracks()) track.enabled = this.audioEnabled
    for (const track of stream.getVideoTracks()) track.enabled = this.videoEnabled

    if (previous) {
      for (const track of previous.getTracks()) track.stop()
    }

    this.emit('stream', stream, previous)
  }

  /** Stop capturing entirely and release the devices. */
  stop() {
    for (const track of this.stream?.getTracks() ?? []) track.stop()
    this.stream = null
    this.stopScreen()
    this.emit('stream', null)
  }

  setAudioEnabled(on) {
    this.audioEnabled = on
    for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = on
    this.emit('state', this.state())
  }

  setVideoEnabled(on) {
    this.videoEnabled = on
    for (const track of this.stream?.getVideoTracks() ?? []) track.enabled = on
    this.emit('state', this.state())
  }

  toggleAudio() { this.setAudioEnabled(!this.audioEnabled) }
  toggleVideo() { this.setVideoEnabled(!this.videoEnabled) }

  state() {
    return {
      audioEnabled: this.audioEnabled,
      videoEnabled: this.videoEnabled,
      sharingScreen: !!this.screenStream,
      hasStream: !!this.stream,
    }
  }

  /**
   * Start sharing the screen.
   *
   * `getDisplayMedia` is absent on phones and tablets generally, not on one
   * vendor's browser — capturing the screen needs a privileged platform API
   * that no mobile OS exposes to the web, so switching browsers does not help.
   * This throws rather than failing obscurely; check
   * `LocalMedia.canShareScreen` before offering the button.
   */
  async startScreen({ audio = true } = {}) {
    if (!LocalMedia.canShareScreen) {
      // Says what was detected — the API is missing — and stops. Naming a
      // platform the code never checked for is worse than saying nothing: it
      // tells someone on Android the message was not written for them, so
      // they cannot tell whether any of it applies.
      const err = new Error('This browser does not offer screen sharing.')
      this.emit('error', err)
      throw err
    }
    if (this.screenStream) return this.screenStream

    let stream
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 15, max: 30 } },
        audio,
      })
    } catch (err) {
      // A user who changes their mind at the picker is not an error worth
      // reporting; it arrives as NotAllowedError exactly like a denied
      // permission, so it has to be distinguished by intent, not by name.
      if (err.name === 'NotAllowedError') throw err

      const described = describeMediaError(err, { screen: true })
      this.emit('error', described)
      throw described
    }

    this.screenStream = stream

    // The browser draws its own "stop sharing" affordance outside the page,
    // so the only way to learn the user pressed it is the track ending.
    for (const track of stream.getTracks()) {
      track.addEventListener('ended', () => this.stopScreen())
    }

    this.emit('screen', stream)
    this.emit('state', this.state())
    return stream
  }

  stopScreen() {
    if (!this.screenStream) return

    const stream = this.screenStream
    this.screenStream = null
    for (const track of stream.getTracks()) track.stop()

    this.emit('screen', null, stream)
    this.emit('state', this.state())
  }

  /** Enumerate inputs and outputs, grouped by kind. */
  async devices() {
    const all = await navigator.mediaDevices.enumerateDevices()
    const grouped = { audioinput: [], videoinput: [], audiooutput: [] }

    for (const d of all) {
      if (grouped[d.kind]) {
        grouped[d.kind].push({
          deviceId: d.deviceId,
          // Labels are empty until permission has been granted at least once,
          // so a device picker shown before `start()` will be anonymous.
          label: d.label || labelFallback(d.kind, grouped[d.kind].length),
          active: this.#deviceIds[d.kind] === d.deviceId,
        })
      }
    }
    return grouped
  }

  /**
   * Switch to a different camera or microphone.
   *
   * Returns the tracks that changed so the caller can swap them into live peer
   * connections. Replacing a track on an existing sender avoids renegotiating
   * the whole connection, which would otherwise interrupt everyone's video for
   * a moment because one person picked a different webcam.
   */
  async useDevice(kind, deviceId) {
    if (!(kind in this.#deviceIds)) throw new Error(`mirador: unknown device kind "${kind}"`)

    this.#deviceIds[kind] = deviceId
    if (!this.stream) return null

    const wantAudio = this.stream.getAudioTracks().length > 0
    const wantVideo = this.stream.getVideoTracks().length > 0

    const fresh = await navigator.mediaDevices.getUserMedia({
      audio: wantAudio ? this.#audioConstraints() : false,
      video: wantVideo ? this.#videoConstraints() : false,
    })

    const swaps = []
    const type = kind === 'audioinput' ? 'audio' : 'video'
    const oldTrack = this.stream[type === 'audio' ? 'getAudioTracks' : 'getVideoTracks']()[0]
    const newTrack = fresh[type === 'audio' ? 'getAudioTracks' : 'getVideoTracks']()[0]

    if (oldTrack && newTrack) {
      newTrack.enabled = oldTrack.enabled
      swaps.push({ kind: type, oldTrack, newTrack })
    }

    // Carry over the tracks we are not replacing, so the stream identity and
    // the untouched track both survive.
    const merged = new MediaStream()
    for (const t of fresh.getTracks()) {
      if (t.kind === type) merged.addTrack(t)
    }
    for (const t of this.stream.getTracks()) {
      if (t.kind !== type) merged.addTrack(t)
      else t.stop()
    }

    this.stream = merged
    this.emit('track', swaps)
    this.emit('stream', merged)
    return swaps
  }

  /** Re-emit the device list whenever hardware is plugged or unplugged. */
  #watchDevices() {
    if (this.#devicesBound || !navigator.mediaDevices?.addEventListener) return
    this.#devicesBound = true

    navigator.mediaDevices.addEventListener('devicechange', async () => {
      try {
        this.emit('devices', await this.devices())
      } catch { /* enumeration can fail while a device is mid-unplug */ }
    })
  }
}

function labelFallback(kind, index) {
  const noun = { audioinput: 'Microphone', videoinput: 'Camera', audiooutput: 'Speaker' }[kind]
  return `${noun} ${index + 1}`
}

/**
 * Turn a getUserMedia rejection into something worth showing a person.
 *
 * The raw errors are famously unhelpful — `NotAllowedError` covers both "you
 * denied permission" and "your OS denied the browser permission", which need
 * completely different fixes from completely different places.
 */
export function describeMediaError(err, want = {}) {
  const what = want.screen ? 'screen' :
    want.video && want.audio ? 'camera and microphone' :
      want.video ? 'camera' : 'microphone'

  const messages = {
    NotAllowedError: `Permission to use your ${what} was refused. Check the padlock in the address bar, and your operating system's privacy settings — it can be blocked in either place.`,
    NotFoundError: `No ${what} was found on this device.`,
    NotReadableError: `Your ${what} is in use by another application, or the operating system would not release it.`,
    OverconstrainedError: `No ${what} matched the requested settings.`,
    SecurityError: 'Media capture requires a secure context. Serve the page over https:// or localhost.',
    AbortError: `Something interrupted access to your ${what}.`,
  }

  const friendly = new Error(messages[err.name] ?? `Could not access your ${what}: ${err.message}`)
  friendly.name = err.name
  friendly.cause = err
  return friendly
}
