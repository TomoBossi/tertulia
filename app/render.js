import { gridLayout, spotlightLayout } from 'mirador'
import { describeConnection } from 'plaza'

/**
 * Turning the call session into pixels.
 *
 * Everything that touches `document` in this entire stack lives in this file
 * and its siblings. plaza and mirador answer questions with numbers and
 * streams; the answers become elements here.
 */

// --------------------------------------------------------------- autoplay

/**
 * Browsers refuse to play media with sound until the user has interacted with
 * the page. A blocked video is not an error state anywhere visible — the tile
 * simply sits frozen, which looks exactly like a peer whose camera has failed.
 *
 * Every blocked element is remembered so a single click anywhere can release
 * all of them at once.
 */
const blocked = new Set()
let onBlockedChange = () => {}

export function onAutoplayBlocked(fn) { onBlockedChange = fn }

export function attachStream(video, stream) {
  if (video.srcObject === stream) return
  video.srcObject = stream
  if (!stream) return

  video.play().then(() => {
    blocked.delete(video)
    onBlockedChange(blocked.size)
  }).catch((err) => {
    if (err.name !== 'NotAllowedError') return
    blocked.add(video)
    onBlockedChange(blocked.size)
  })
}

/** Release everything the autoplay policy is holding. Call from a click. */
export function unblockAutoplay() {
  const attempts = [...blocked].map((video) =>
    video.play().then(() => blocked.delete(video)).catch(() => {}))

  // The count must be reported after the plays settle, not before. Notifying
  // early leaves the banner on screen over video that is already playing,
  // which reads as the button having failed.
  Promise.allSettled(attempts).then(() => onBlockedChange(blocked.size))
}

// ------------------------------------------------------------------ stage

/**
 * The grid of video tiles.
 *
 * Tiles are reused across renders rather than rebuilt. Replacing a `<video>`
 * element restarts playback, which shows as a black flash on every single
 * participant every time anyone mutes — so elements are keyed and only their
 * position changes.
 */
export class Stage {
  #tiles = new Map()
  #observer

  constructor(root) {
    this.root = root
    this.#observer = new ResizeObserver(() => this.layout())
    this.#observer.observe(root)
    this.state = { participants: [], spotlight: null }
  }

  render(participants, { spotlight = null, pinned = null, mode = 'auto' } = {}) {
    this.state = { participants, spotlight, pinned, mode }

    const wanted = new Set()
    for (const p of participants) {
      const index = participants.indexOf(p) + 1
      for (const kind of ['camera', 'screen']) {
        if (!p.streams?.[kind]) continue
        wanted.add(`${p.id}:${kind}`)
        this.#upsert(p, kind, index, pinned)
      }
      // Somebody with no video at all still needs a tile, or they vanish from
      // the call the moment they turn their camera off.
      if (!p.streams?.camera && !p.streams?.screen) {
        wanted.add(`${p.id}:none`)
        this.#upsert(p, 'none', index, pinned)
      }
    }

    for (const [key, tile] of this.#tiles) {
      if (!wanted.has(key)) {
        tile.el.remove()
        this.#tiles.delete(key)
      }
    }

    this.layout()
  }

  #upsert(participant, kind, index, pinned) {
    const key = `${participant.id}:${kind}`
    let tile = this.#tiles.get(key)

    if (!tile) {
      const el = document.createElement('div')
      el.className = 'tile'

      const video = document.createElement('video')
      video.autoplay = true
      video.playsInline = true
      // Never play our own microphone back at us.
      video.muted = participant.self

      const label = document.createElement('div')
      label.className = 'tile-label'

      const badges = document.createElement('div')
      badges.className = 'tile-badges'

      const placeholder = document.createElement('div')
      placeholder.className = 'tile-placeholder'

      // The number is the handle for the keyboard: press it to pin.
      const idx = document.createElement('div')
      idx.className = 'tile-index'

      el.append(video, placeholder, idx, badges, label)
      el.addEventListener('dblclick', () => this.onPin?.(participant.id))

      this.root.append(el)
      tile = { el, video, label, badges, placeholder, index: idx, kind }
      this.#tiles.set(key, tile)
    }

    const stream = kind === 'none' ? null : participant.streams[kind]
    attachStream(tile.video, stream)

    const hasVideo = !!stream?.getVideoTracks().some((t) => t.readyState === 'live')
    const cameraOff = kind === 'camera' && participant.presence?.videoEnabled === false
    const showVideo = hasVideo && !cameraOff && kind !== 'none'

    tile.video.style.display = showVideo ? '' : 'none'
    tile.placeholder.style.display = showVideo ? 'none' : ''
    tile.placeholder.textContent = initials(participant.nick)

    tile.label.textContent = kind === 'screen'
      ? `${participant.nick} — screen`
      : participant.nick + (participant.self ? ' (you)' : '')

