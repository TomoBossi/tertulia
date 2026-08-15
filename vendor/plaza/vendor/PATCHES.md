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
