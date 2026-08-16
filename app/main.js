import { join, generateRoomCode, normalizeRoom, roomFromUrl, inviteUrl, qr, qrPath, probeNat } from 'plaza'
import { LocalMedia, resumeAudio } from 'mirador'

import { CallSession } from './session.js'
import { Stage, FloatChat, qrSvg, unblockAutoplay, onAutoplayBlocked } from './render.js'

const $ = (sel) => document.querySelector(sel)

const media = new LocalMedia()
let session = null
let stage = null
let float = null
let overlayName = null
let roomCode = ''
let natLine = 'this network: not probed'

/**
 * The whole transcript for this session.
 *
 * Floating lines fade so they do not sit on top of anyone's face, but a
 * message that scrolled away with nowhere to go back to is just lost. This is
 * where it goes back to. Still nothing persistent — it dies with the tab.
 */
const history = []

// ---------------------------------------------------------------- landing

const roomInput = $('#room-input')
const nickInput = $('#nick-input')

roomInput.value = roomFromUrl() ?? generateRoomCode()
nickInput.value = localStorage.getItem('tertulia:nick') ?? ''

$('#regenerate').addEventListener('click', () => { roomInput.value = generateRoomCode() })

/**
 * Preview before joining.
 *
 * Asking for the camera on the landing screen rather than after joining means
 * a person sees what they are about to broadcast, and deals with any
 * permission problem while nobody is waiting for them.
 */
async function startPreview() {
  try {
    const stream = await media.start({ audio: true, video: true })
    $('#preview').srcObject = stream
    $('#preview-placeholder').hidden = true
    await populateDevices()
  } catch (err) {
    $('#preview-placeholder').hidden = false
    $('#preview-placeholder').textContent = err.message
  }
}

async function populateDevices() {
  const devices = await media.devices()
  for (const [kind, select] of [['videoinput', $('#camera-select')], ['audioinput', $('#mic-select')]]) {
    select.innerHTML = ''
    for (const device of devices[kind]) {
      const option = document.createElement('option')
      option.value = device.deviceId
      option.textContent = device.label
      option.selected = device.active
      select.append(option)
    }
    select.hidden = devices[kind].length < 2
  }
}

$('#camera-select').addEventListener('change', async (e) => {
  await media.useDevice('videoinput', e.target.value)
  $('#preview').srcObject = media.stream
})
$('#mic-select').addEventListener('change', (e) => media.useDevice('audioinput', e.target.value))

$('#preview-mic').addEventListener('click', () => { media.toggleAudio(); syncPreview() })
$('#preview-cam').addEventListener('click', () => { media.toggleVideo(); syncPreview() })

function syncPreview() {
  $('#preview-mic').classList.toggle('off', !media.audioEnabled)
  $('#preview-cam').classList.toggle('off', !media.videoEnabled)
  $('#preview').style.visibility = media.videoEnabled ? '' : 'hidden'
}

$('#join-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const code = normalizeRoom(roomInput.value)
  if (!code) return

  const nick = nickInput.value.trim() || 'guest'
  localStorage.setItem('tertulia:nick', nick)

  $('#join-button').disabled = true
  $('#join-button').textContent = 'connecting…'

  try {
    await enterCall(code, nick)
  } catch (err) {
    $('#join-button').disabled = false
    $('#join-button').textContent = 'join'
    $('#landing-error').textContent = err.message
  }
})

/**
 * Anything that changes how the connection itself is made.
 *
 * Both of these are settings rather than features, and both exist because
 * connecting two particular networks is not something the app can decide from
 * the inside.
 *
 * `?ice=off` leaves the browser's ICE machinery entirely alone. Every recovery
 * the library performs is a guess about why a handshake was failing, and a
 * guess that fires on one about to succeed makes it worse. Turning the whole
 * apparatus off is the only honest way to find out which it is doing.
 *
 * `?turn=` supplies a relay. Some pairs of networks cannot be joined directly
 * at all — a router that hands out a different port per destination gives a
 * peer an address that is wrong before it is even sent — and no amount of
 * retrying changes that. A relay is the only fix, and since it carries every
 * byte of the call it has to be someone's, which is why there is not one built
 * in.
 *
 * Both persist, so a phone only has to be given them once. Neither is ever put
 * in an invite link: those are shared, and a TURN credential is a password.
 */
