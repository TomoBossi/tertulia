/**
 * Working out where video tiles go — as arithmetic, not as elements.
 *
 * This is the clearest demonstration that a media library need not touch the
 * DOM. "Five people, a 1200x800 area, 16:9 tiles" has one best answer, and
 * finding it is geometry. Whether the answer becomes a CSS grid, absolutely
 * positioned divs, a canvas, or a WebGL scene is entirely the caller's
 * business, and every one of those callers wants the same numbers.
 */

/**
 * Lay out `count` tiles to fill a box as fully as possible.
 *
 * The method is brute force, and deliberately so: try every column count from
 * 1 to `count`, work out how large the tiles could be in that arrangement, and
 * keep the best. There is a closed-form approximation, but it gets the awkward
 * cases wrong — three tiles in a wide box, five in a tall one — and the search
 * space here is at most a few dozen possibilities in a function that runs on
 * resize. Clarity is worth more than the microseconds.
 *
 * @param {{
 *   count: number, width: number, height: number,
 *   aspect?: number, gap?: number, padding?: number, maxScale?: number,
 *   fill?: boolean,
 * }} opts
 * @returns {{
 *   cols: number, rows: number, tileWidth: number, tileHeight: number,
 *   positions: {x: number, y: number, width: number, height: number}[],
 * }}
 */
export function gridLayout({
  count,
  width,
  height,
  aspect = 16 / 9,
  gap = 8,
  padding = 0,
  // A single participant filling a 4K window is not the intent; cap how large
  // a tile may grow relative to the container.
  maxScale = 1,
  // When true, tiles consume the container completely and take whatever
  // aspect that implies, rather than keeping `aspect` and letterboxing.
  // `aspect` still guides which grid is chosen, so tiles stay as close to the
  // preferred shape as filling allows. Pair it with `object-fit: cover` so
  // video crops rather than stretches.
  fill = false,
}) {
  const empty = { cols: 0, rows: 0, tileWidth: 0, tileHeight: 0, positions: [] }
  if (!count || count < 1 || width <= 0 || height <= 0) return empty

  const innerW = Math.max(0, width - padding * 2)
  const innerH = Math.max(0, height - padding * 2)
  if (innerW <= 0 || innerH <= 0) return empty

  if (fill) return fillGrid({ count, innerW, innerH, aspect, gap, padding })

  let best = null

  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols)

    // Tile size is whichever of the two constraints binds first: fitting the
    // columns across, or fitting the rows down.
    const byWidth = (innerW - gap * (cols - 1)) / cols
    const byHeight = ((innerH - gap * (rows - 1)) / rows) * aspect
    const tileWidth = Math.min(byWidth, byHeight)

    if (tileWidth <= 0) continue

    const area = tileWidth * (tileWidth / aspect)
    if (!best || area > best.area) {
      best = { cols, rows, tileWidth, area }
    }
  }

  if (!best) return empty

  const tileWidth = Math.min(best.tileWidth, innerW * maxScale)
  const tileHeight = tileWidth / aspect

  // Centre the whole block, then centre any short final row within it, so a
  // trailing tile does not sit awkwardly against the left edge.
  const gridW = best.cols * tileWidth + gap * (best.cols - 1)
  const gridH = best.rows * tileHeight + gap * (best.rows - 1)
  const originX = padding + (innerW - gridW) / 2
  const originY = padding + (innerH - gridH) / 2

  const positions = []
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / best.cols)
    const col = i % best.cols

    const inThisRow = Math.min(best.cols, count - row * best.cols)
    const rowW = inThisRow * tileWidth + gap * (inThisRow - 1)
    const rowX = padding + (innerW - rowW) / 2

    positions.push({
      x: rowX + col * (tileWidth + gap),
      y: originY + row * (tileHeight + gap),
      width: tileWidth,
      height: tileHeight,
    })
  }

  return { cols: best.cols, rows: best.rows, tileWidth, tileHeight, positions }
}

/**
 * Lay tiles out so they consume the container completely.
 *
 * The grid is still chosen by how close its cells come to the preferred
 * aspect — a 3x1 row of very wide cells is worse than a 2x2 of nearly-correct
 * ones — but once chosen, the cells are stretched to leave no gaps. This is
 * what a tiling window manager does, and in a video call the alternative is
 * bands of black where somebody's face could have been.
 */
function fillGrid({ count, innerW, innerH, aspect, gap, padding }) {
  let best = null

  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols)
    const cellW = (innerW - gap * (cols - 1)) / cols
    const cellH = (innerH - gap * (rows - 1)) / rows
    if (cellW <= 0 || cellH <= 0) continue

    // Compared in log space so being twice as wide and half as wide score
    // equally badly, which they should.
    const distortion = Math.abs(Math.log(cellW / cellH) - Math.log(aspect))
    if (!best || distortion < best.distortion) {
      best = { cols, rows, cellW, cellH, distortion }
    }
  }

  if (!best) return { cols: 0, rows: 0, tileWidth: 0, tileHeight: 0, positions: [] }

  const positions = []
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / best.cols)
    const col = i % best.cols

    // A short final row spreads across the full width rather than leaving a
    // hole, which is what makes the result look deliberate rather than broken.
    const inThisRow = Math.min(best.cols, count - row * best.cols)
    const rowCellW = (innerW - gap * (inThisRow - 1)) / inThisRow

    positions.push({
      x: padding + col * (rowCellW + gap),
      y: padding + row * (best.cellH + gap),
      width: rowCellW,
      height: best.cellH,
    })
  }

  return {
    cols: best.cols,
    rows: best.rows,
    tileWidth: best.cellW,
    tileHeight: best.cellH,
    positions,
  }
}

