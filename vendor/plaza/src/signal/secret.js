/**
 * Keeping the handshake off the relays' record.
 *
 * Signalling carries ICE candidates, and ICE candidates carry the IP address
 * of everyone in the room. Publishing those in the clear to several strangers'
 * servers is a worse privacy posture than the app deserves, so the payloads
 * are encrypted.
 *
 * Be clear about what this does and does not buy. Without a room password the
 * key derives from the app and room names alone, so anyone who knows the room
 * code can read the traffic — which is exactly the set of people who can join
 * anyway. It hides the room's contents from relay operators and passers-by,
 * not from participants. A password raises it to real secrecy, and is worth
 * setting for that reason.
 */

const ITERATIONS = 100_000

/**
 * Derive the room's key.
 *
 * PBKDF2 over the password with the room identity as salt: the same room
 * always derives the same key, and two rooms never share one even under the
 * same password.
 */
export async function roomKey({ appId, roomId, password = '' }) {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  )

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: new TextEncoder().encode(`plaza/${appId}/${roomId}`),
      iterations: ITERATIONS,
      hash: 'SHA-256',
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/**
 * Encrypt to a base64 string carrying its own nonce.
 *
 * AES-GCM must never reuse a nonce under one key, so each message gets a fresh
 * random one, prefixed to the ciphertext. Twelve bytes is the standard size
 * and random collision is not a practical concern at signalling volumes.
 */
export async function seal(key, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plain = new TextEncoder().encode(JSON.stringify(value))
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain))

  const joined = new Uint8Array(iv.length + cipher.length)
  joined.set(iv)
  joined.set(cipher, iv.length)
  return btoa(String.fromCharCode(...joined))
}

/**
 * Decrypt, returning null for anything that does not open.
 *
 * A failure here is ordinary: relays carry traffic for every room sharing a
 * topic hash, and a message from a room whose password differs is simply not
 * ours. Treating that as an error would fill the log with other people's mail.
 */
export async function open(key, text) {
  try {
    const raw = Uint8Array.from(atob(text), (c) => c.charCodeAt(0))
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: raw.slice(0, 12) },
      key,
      raw.slice(12),
    )
    return JSON.parse(new TextDecoder().decode(plain))
  } catch {
    return null
  }
}