/** Which connection settings are in force, so a log says what produced it. */
function modeLine() {
  const opts = connectionOptions()
  const relay = opts.rtcConfig
    ? opts.rtcConfig.iceServers.find((s) => String(s.urls).includes('turn'))
    : null
  // document.lastModified is the served page's mtime, which on this host
  // changes exactly once per deploy. It is in the log because one field test
  // demonstrably ran a stale cached build while a newer one was live, and
  // nothing in the log said so — every conclusion drawn from it was about the
  // wrong code. A log that does not say what produced it is a trap.
  return `settings: discovery ${opts.discovery ?? 'tracker'}`
    + `, recovery ${opts.recover === false ? 'OFF' : 'on'}`
    + `, relay ${relay ? String(relay.urls) : 'none'}`
    + `, page built ${document.lastModified}`
}

function connectionOptions() {
  const params = new URLSearchParams(location.search)

  for (const key of ['turn', 'turnUser', 'turnPass', 'ice', 'discovery']) {
    const value = params.get(key)
    if (value !== null) localStorage.setItem(`tertulia:${key}`, value)
  }
  // ?reset=1 clears everything remembered. Settings persist so a phone only
  // has to be told once, but that means a URL with no parameters can still be
  // running a mode set days ago, with nothing on screen to say so.
  if (params.get('reset') !== null) {
    for (const key of ['turn', 'turnUser', 'turnPass', 'ice', 'discovery']) {
      localStorage.removeItem(`tertulia:${key}`)
    }
  }

  const setting = (key) => localStorage.getItem(`tertulia:${key}`) || ''

  const options = {}
  if (setting('ice') === 'off') options.recover = false

  // Peers are found through BitTorrent trackers unless asked otherwise. A
  // tracker introduces peers itself rather than being a message bus that
  // matchmaking is built on top of, and it carries a complete offer, so
  // nothing can arrive after the description it belongs to. `?discovery=relay`
  // selects Nostr relays, which fail independently — that is the point of
  // having both.
  if (setting('discovery') === 'relay') options.discovery = 'relay'

  const turn = setting('turn')
  if (turn) {
    options.rtcConfig = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun.cloudflare.com:3478' },
        {
          urls: turn.split(',').map((u) => u.trim()).filter(Boolean),
          username: setting('turnUser'),
          credential: setting('turnPass'),
        },
      ],
    }
  }
  return options
}

// ------------------------------------------------------------------- call

async function enterCall(code, nick) {
  roomCode = code
  location.hash = `room=${encodeURIComponent(code)}`

  // Joining is a real click, which is the moment browsers permit audio to
  // start. Any later and every meter silently reads zero.
  await resumeAudio()

  const room = await join({ room: code, appId: 'tertulia', nick, ...connectionOptions() })
  session = new CallSession({ room, media, nick })

  $('#landing').hidden = true
  $('#call').hidden = false
  $('#bar-room').textContent = code

  stage = new Stage($('#stage'))
  stage.onPin = (id) => { session.pin(id); render() }

  // No mobile OS lets a web page capture the screen, so on a phone this
  // button is an invitation to fail. Taking it out also gives the six that do
  // work a seventh more width each, which on a narrow screen is the
  // difference between labels and ellipses.
  if (!LocalMedia.canShareScreen) $('[data-key="s"]').hidden = true

  // Diagnostics were keyboard-only, which meant the one device most likely to
  // be having trouble — a phone — was the one that could not report on it.
  // On touch it takes the slot the share button just gave up.
  if (TOUCH) $('[data-key="d"]').hidden = false

  float = new FloatChat($('#chat-float'))
  // A phone has no key to press, so the hint is only advice on how to fail.
  float.system(TOUCH ? `room ${code}` : `room ${code} · press ? for keys`)

  session.on('change', render)
  session.on('chat', (msg) => { float.append(msg); recordChat(msg) })
  session.on('notice', (text) => { float.system(text); recordChat({ system: true, text }) })

  if (media.stream) {
    room.addStream(media.stream, { kind: 'camera' })
    session.speakers.add('self', media.stream)
  }

  render()
  flashChrome()

  // A handle for the console. Debugging a call means poking at live objects —
  // who a peer thinks is connected, forcing a stream, reading the stats — and
  // there is no way to reach any of it otherwise.
  window.tertulia = { session, room, media, stage }
}