    tile.index.textContent = String(index)
    tile.el.classList.toggle('speaking', !!participant.speaking && kind !== 'screen')
    tile.el.classList.toggle('screen', kind === 'screen')
    tile.el.classList.toggle('pinned', participant.id === pinned)

    // Badges carry the things a person needs at a glance: muted, and whether
    // the connection to them is actually working.
    const marks = []
    if (participant.presence?.audioEnabled === false) marks.push('<span title="muted">muted</span>')

    if (!participant.self && participant.net) {
      const conn = describeConnection(participant.net)
      if (conn.tone !== 'good') {
        marks.push(`<span class="${conn.tone}" title="${escapeAttr(conn.detail)}">${conn.label}</span>`)
      }
    }
    tile.badges.innerHTML = marks.join('')
  }

  /** Position every tile. Pure geometry from mirador, applied as CSS. */
  layout() {
    const { spotlight, mode } = this.state
    const rect = this.root.getBoundingClientRect()
    if (!rect.width || !rect.height) return

    const keys = [...this.#tiles.keys()]
    if (keys.length === 0) return

    // A screen share, or whoever holds the spotlight, gets the big tile —
    // unless the grid layout was chosen explicitly, which overrides both.
    const focusKey = mode === 'grid' ? null : (
      keys.find((k) => k.endsWith(':screen')) ??
      (spotlight ? keys.find((k) => k.startsWith(`${spotlight}:`)) : null)
    )

    const gap = rect.width < 640 ? 6 : 10

    if (focusKey && keys.length > 1) {
      const rest = keys.filter((k) => k !== focusKey)
      const { main, strip } = spotlightLayout({
        count: keys.length,
        width: rect.width,
        height: rect.height,
        gap,
        padding: gap,
      })
      this.#place(focusKey, main)
      rest.forEach((key, i) => this.#place(key, strip[i]))
      return
    }

    // fill rather than letterbox: in a call, bands of black are pixels where
    // somebody's face could have been. Tiles crop via object-fit instead.
    const { positions } = gridLayout({
      count: keys.length,
      width: rect.width,
      height: rect.height,
      gap,
      padding: gap,
      fill: true,
    })
    keys.forEach((key, i) => this.#place(key, positions[i]))
  }

  #place(key, box) {
    const tile = this.#tiles.get(key)
    if (!tile || !box) return
    tile.el.style.transform = `translate(${box.x}px, ${box.y}px)`
    tile.el.style.width = `${box.width}px`
    tile.el.style.height = `${box.height}px`
  }

  destroy() {
    this.#observer.disconnect()
    for (const tile of this.#tiles.values()) tile.el.remove()
    this.#tiles.clear()
  }
}

// ------------------------------------------------------------------- chat

export class FloatChat {
  /**
   * Chat as lines that appear over the video and fade, rather than a panel.
   *
   * A resident chat pane costs its width for the whole call whether or not
   * anyone is typing, and in a call that width is somebody's face. Messages
   * are transient here by design; anyone who needs a transcript is using the
   * wrong tool.
   */
  #lines = []

  constructor(root, { keep = 6, fadeAfter = 12000 } = {}) {
    this.root = root
    this.keep = keep
    this.fadeAfter = fadeAfter
  }

  append(msg) { this.#add(`<span class="who">${escapeHtml(msg.nick)}</span>${escapeHtml(msg.text)}`,
    msg.self ? 'self' : '') }

  system(text) { this.#add(escapeHtml(text), 'system') }

  #add(html, cls) {
    const line = document.createElement('div')
    line.className = `float-line ${cls}`.trim()
    line.innerHTML = html
    this.root.append(line)
    this.#lines.push(line)

    while (this.#lines.length > this.keep) this.#lines.shift()?.remove()

    setTimeout(() => line.classList.add('stale'), this.fadeAfter)
    setTimeout(() => {
      line.remove()
      this.#lines = this.#lines.filter((l) => l !== line)
    }, this.fadeAfter + 800)
  }
}

// ------------------------------------------------------------------ helpers

function initials(name) {
  const parts = String(name ?? '?').trim().split(/[\s-]+/).filter(Boolean)
  if (parts.length === 0) return '?'
  return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase()
}

function escapeHtml(text) {
  return escapeAttr(text)
}

function escapeAttr(text) {
  return String(text ?? '').replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}

/** Render a QR matrix from plaza as an inline SVG. */
export function qrSvg({ size, modules, quiet }, path) {
  const span = size + quiet * 2
  return `<svg viewBox="0 0 ${span} ${span}" role="img" aria-label="Room invite QR code">` +
    `<rect width="${span}" height="${span}" fill="#fff"/>` +
    `<path transform="translate(${quiet},${quiet})" d="${path}" fill="#000"/></svg>`
}
