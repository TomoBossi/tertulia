# Local patches to vendored code

## trystero.mjs — implicit rollback on offer glare

Upstream (trystero 0.25.3, `packages/core/src/peer.ts`), the polite peer
resolves an offer collision with an explicit rollback:

```js
await all([pc.setLocalDescription({type: 'rollback'}), pc.setRemoteDescription(offer)])
```

`makingOffer` is set before its `setLocalDescription` has applied, so a
crossing offer can arrive while `signalingState` is still `stable` — and
rollback from `stable` throws `InvalidStateError`. Upstream treats any signal
failure as fatal and destroys the connection, so two peers that add media
simultaneously — which a call app does on every join — have a
timing-dependent chance of dying ~100ms after connecting. The higher the
signaling latency, the more likely the offers cross: LAN calls almost always
survived, 4G calls often did not.

The patch replaces the explicit rollback with the spec's implicit one —
`setRemoteDescription(offer)` directly, which browsers answer by rolling back
automatically. Verified in Brave: the explicit form throws from `stable`, the
implicit form survives from every state that matters.

Reapply after re-vendoring:

```
old: await oe([r.setLocalDescription({type:"rollback"}),r.setRemoteDescription(k)])
new: await r.setRemoteDescription(k)
```

(The minified local names `oe`/`r`/`k` may differ in a new bundle; the
pattern to find is the rollback+setRemoteDescription pair inside the offer
branch of `signal()`.)

## trystero.mjs — surface the reason a peer was dropped

`exitPeer(id, peer, reason)` receives an Error describing why a peer is being
removed — "peer left room" (a real goodbye), "peer disconnected" (the channel
died), a handshake failure, or a signalling error — and discards it before
notifying the application. Every log therefore reads `leave` with no cause,
which is the single most expensive omission when debugging an intermittent
drop: a deliberate departure and a crash look identical.

The patch passes it through. Reapply after re-vendoring:

```
old: let M=!!c[l];B(l,b),P.destroy(),M&&u.onPeerLeave?.(l),n(l)
new: let M=!!c[l];B(l,b),P.destroy(),M&&u.onPeerLeave?.(l,b),n(l)
```

(`u.onPeerLeave` is the room's listener, `b` the reason. Minified names may
differ in a new bundle; the site is `exitPeer`, distinguishable by the
`peerMap`/`activePeerMap` lookups and the `destroy()` call.)

## trystero.mjs — a bad ICE candidate must not kill the connection

The candidate branch of `signal()` routes any failure to `handlers.error`,
and the room turns that into `exitPeer()` — the peer is destroyed. So a single
candidate that cannot be applied ends a working call.

Candidates failing to apply is normal. Trickle ICE keeps sending them after a
pair has already been nominated, renegotiation can move the ufrag underneath
one in flight, and duplicates arrive whenever the same candidate travels two
paths. WebRTC's own reference implementation of perfect negotiation
(webrtc/samples, peerconnection/perfect-negotiation) treats these as
ignorable:

```js
try { await pc.addIceCandidate(candidate) }
catch (e) { if (!ignoreOffer) throw e }
```

The patch drops the error report so a candidate failure is ignored rather than
fatal. Everything that actually matters — the channel closing, the connection
failing — is reported through other paths and still tears the peer down.

Reapply after re-vendoring: find the catch block in the candidate branch of
`signal()` carrying the message "failed to parse remote candidate" and make it
an empty catch.

## trystero.mjs — a peer with a slow clock must not become invisible

Nostr subscriptions filter on `since`, taken from the subscriber's clock,
against `created_at`, taken from the publisher's. Upstream subscribes with
`since: now()`, so a peer whose clock runs even slightly behind ours has
everything it publishes — announcements, offers, candidates — dropped by the
relay before it reaches us. In one direction only, for the whole session.

Measured against a live relay:

```
clock-in-sync            DELIVERED
publisher-5s-behind      DROPPED BY RELAY
publisher-60s-behind     DROPPED BY RELAY
publisher-30s-ahead      DELIVERED
```

Five seconds is nothing. A phone and a desktop routinely differ by more, and
the drift changes as each device re-syncs — which is what makes the resulting
failure look random, device-pair-specific, and one-directional: the faster peer
sees the slower one and offers; the slower one never hears the reply and shows
nothing, while the faster one sits on a half-open attempt reading "connecting".

The patch subtracts ten minutes of slack. These are ephemeral events, which
relays do not store, so a wider window receives no backlog — it only stops
excluding.

Reapply after re-vendoring: both subscription builders in the nostr strategy
(the single-topic `REQ` and the batched flush) take `since: <now>()`; subtract
600 from each.