function render() {
  if (!session) return

  const participants = session.participants()
  stage.render(participants, {
    spotlight: session.spotlight(),
    pinned: session.pinned,
    mode: session.layout,
  })

  // The bar carries what dwm's would: where you are, who is here, and what
  // state you are in. Nothing that could be learned by looking at the video.
  $('#bar-tags').textContent = participants
    .map((p, i) => `${i + 1}:${p.nick}${p.id === session.pinned ? '*' : ''}`)
    .join('  ')

  const state = []
  if (!media.audioEnabled) state.push('<span class="off">muted</span>')
  if (!media.videoEnabled) state.push('<span class="off">no cam</span>')
  if (media.screenStream) state.push('sharing')
  if (session.layout !== 'auto') state.push(session.layout)
  $('#bar-state').innerHTML = state.join(' ')

  const worst = participants
    .filter((p) => !p.self && p.net?.rtt != null)
    .map((p) => p.net)
    .sort((a, b) => (b.rtt ?? 0) - (a.rtt ?? 0))[0]

  $('#bar-net').innerHTML = worst
    ? `${worst.relayed ? '<span class="warn">relay</span> ' : ''}${worst.rtt}ms`
    : ''

  $('[data-key="m"]').classList.toggle('off', !media.audioEnabled)
  $('[data-key="v"]').classList.toggle('off', !media.videoEnabled)
  $('[data-key="s"]').classList.toggle('active', !!media.screenStream)
}

// -------------------------------------------------------------- keyboard

/**
 * Everything is reachable from the keyboard, and the keys are bare letters
 * because nothing is competing for them — this is not a text editor, and a
 * call has perhaps a dozen verbs in total.
 *
 * The one modal state is the chat prompt: while it holds focus, letters are
 * letters.
 */
const BINDINGS = {
  m: () => session.toggleAudio(),
  v: () => session.toggleVideo(),
  s: () => session.toggleScreen(),
  Enter: () => openPrompt(),
  h: () => toggleHistory(),
  i: () => toggleOverlay('invite'),
  b: () => document.body.classList.toggle('bar-hidden'),
  d: () => toggleOverlay('diag'),
  f: () => { session.cycleLayout(); render() },
  '?': () => toggleOverlay('help'),
  '/': () => toggleOverlay('help'),
  0: () => { session.pinned = null; render() },
  Q: () => leave(),
}

document.addEventListener('keydown', (e) => {
  if (!session || $('#call').hidden) return
  if (e.metaKey || e.ctrlKey || e.altKey) return

  const active = document.activeElement
  if (active?.tagName === 'INPUT' && !active.closest('[hidden]')) {
    if (e.key === 'Escape') { e.preventDefault(); closePrompt() }
    return
  }

  if (e.key === 'Escape') {
    e.preventDefault()
    if (overlayName) closeOverlay()
    return
  }

  // 1..9 pin the nth participant, the way dwm's tags select a workspace.
  if (/^[1-9]$/.test(e.key)) {
    e.preventDefault()
    const target = session.participants()[Number(e.key) - 1]
    if (target) { session.pin(target.id); render() }
    return
  }

  const action = BINDINGS[e.key]
  if (!action) return
  e.preventDefault()
  action()
})

// Mouse users get the same verbs without having to know the letters.
for (const button of document.querySelectorAll('#controls [data-key]')) {
  button.addEventListener('click', () => BINDINGS[button.dataset.key]?.())
}

async function leave() {
  await session?.leave()
  location.reload()
}

// ----------------------------------------------------------------- chat

