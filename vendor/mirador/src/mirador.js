/**
 * mirador — a headless browser media toolkit.
 *
 * Getting audio and video out of a browser, working out who is speaking, and
 * deciding where the tiles go. No DOM, no networking, no dependencies.
 *
 *   import { LocalMedia, gridLayout, SpeakerTracker } from 'mirador'
 *
 *   const media = new LocalMedia()
 *   const stream = await media.start({ audio: true, video: true })
 *
 *   media.on('state', s => console.log(s.audioEnabled ? 'live' : 'muted'))
 *   media.toggleAudio()
 *
 *   const { positions } = gridLayout({ count: 5, width: 1200, height: 800 })
 *   // → five {x, y, width, height} boxes. Draw them however you like.
 *
 * # Independent on purpose
 *
 * mirador does not know what a peer is and has never heard of WebRTC. It pairs
 * naturally with a transport such as plaza — one finds you a stream, the other
 * carries it — but neither imports the other, and mirador is just as useful in
 * a webcam test page, a local screen recorder or a device picker that never
 * touches the network.
 *
 * That independence is a property, not an aspiration: nothing in this package
 * imports anything outside it.
 *
 * # Why headless
 *
 * Every piece here answers a question with a value rather than an element.
 * `gridLayout` returns rectangles, not divs. `meter` returns a number, not a
 * green ring. Two applications wanting completely different interfaces still
 * want exactly the same answers, and the moment a `querySelector` appears in
 * here they stop being able to share them.
 */

export { LocalMedia, describeMediaError } from './core/media.js'
export { meter, resumeAudio, SpeakerTracker } from './core/levels.js'
export { gridLayout, spotlightLayout, videoProfileFor, estimateUpload } from './core/layout.js'
export { Emitter } from './core/emitter.js'

/** Library version. Bump on release; git tags are what consumers pin to. */
export const VERSION = '0.1.0'
