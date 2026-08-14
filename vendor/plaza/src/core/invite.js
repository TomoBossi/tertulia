import qrcode from '../../vendor/qrcode-generator.mjs'

/**
 * Room codes and invitations.
 *
 * Everything here is data. `qr()` returns a grid of booleans, not an `<svg>`;
 * `inviteUrl()` returns a string, not an anchor. Turning either into something
 * visible is the render layer's job, and keeping that line sharp is what lets
 * plaza run in a Worker, in Node, or in a test with no browser at all.
 */

// Chosen to be unambiguous when read aloud over a call, which is how these
// codes actually get shared. No words that rhyme with each other, nothing that
// sounds like a letter, nothing that autocorrect mangles.
const ADJECTIVES = [
  'amber', 'brisk', 'calm', 'dusty', 'eager', 'fuzzy', 'gentle', 'hidden',
  'ivory', 'jolly', 'keen', 'lucky', 'mellow', 'noble', 'olive', 'proud',
  'quiet', 'rapid', 'silver', 'tidy', 'urban', 'vivid', 'warm', 'zesty',
]

const NOUNS = [
  'otter', 'falcon', 'cactus', 'harbor', 'lantern', 'meadow', 'nebula',
  'pebble', 'quartz', 'ripple', 'sparrow', 'thistle', 'walnut', 'yarrow',
  'anchor', 'bramble', 'cobalt', 'dune', 'ember', 'fjord',
]

/**
 * Generate a room code such as `amber-otter-42`.
 *
 * Roughly 24 x 20 x 90 = 43,200 combinations. That is nowhere near enough to
 * be a secret, and is not meant to be — it exists so two people can agree on a
 * room over a phone call without spelling out a hash. Anyone who learns the
 * code can join, exactly like a link to a shared document. Use `password` on
 * the room if that matters.
 */
export function generateRoomCode(random = Math.random) {
  const pick = (list) => list[Math.floor(random() * list.length)]
  const number = 10 + Math.floor(random() * 90)
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}-${number}`
}

/** True if a string looks like something we would have generated. */
export function isRoomCode(value) {
  return /^[a-z]+-[a-z]+-\d{2}$/.test(String(value ?? '').trim())
}

/**
 * Normalise whatever a person typed or pasted into a room name.
 *
 * People paste the whole invite link as often as they type the code, so accept
 * both. Case and surrounding whitespace are discarded, since the same room
 * typed two ways must be the same room.
 */
export function normalizeRoom(input) {
  const raw = String(input ?? '').trim()
  if (!raw) return ''

  // A full URL: take the room out of the hash or the query.
  if (/^https?:\/\//i.test(raw)) {
    try {
      return roomFromUrl(raw) ?? ''
    } catch {
      return ''
    }
  }

  return raw.toLowerCase().replace(/\s+/g, '-')
}

/** Build the shareable link for a room. */
export function inviteUrl(room, base = globalThis.location?.href ?? '') {
  const url = new URL(base || 'https://example.invalid/')
  url.hash = `room=${encodeURIComponent(room)}`
  url.search = ''
  return url.toString()
}

/**
 * Extract a room from a URL.
 *
 * The hash is checked before the query string on purpose: a fragment is never
 * sent to the server hosting the page, so a room code placed there stays out
 * of access logs and referrer headers.
 */
export function roomFromUrl(href = globalThis.location?.href ?? '') {
  const url = new URL(href)

  const hash = new URLSearchParams(url.hash.replace(/^#/, ''))
  const fromHash = hash.get('room')
  if (fromHash) return decodeURIComponent(fromHash)

  const fromQuery = url.searchParams.get('room')
  return fromQuery ? decodeURIComponent(fromQuery) : null
}

/**
 * Encode text as a QR code, returned as a square grid of booleans.
 *
 * `true` means a dark module. Rendering is entirely the caller's problem,
 * which is the point — the same matrix becomes an SVG in a browser, a PNG in a
 * canvas, or block characters in a terminal.
 *
 * @param {string} text
 * @param {{errorCorrection?: 'L'|'M'|'Q'|'H', quiet?: number}} [opts]
 * @returns {{size: number, modules: boolean[][], quiet: number}}
 */
export function qr(text, { errorCorrection = 'M', quiet = 2 } = {}) {
  // Type 0 lets the encoder choose the smallest version that fits.
  const code = qrcode(0, errorCorrection)
  code.addData(String(text))
  code.make()

  const size = code.getModuleCount()
  const modules = []

  for (let row = 0; row < size; row++) {
    const line = new Array(size)
    for (let col = 0; col < size; col++) line[col] = code.isDark(row, col)
    modules.push(line)
  }

  return { size, modules, quiet }
}

/**
 * Render a QR matrix as an SVG path string.
 *
 * This is a string, not an element, so it stays on the headless side of the
 * line — the caller drops it into markup however it likes. Every dark module
 * becomes one subpath, which keeps the result small and scales cleanly.
 */
export function qrPath({ size, modules }) {
  let path = ''
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (modules[row][col]) path += `M${col} ${row}h1v1h-1z`
    }
  }
  return path
}