function openPrompt() {
  $('#chat-prompt').hidden = false
  document.body.classList.add('prompt-open')
  $('#chat-input').focus()
}

function closePrompt() {
  $('#chat-input').value = ''
  $('#chat-prompt').hidden = true
  document.body.classList.remove('prompt-open')
  $('#chat-input').blur()
}

$('#chat-prompt').addEventListener('submit', (e) => {
  e.preventDefault()
  const text = $('#chat-input').value.trim()
  if (text) session.send(text)
  closePrompt()
})

// -------------------------------------------------------------- history

function recordChat(entry) {
  history.push({ ...entry, at: Date.now() })
  if (history.length > 500) history.shift()
  if (!$('#history').hidden) renderHistory()
}

function toggleHistory() {
  const open = $('#history').hidden
  $('#history').hidden = !open
  document.body.classList.toggle('history-open', open)
  $('[data-key="h"]')?.classList.toggle('active', open)

  if (open) renderHistory()
  // The stage just changed width; ResizeObserver catches it, but doing it here
  // avoids a frame of tiles in the wrong place.
  stage?.layout()
}

function renderHistory() {
  const host = $('#history-lines')
  const atBottom = host.scrollHeight - host.scrollTop - host.clientHeight < 40

  if (history.length === 0) {
    host.innerHTML = '<div class="hist-empty">nothing said yet</div>'
    return
  }

  host.innerHTML = history.map((entry) => entry.system
    ? `<div class="hist-line system">${escapeHtml(entry.text)}</div>`
    : `<div class="hist-line${entry.self ? ' self' : ''}">` +
      `<span class="who">${escapeHtml(entry.nick)}</span> ${escapeHtml(entry.text)}</div>`
  ).join('')

  // Only follow along if the reader was already at the bottom; yanking someone
  // away from what they were reading is rude.
  if (atBottom) host.scrollTop = host.scrollHeight
}

// -------------------------------------------------------------- overlays

function toggleOverlay(name) {
  if (overlayName === name) return closeOverlay()
  overlayName = name
  $('#overlay').hidden = false

  if (name === 'help') showHelp()
  if (name === 'invite') showInvite()
  if (name === 'diag') showDiag()
}

function closeOverlay() {
  // The invite overlay selects its link field for easy copying; anything
  // focused in here must be let go, or a hidden input keeps swallowing every
  // keystroke and the whole keyboard appears dead.
  if ($('#overlay').contains(document.activeElement)) document.activeElement.blur()
  overlayName = null
  $('#overlay').hidden = true
}

$('#overlay').addEventListener('click', (e) => {
  if (e.target === $('#overlay')) closeOverlay()
})

function showHelp() {
  const keys = [
    ['enter', 'say something'],
    ['h', 'chat log'],
    ['m', 'mute / unmute'],
    ['v', 'camera on / off'],
    ...(LocalMedia.canShareScreen ? [['s', 'share screen']] : []),
    ['i', 'invite link and QR'],
    ['1-9', 'pin that participant'],
    ['0', 'unpin'],
    ['f', 'layout: auto / grid / spotlight'],
    ['b', 'show / hide the bar'],
    ['d', 'connection diagnostics'],
    ['?', 'this list'],
    ['shift+Q', 'leave'],
  ]

  $('#overlay-card').innerHTML =
    '<h2>keys</h2><div class="keys">' +
    keys.map(([k, what]) =>
      `<span class="k">${k}</span><span class="d">${what}</span>`).join('') +
    '</div>'
}

/**
 * What the connections have actually been doing.
 *
 * A call that fails does so silently and asymmetrically — one side sees a peer
 * vanish while the other keeps playing video that arrived before the break.
 * Neither person can describe what happened afterwards, so the transitions
 * have to be recorded as they occur and readable on the device that saw them.
 */
