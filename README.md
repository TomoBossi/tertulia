# tertulia

Join video calls with no server, no account, and no install. Type the same room
code as your peers and you will be directly connected to each other.

### **[tomobossi.github.io/tertulia](https://tomobossi.github.io/tertulia/)**

---

## Keys

The video fills the screen and everything else stays out of the way. Move the
mouse for buttons if you would rather not.

```
enter     say something — enter again sends, escape cancels
h         chat log
m         mute / unmute
v         camera on / off
s         share screen
i         invite link and QR
1–9       pin that participant
0         unpin
f         cycle layout: auto, grid, spotlight
b         show / hide the bar
d         connection diagnostics
?         this list
shift+Q   leave
```

On a phone the buttons stay put, tapping *chat* opens the keyboard, and tapping
anywhere else abandons the message.

## What to expect

**Four people on video is comfortable, six is a stretch.** Everyone sends their
video separately to everyone else, so a fourth participant costs you 4.5 Mbps of
upload where a second cost 1.5. That is why Zoom runs servers. Quality steps
down as the room fills, which softens the wall rather than removing it. Audio
scales much further — a dozen people cost about 300 kbps.

**Roughly one pair in eight cannot connect directly,** usually two mobile
networks. The tile is badged `relayed` or `cannot connect` rather than going
quietly silent. Fixing it needs a relay, which costs real bandwidth, so there
isn't one.

**Screen sharing does not work on phones or tablets.** Not on iOS, and not on
Android either — capturing the screen needs a permission no mobile OS gives a
web page, so it is not a browser you can switch away from. Phones can join and
send camera and microphone; they cannot present.

**Nothing is stored.** No recordings, no accounts, nothing written anywhere. The
chat log lives in the tab and dies with it. Nobody can record a call centrally
because there is no centre.

## License

MIT
