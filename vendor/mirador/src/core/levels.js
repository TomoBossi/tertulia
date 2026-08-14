/**
 * Measuring how loudly a stream is speaking.
 *
 * This is what "the tile with the green ring is the person talking" is built
 * on, and it belongs here rather than in a render layer because it produces a
 * number, not a highlight. Web Audio has no DOM dependency at all.
 *
 * The measurement is deliberately not a raw volume reading. Raw amplitude
 * flickers violently between syllables, so a highlight driven by it strobes.
 * What comes out instead is a smoothed level with hysteresis, which is the
 * difference between an indicator that tracks a conversation and one that
 * looks broken.
 */

/** One AudioContext shared by every meter. Browsers cap how many you may open. */
let sharedContext = null

function context() {
  if (!sharedContext) {
    const Ctor = globalThis.AudioContext ?? globalThis.webkitAudioContext
    if (!Ctor) throw new Error('mirador: Web Audio is not available in this browser')
    sharedContext = new Ctor()
  }
  return sharedContext
}

/**
 * Browsers suspend an AudioContext created before any user interaction.
 *
 * Call this from a click handler — joining a room is the natural place — or
 * every meter will silently read zero and nobody will ever appear to be
 * speaking.
 *
 * The timeout is not defensive padding; it is load-bearing. When a browser is
 * waiting for a user gesture, `resume()` returns a promise that **never
 * settles** — it does not reject, it simply stays pending forever. A caller
 * that awaits it before doing anything else deadlocks, with no error to
 * explain why. Racing it against a timer is the only way to get control back.
 *
 * Check the return value: `'running'` means audio is live, `'suspended'` means
 * the browser is still waiting for a gesture and this is worth calling again
 * from the next real click.
 *
 * @returns {Promise<'running'|'suspended'|'closed'|'unavailable'>}
 */
export async function resumeAudio({ timeout = 1000 } = {}) {
  try {
    const ctx = context()
    if (ctx.state !== 'suspended') return ctx.state

    await Promise.race([
      ctx.resume(),
      new Promise((resolve) => setTimeout(resolve, timeout)),
    ])
    return ctx.state
  } catch {
    return 'unavailable'
  }
}

/**
 * Watch a stream's loudness.
 *
 * @param {MediaStream} stream
 * @param {{
 *   onLevel?: (level: number) => void,
 *   onSpeaking?: (speaking: boolean) => void,
 *   interval?: number, threshold?: number, release?: number,
 * }} [opts]
 * @returns {() => void} call to stop measuring
 */
export function meter(stream, {
  onLevel,
  onSpeaking,
  interval = 100,
  // Above this, someone is talking. Below `release`, they have stopped. The
  // gap between the two is what stops the indicator chattering on and off
  // during the natural pauses inside a sentence.
  threshold = 0.06,
  release = 0.03,
} = {}) {
  const tracks = stream?.getAudioTracks?.() ?? []
  if (tracks.length === 0) return () => {}

  let ctx
  try {
    ctx = context()
  } catch {
    return () => {}
  }

  const source = ctx.createMediaStreamSource(stream)
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 512
  // Web Audio's own smoothing, applied before we do our own.
  analyser.smoothingTimeConstant = 0.6
  source.connect(analyser)

  const samples = new Float32Array(analyser.fftSize)
  let smoothed = 0
  let speaking = false

  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(samples)

    // Root mean square, which tracks perceived loudness far better than peak
    // amplitude — one loud click should not read as speech.
    let sum = 0
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
    const rms = Math.sqrt(sum / samples.length)

    // Rise quickly, fall slowly: speech should light up immediately and fade
    // out, rather than tracking every gap between words.
    smoothed = rms > smoothed
      ? smoothed + (rms - smoothed) * 0.6
      : smoothed + (rms - smoothed) * 0.15

    onLevel?.(Math.min(1, smoothed * 4))

    const next = speaking ? smoothed > release : smoothed > threshold
    if (next !== speaking) {
      speaking = next
      onSpeaking?.(speaking)
    }
  }, interval)

  return () => {
    clearInterval(timer)
    try { source.disconnect() } catch { /* context may be gone */ }
    try { analyser.disconnect() } catch { /* context may be gone */ }
  }
}

/**
 * Track who is speaking across a whole room.
 *
 * Meters are attached and detached as streams come and go, so the caller only
 * has to feed it peers and read the result.
 */
export class SpeakerTracker {
  #meters = new Map()
  #levels = new Map()
  #speaking = new Set()
  #onChange

  constructor({ onChange } = {}) {
    this.#onChange = onChange
  }

  /** Begin measuring a participant's stream. */
  add(id, stream) {
    this.remove(id)
    if (!stream) return

    const stop = meter(stream, {
      onLevel: (level) => this.#levels.set(id, level),
      onSpeaking: (isSpeaking) => {
        if (isSpeaking) this.#speaking.add(id)
        else this.#speaking.delete(id)
        this.#onChange?.(this.loudest(), [...this.#speaking])
      },
    })
    this.#meters.set(id, stop)
  }

  remove(id) {
    this.#meters.get(id)?.()
    this.#meters.delete(id)
    this.#levels.delete(id)
    this.#speaking.delete(id)
  }

  level(id) { return this.#levels.get(id) ?? 0 }
  speaking(id) { return this.#speaking.has(id) }

  /** The participant currently speaking most loudly, or null. */
  loudest() {
    let best = null
    let bestLevel = 0
    for (const id of this.#speaking) {
      const level = this.#levels.get(id) ?? 0
      if (level > bestLevel) {
        best = id
        bestLevel = level
      }
    }
    return best
  }

  destroy() {
    for (const stop of this.#meters.values()) stop()
    this.#meters.clear()
    this.#levels.clear()
    this.#speaking.clear()
  }
}
