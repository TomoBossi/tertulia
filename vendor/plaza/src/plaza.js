/**
 * plaza — a headless peer-to-peer room for the browser.
 *
 * People who type the same room code end up connected directly to each other,
 * with no server of yours anywhere in the picture. plaza gives you the room,
 * the people in it, their media, a chat channel, and arbitrary data channels
 * for whatever else you want to build. What any of it looks like is entirely
 * up to you.
 *
 *   import { join, generateRoomCode } from 'plaza'
 *
 *   const room = await join({ room: generateRoomCode(), presence: { nick: 'ana' } })
 *
 *   room.on('peer:join',   peer => console.log(peer.nick, 'arrived'))
 *   room.on('peer:stream', (peer, stream) => attachSomewhere(stream))
 *   room.on('chat',        msg  => append(msg.nick, msg.text))
 *
 *   room.addStream(someMediaStream, { kind: 'camera' })
 *
 * # No DOM, ever
 *
 * Nothing in this library touches `document`. It hands you `MediaStream`
 * objects and tells you when things change; rendering is somebody else's
 * problem. That constraint is the whole reason it is reusable — the moment a
 * `querySelector` appears in here, plaza is welded to one application's markup
 * and the next application has to fork it.
 *
 * The rule holds even where it would be convenient. `qr()` returns a grid of
 * booleans rather than an `<svg>`; `inviteUrl()` returns a string rather than
 * an anchor.
 *
 * # What plaza deliberately does not do
 *
 * There is no camera in this library, no mute button and no video grid.
 * Capturing media, deciding what to send and working out how to lay it out are
 * call concerns, and they live a layer up — which is what lets a chess room and
 * a video call share this same foundation. plaza will carry a MediaStream to
 * your peers; it will not go and find you one.
 *
 * # Building something other than a call
 *
 * Two kinds of channel, for two genuinely different needs:
 *
 * - `room.channel(name)` is reliable and ordered — right for turn-based games,
 *   where a move must arrive, and must arrive after the one before it.
 *
 * - `room.dataChannel(label, opts)` is a raw, optionally unreliable channel —
 *   right for realtime netcode, where a retransmission costs a round trip you
 *   were trying to hide and a late packet is worse than a lost one.
 *
 * # Scale
 *
 * Peers form a full mesh, so anything you broadcast is sent once per
 * participant and upload grows with the room. That is cheap for chat and game
 * moves, and expensive for video: four people is comfortable, six is a
 * stretch, and beyond that you need a server to fan streams out.
 */

export { Room, join } from './core/room.js'
export { Emitter } from './core/emitter.js'
export { watchConnection, describeConnection, probeNat } from './core/diagnostics.js'

export {
  generateRoomCode,
  isRoomCode,
  normalizeRoom,
  inviteUrl,
  roomFromUrl,
  qr,
  qrPath,
} from './core/invite.js'

export { selfId } from '../vendor/trystero.mjs'

/** Library version. Bump on release; git tags are what consumers pin to. */
export const VERSION = '0.1.0'