function showDiag() {
  const { room } = window.tertulia ?? {}
  if (!room) return

  const peers = [...room.peers.values()].map((p) => {
    const n = p.net ?? {}
    // Two lines, split by direction. Mixing them reads as one healthy
    // connection when in practice only one way round is working, which is
    // the single most confusing thing a call can do.
    return `<div class="diag-peer"><b>${escapeHtml(p.nick || p.id.slice(0, 6))}</b>
      ${n.state ?? '?'} ${n.path ?? ''} ${n.relayed ? 'RELAYED' : ''}
      <br>rtt ${n.rtt ?? '-'}ms · held ${n.playoutDelay ?? '-'}ms · freeze ${n.freezeRatio ?? '-'}%
      <br>in ${n.inboundKbps ?? '-'}kbps loss ${n.packetLoss ?? '-'}%
      · out ${n.outboundKbps ?? '-'}kbps loss ${n.remoteLoss ?? '-'}% jit ${n.remoteJitter ?? '-'}ms</div>`
  }).join('') || '<div class="diag-peer">nobody connected</div>'

  // Both logs, newest first. The transport's covers discovery — everything
  // that happens before a peer exists, which is where a call that never
  // started fails.
  const merged = [...room.log, ...room.transportLog]
    .sort((a, b) => b.at - a.at)
    .slice(0, 60)

  const log = merged.map((e) => {
    const t = new Date(e.at).toLocaleTimeString()
    return `<div class="diag-line"><span class="t">${t}</span>
      <span class="p">${e.peer}</span>
      <span class="w">${escapeHtml(e.what)}</span>
      <span class="d">${escapeHtml(e.detail ?? '')}</span></div>`
  }).join('') || '<div class="diag-line">nothing logged yet</div>'

  $('#overlay-card').innerHTML =
    `<h2>diagnostics</h2>
     <div class="diag-peer" id="diag-mode">${escapeHtml(modeLine())}</div>
     <div class="diag-peer" id="diag-nat">this network: checking…</div>
     ${peers}<div class="diag-log">${log}</div>
     <div class="link-row" style="margin-top:10px">
       <button id="diag-copy" type="button">copy log</button>
     </div>`

  // Asked here rather than at startup: it costs a STUN round trip, and it
  // only matters once somebody is looking at why a call will not connect.
  probeNat({ iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ] }).then((nat) => {
    const el = $('#diag-nat')
    if (!el) return
    const verdict = {
      'endpoint-independent': 'direct connections work',
      'address-dependent': 'DIRECT CONNECTIONS IMPOSSIBLE — needs a relay',
      inconclusive: 'could not tell',
      unknown: 'could not tell',
    }[nat.mapping]
    natLine = `this network: ${nat.mapping} — ${verdict}` +
      (nat.candidates.length ? ` [${nat.candidates.join(' ')}]` : '')
    el.textContent = natLine
  })

  $('#diag-copy').addEventListener('click', async () => {
    // The NAT verdict goes in the copied text too. It is the one line that
    // decides whether a connection failure is worth debugging at all, and it
    // is useless if it only ever appears on a screen nobody screenshots.
    const text = [modeLine(), natLine, ...[...room.log, ...room.transportLog]
      .sort((a, b) => a.at - b.at)
      .map((e) => `${new Date(e.at).toISOString()} ${e.peer} ${e.what} ${e.detail ?? ''}`)].join('\n')
    try {
      await navigator.clipboard.writeText(text)
      $('#diag-copy').textContent = 'copied'
    } catch {
      $('#diag-copy').textContent = 'could not copy'
    }
  })
}

function showInvite() {
  // The mode travels with the invite, but only when it is not the default.
  // Without it a scanned QR silently puts the two devices on different
  // signalling systems, where neither can ever see the other and nothing
  // anywhere says why — and carrying it when it changes nothing produces a
  // link that looks configured when it is not. Credentials are deliberately
  // absent: an invite gets forwarded and screenshotted.
  const discovery = localStorage.getItem('tertulia:discovery')
  const link = inviteUrl(roomCode, undefined, {
    discovery: discovery === 'relay' ? 'relay' : undefined,
  })
  const matrix = qr(link)

  $('#overlay-card').innerHTML = `<h2>invite</h2>
    <div id="invite-qr">${qrSvg(matrix, qrPath(matrix))}</div>
    <div class="link-row">
      <input id="invite-url" readonly value="${escapeHtml(link)}">
      <button id="invite-copy" type="button">copy</button>
    </div>`

  $('#invite-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(link)
      $('#invite-copy').textContent = 'copied'
    } catch {
      $('#invite-url').select()
      $('#invite-copy').textContent = 'select & copy'
    }
    setTimeout(() => ($('#invite-copy').textContent = 'copy'), 1600)
  })
}

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}

