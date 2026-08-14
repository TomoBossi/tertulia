# tertulia

A video call with no server, no account and no install. Type the same code as
your friends and you are connected **directly to each other**.

A *tertulia* is a gathering held for the purpose of talking. That is the whole
product.

---

## The interface is the video

Most call apps spend a third of the screen on chrome — a header, a sidebar, a
control bar — all of it resident whether or not you are reaching for it. In a
call those pixels are somebody's face.

tertulia borrows from tiling window managers instead:

- **Video fills the viewport.** Tiles consume the whole area with no
  letterboxing and no gaps.
- **One 22-pixel bar** shows where you are, who is here and your state. Press
  <kbd>b</kbd> and it is gone.
- **No resident controls.** Buttons appear when the mouse moves and fade again.
- **Chat floats and fades** over the video rather than occupying a panel.
- **Everything is on the keyboard.**

```
m         mute / unmute
v         camera on / off
s         share screen
c         chat — enter sends, escape cancels
p         who is here
i         invite link and QR
1–9       pin that participant
0         unpin
f         cycle layout: auto, grid, spotlight
b         show / hide the bar
?         the list
shift+Q   leave
```

Mouse users are not abandoned — move the mouse and the controls appear — but
nothing is resident, and nothing has to be.

## Running it

Any static host will do; there is no backend to deploy.

```sh
python3 tools/serve.py        # http://localhost:8802
```

That server exists because browsers cache ES modules aggressively, and during
development that means editing a library, reloading, and debugging a bug you
already fixed. It sends `no-store` on everything.

For production, push to GitHub Pages. Media capture needs a secure context, so
`https://` or `localhost` — opening `index.html` from disk will fail with a
permissions error that does not explain itself.

## What it is built on

Two headless libraries, both vendored so nothing outside this repository has to
be up:

| | |
|---|---|
| [plaza](https://github.com/TomoBossi/plaza) | peer-to-peer rooms: peers, presence, chat, data channels, diagnostics |
| [mirador](https://github.com/TomoBossi/mirador) | media: capture, devices, speaker detection, layout geometry |

Neither imports the other, and neither touches the DOM. **Every `document` call
in the entire stack lives in this repository**, in `app/render.js` and
`app/main.js`.

`app/session.js` is the piece worth pointing at: it decides who gets the big
tile, what a screen share does to the layout, and how participants are ordered.
Those are *product* decisions, not library ones — a games room would want the
board centre stage with faces shrunk to a strip, and baking either rule into a
shared library would force the other to fight it with configuration flags.

Refresh the vendored copies with:

```sh
./tools/sync-libs.sh
```

While developing the libraries alongside the app, point the import map in
`index.html` at `../plaza/src/plaza.js` and `../mirador/src/mirador.js`
instead. That is the entire difference between local development and shipping.

---

## What to expect

**Four people on video is comfortable. Six is a stretch.**

Every participant sends their video separately to every other participant, so
your upload multiplies by the size of the room:

| Participants | Your upload |
|---|---|
| 2 | 1.5 Mbps |
| 4 | 4.5 Mbps |
| 6 | 7.5 Mbps |

This is why Zoom and Meet run servers: one upload instead of many. tertulia
steps video quality down as the room grows, which turns a collapse into a
gradual softening, but arithmetic is arithmetic. **Audio scales much further** —
a dozen people cost about 300 kbps.

**Roughly one pair in eight cannot connect directly.** Usually two mobile
networks. Instead of a mysterious silence, the tile says `relayed` or `cannot
connect` and the people list explains why. Fixing it needs a TURN relay, which
costs real bandwidth and is therefore not included.

**Screen sharing does not work on iOS.** Safari does not implement it. iPhones
can join and send camera and microphone, but cannot present.

**Nothing is stored.** No recordings, no transcript, no history, no accounts.
Chat is deliberately transient. Nobody can record it centrally because there is
no centre — which is a real claim that Zoom cannot make, and the reason not to
add a server later without thinking hard about it.

## Layout

```
index.html          markup and the import map
style.css           everything visual
app/main.js         wiring, keyboard model, overlays
app/session.js      the call model: spotlight, pinning, ordering, bandwidth
app/render.js       tiles, floating chat, autoplay handling
vendor/             plaza and mirador, pinned copies
tools/serve.py      dev server with caching disabled
tools/sync-libs.sh  refresh the vendored libraries
```

## License

MIT
