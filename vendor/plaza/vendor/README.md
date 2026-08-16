# Vendored code

Two libraries, both here because the browser does not provide what they do and
reimplementing either would be a bad trade.

## secp256k1.mjs — @noble/secp256k1 v3.1.0

BIP-340 Schnorr signing, required to publish Nostr events. Getting elliptic
curve arithmetic subtly wrong produces signatures that every relay rejects
silently, which is indistinguishable from a network that is not delivering.

To update:

    curl -sL https://cdn.jsdelivr.net/npm/@noble/secp256k1@3.1.0/+esm -o vendor/secp256k1.mjs

Check afterwards that a public key is 32 bytes and a signature is 64. Anything
else means the wrong scheme.

## qrcode-generator.mjs

QR encoding, for turning an invite into something a phone can scan. Requires
Reed-Solomon coding over GF(256), mask selection and format-information bits,
whose failure mode is a code that scans on one phone and not another.

Only the encoder is vendored; `src/core/invite.js` turns its output into an SVG
path, so nothing here touches the DOM.