// ------------------------------------------------------- chrome autohide

/**
 * Labels and buttons appear on movement and fade again.
 *
 * A permanent control bar costs the same pixels whether or not anyone is
 * reaching for it, and in a call those pixels are somebody's face.
 *
 * Touch is the exception, and has to be: there is no pointer to move, so a
 * control that only appears on movement would never appear at all. On those
 * devices CSS keeps them on permanently and the stage gives up the row.
 */
const TOUCH = matchMedia('(hover: none)').matches
let chromeTimer = null

function flashChrome() {
  if (TOUCH) return
  document.body.classList.add('show-chrome')
  clearTimeout(chromeTimer)
  chromeTimer = setTimeout(() => document.body.classList.remove('show-chrome'), 2400)
}

document.addEventListener('mousemove', flashChrome)

// A touchscreen laptop reports hover: hover, so the controls fade there like
// anywhere else — but there is no pointer to move to bring them back. A tap
// has to count as movement, or those machines are left with no way to reveal
// them. On a real phone this does nothing, since they never hid.
document.addEventListener('touchstart', flashChrome, { passive: true })

// ------------------------------------------------------- control height

/**
 * Publish how tall the control row actually is.
 *
 * On touch the controls are permanent, and the stage has to give up exactly
 * that much room. How much depends on whether they wrapped, which depends on
 * the width of the phone — so it is measured rather than assumed. A guessed
 * constant is wrong on the first device that disagrees with it.
 */
if (window.ResizeObserver) {
  const controls = $('#controls')
  new ResizeObserver(() => {
    document.documentElement.style.setProperty('--controls-h', `${controls.offsetHeight}px`)
    stage?.layout()
  }).observe(controls)
}

// --------------------------------------------------------------- keyboard

/**
 * Keep the chat prompt above the virtual keyboard.
 *
 * A phone's keyboard slides over the layout without the page being told, so a
 * prompt pinned to the bottom ends up underneath it and you type into
 * something you cannot see. The visual viewport does know, and the difference
 * between it and the window is exactly how much is covered.
 */
if (window.visualViewport) {
  const fitKeyboard = () => {
    const vv = window.visualViewport
    const covered = Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
    document.documentElement.style.setProperty('--kb', `${covered}px`)
  }
  visualViewport.addEventListener('resize', fitKeyboard)
  visualViewport.addEventListener('scroll', fitKeyboard)
  fitKeyboard()
}

/**
 * Tapping away abandons the message.
 *
 * On a phone there is no Escape key, so the gesture has to be the obvious one.
 * The prompt itself is excluded, and so is the button that opens it — without
 * that, the very tap that opened the prompt would bubble up here and close it
 * again before a finger had left the glass.
 */
document.addEventListener('pointerdown', (e) => {
  if ($('#chat-prompt').hidden) return
  if (e.target.closest('#chat-prompt')) return
  if (e.target.closest('[data-key="Enter"]')) return
  closePrompt()
})

// -------------------------------------------------------------- autoplay

onAutoplayBlocked((count) => { $('#autoplay-banner').hidden = count === 0 })

$('#autoplay-banner').addEventListener('click', () => {
  unblockAutoplay()
  $('#autoplay-banner').hidden = true
})

// Any click anywhere is enough for the browser; take the chance quietly.
// Audio is retried alongside, because the first attempt at join time often
// times out while the browser is still waiting for a gesture it trusts.
document.addEventListener('click', () => {
  unblockAutoplay()
  resumeAudio()
}, { capture: true })

// ------------------------------------------------------------------ start

syncPreview()
startPreview()

addEventListener('beforeunload', () => session?.leave())