/**
 * One large tile with the rest in a strip beside or below it.
 *
 * What a screen share wants, and what a call wants when one person is doing
 * the talking. The strip is capped at a fraction of the container so a busy
 * room cannot squeeze the thing you are meant to be looking at.
 *
 * @param {{
 *   count: number, width: number, height: number, aspect?: number,
 *   gap?: number, padding?: number, side?: 'right'|'bottom'|'auto',
 *   stripFraction?: number,
 * }} opts
 */
export function spotlightLayout({
  count,
  width,
  height,
  aspect = 16 / 9,
  gap = 8,
  padding = 0,
  side = 'auto',
  stripFraction = 0.22,
}) {
  const others = Math.max(0, count - 1)
  if (count < 1 || width <= 0 || height <= 0) {
    return { main: null, strip: [], side: 'right' }
  }

  if (others === 0) {
    const only = gridLayout({ count: 1, width, height, aspect, gap, padding })
    return { main: only.positions[0] ?? null, strip: [], side: 'right' }
  }

  // A wide container gets a column beside the spotlight; a tall one gets a row
  // beneath it. Choosing by shape rather than by preference keeps phones in
  // portrait from ending up with a uselessly thin sidebar.
  const chosen = side === 'auto' ? (width >= height ? 'right' : 'bottom') : side

  const innerW = width - padding * 2
  const innerH = height - padding * 2

  if (chosen === 'right') {
    const stripW = Math.min(innerW * stripFraction, 260)
    const mainW = innerW - stripW - gap

    const main = fit(padding, padding, mainW, innerH, aspect)
    const strip = gridLayout({
      count: others,
      width: stripW,
      height: innerH,
      aspect,
      gap,
    }).positions.map((p) => ({ ...p, x: p.x + padding + mainW + gap, y: p.y + padding }))

    return { main, strip, side: chosen }
  }

  const stripH = Math.min(innerH * stripFraction, 180)
  const mainH = innerH - stripH - gap

  const main = fit(padding, padding, innerW, mainH, aspect)
  const strip = gridLayout({
    count: others,
    width: innerW,
    height: stripH,
    aspect,
    gap,
  }).positions.map((p) => ({ ...p, x: p.x + padding, y: p.y + padding + mainH + gap }))

  return { main, strip, side: chosen }
}

/** Centre a box of a given aspect inside a rectangle. */
function fit(x, y, width, height, aspect) {
  let w = width
  let h = w / aspect
  if (h > height) {
    h = height
    w = h * aspect
  }
  return { x: x + (width - w) / 2, y: y + (height - h) / 2, width: w, height: h }
}

/**
 * How much video to send, given how many people will receive it.
 *
 * In a mesh every participant uploads one copy per peer, so the cost of your
 * camera is multiplied by the size of the room.
 *
 * `maxBitrateKbps` matters more than the resolution, and is the field to act
 * on. Resolution alone caps nothing: an encoder given 720p and no ceiling will
 * spend as much bandwidth on it as the sender's uplink appears to allow, which
 * says nothing about whether the *receiver* can decode it. A laptop on good
 * broadband will happily bury a budget phone, and when that phone's decoder
 * falls behind, the encoding and the keepalives that hold the connection open
 * are starved along with it — so the call does not degrade, it dies.
 *
 * The ladder is deliberately conservative. Softer video is a mild
 * disappointment; a dropped call is not, and the sender cannot see which one
 * it is about to cause.
 *
 * @param {number} peerCount how many others will receive the stream
 * @returns {{width: number, height: number, frameRate: number,
 *            maxBitrateKbps: number, estimatedKbps: number}}
 */
export function videoProfileFor(peerCount) {
  const others = Math.max(0, peerCount)

  if (others <= 1) return { width: 960, height: 540, frameRate: 30, maxBitrateKbps: 700, estimatedKbps: 700 }
  if (others <= 3) return { width: 640, height: 360, frameRate: 30, maxBitrateKbps: 500, estimatedKbps: 500 }
  if (others <= 5) return { width: 480, height: 270, frameRate: 24, maxBitrateKbps: 350, estimatedKbps: 350 }
  return { width: 320, height: 180, frameRate: 15, maxBitrateKbps: 200, estimatedKbps: 200 }
}

/**
 * Estimate what a room will cost this participant in upload bandwidth.
 *
 * Worth showing a user before they turn their camera on in a room of six. The
 * arithmetic is unforgiving and entirely invisible until it bites.
 */
export function estimateUpload({ peerCount, video = true, audio = true, screen = false }) {
  const others = Math.max(0, peerCount)
  const profile = videoProfileFor(others)

  const perPeer =
    (video ? profile.estimatedKbps : 0) +
    (audio ? 32 : 0) +
    (screen ? 1200 : 0)

  return {
    perPeerKbps: perPeer,
    totalKbps: perPeer * others,
    profile,
  }
}
