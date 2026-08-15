/**
 * Nostr events, signed here rather than borrowed.
 *
 * This is the last thing plaza needed another library for, and it is about
 * forty lines: build an event, hash it in the exact canonical form the
 * protocol specifies, sign the hash. The signature scheme is BIP-340 Schnorr
 * over secp256k1, which browsers do not provide, so that one primitive is
 * vendored — 11KB of audited code against the 58KB bundle previously carried
 * to reach it.
 *
 * The canonical form is the part worth being careful about. An event's id is
 * the SHA-256 of a JSON *array* in a fixed order — not of the object, and not
 * of any other ordering — and relays recompute it to check the signature.
 * Getting the shape wrong produces events that are silently rejected by every
 * relay, which looks exactly like a network that is not delivering.
 */
import { schnorr } from '../../vendor/secp256k1.mjs'

/**
 * A fresh identity per page load.
 *
 * Nothing is signed *as* anyone here: the key exists so relays can verify that
 * an event has not been tampered with in transit, and a room's membership is
 * established by decrypting its payload, not by this key. A per-session key
 * is therefore the private choice as well as the simple one — a stable one
 * would let relay operators link a person's rooms together over time.
 */
const { secretKey, publicKey } = schnorr.keygen()

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')

export const pubkey = hex(publicKey)

/**
 * Ephemeral event kinds, derived from the topic.
 *
 * The 20000-29999 range is defined as ephemeral: relays forward these and do
 * not store them, which is exactly right for signalling. Deriving the kind
 * from the topic spreads rooms across the range so a relay's per-kind
 * handling cannot bottleneck on one number.
 */
export const kindFor = (topic) =>
  ([...topic].reduce((sum, c) => sum + c.charCodeAt(0), 0) % 10_000) + 20_000

const sha256 = async (text) =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))

/** Build a signed event, ready to publish. */
export async function createEvent(topic, content) {
  const event = {
    kind: kindFor(topic),
    tags: [['x', topic]],
    created_at: Math.floor(Date.now() / 1000),
    content,
    pubkey,
  }

  // The canonical serialisation, exactly as the protocol defines it. Relays
  // recompute this to verify the signature, so the order is not ours to
  // choose.
  const id = await sha256(JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]))

  return JSON.stringify(['EVENT', {
    ...event,
    id: hex(id),
    sig: hex(await schnorr.signAsync(id, secretKey)),
  }])
}

/**
 * Build a subscription request.
 *
 * `since` carries generous slack deliberately. A relay filters it against the
 * publisher's clock, not ours, and two devices never agree on the time to the
 * second — so asking for "everything from now" makes every peer whose clock
 * runs slower than ours permanently invisible, in one direction only, for the
 * whole session. Measured against live relays: a publisher five seconds behind
 * is silently discarded. These events are not stored, so a wider window
 * receives no backlog; it only stops excluding.
 */
export function subscriptionFor(subId, topic, slackSeconds = 600) {
  return JSON.stringify(['REQ', subId, {
    kinds: [kindFor(topic)],
    since: Math.floor(Date.now() / 1000) - slackSeconds,
    '#x': [topic],
  }])
}
