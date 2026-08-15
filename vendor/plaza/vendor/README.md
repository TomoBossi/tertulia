# Vendored code

## secp256k1.mjs — @noble/secp256k1 v3.1.0

BIP-340 Schnorr signing, which Nostr requires and browsers do not provide. It
is here because reimplementing a signature scheme to avoid a dependency is a
bad trade at any size — 11KB of audited code against the cost of getting
elliptic curve arithmetic subtly wrong, where the failure mode is signatures
that every relay silently rejects.

Nothing else is vendored. The transport that used to live here — trystero,
58KB minified, carrying four hand-applied patches against code nobody could
read — was replaced by `src/signal/`. Those patches were: an illegal rollback
on offer glare, a failed ICE candidate being treated as fatal, a dropped peer
never saying why, and a subscription window that made any peer with a slow
clock invisible. Each had to be reapplied by hand on every re-vendor, against
minified identifiers that change between builds. That maintenance is gone
along with the bundle.

To update: fetch the ESM build and check the primitive still behaves.

    curl -sL https://cdn.jsdelivr.net/npm/@noble/secp256k1@3.1.0/+esm -o vendor/secp256k1.mjs

A BIP-340 public key is 32 bytes and a signature is 64. Anything else means
the wrong scheme, and the symptom is a network that appears not to deliver.
