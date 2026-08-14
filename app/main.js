import { join, generateRoomCode, normalizeRoom, roomFromUrl, inviteUrl, qr, qrPath } from 'plaza'
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

// ------------------------------------------------------------------- call

async function enterCall(code, nick) {
  roomCode = code
  location.hash = `room=${encodeURIComponent(code)}`

  // Joining is a real click, which is the moment browsers permit audio to
  // start. Any later and every meter silently reads zero.
  await resumeAudio()

  const room = await join({ room: code, appId: 'tertulia', nick })
  session = new CallSession({ room, media, nick })

  $('#landing').hidden = true
  $('#call').hidden = false
  $('#bar-room').textContent = code

  stage = new Stage($('#stage'))
  stage.onPin = (id) => { session.pin(id); render() }

  float = new FloatChat($('#chat-float'))
  float.system(`room ${code} · press ? for keys`)

  session.on('change', render)
  session.on('chat', (msg) => float.append(msg))
  session.on('notice', (text) => float.system(text))

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

  if (overlayName === 'people') showPeople()
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
  c: () => openPrompt(),
  p: () => toggleOverlay('people'),
  i: () => toggleOverlay('invite'),
  b: () => document.body.classList.toggle('bar-hidden'),
  f: () => { session.cycleLayout(); render() },
  '?': () => toggleOverlay('help'),
  '/': () => toggleOverlay('help'),
  0: () => { session.pinned = null; render() },
  Q: () => leave(),
}

document.addEventListener('keydown', (e) => {
  if (!session || $('#call').hidden) return
  if (e.metaKey || e.ctrlKey || e.altKey) return

  if (document.activeElement?.tagName === 'INPUT') {
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
  $('#chat-input').focus()
}

function closePrompt() {
  $('#chat-input').value = ''
  $('#chat-prompt').hidden = true
  $('#chat-input').blur()
}

$('#chat-prompt').addEventListener('submit', (e) => {
  e.preventDefault()
  const text = $('#chat-input').value.trim()
  if (text) session.send(text)
  closePrompt()
})

// -------------------------------------------------------------- overlays

function toggleOverlay(name) {
  if (overlayName === name) return closeOverlay()
  overlayName = name
  $('#overlay').hidden = false

  if (name === 'help') showHelp()
  if (name === 'people') showPeople()
  if (name === 'invite') showInvite()
}

function closeOverlay() {
  overlayName = null
  $('#overlay').hidden = true
}

$('#overlay').addEventListener('click', (e) => {
  if (e.target === $('#overlay')) closeOverlay()
})

function showHelp() {
  const keys = [
    ['m', 'mute / unmute'],
    ['v', 'camera on / off'],
    ['s', 'share screen'],
    ['c', 'chat — enter sends, escape cancels'],
    ['p', 'who is here'],
    ['i', 'invite link and QR'],
    ['1–9', 'pin that participant'],
    ['0', 'unpin'],
    ['f', 'cycle layout: auto, grid, spotlight'],
    ['b', 'show / hide the bar'],
    ['?', 'this list'],
    ['shift+Q', 'leave'],
  ]

  $('#overlay-card').innerHTML =
    '<h2>keys</h2><div class="keys">' +
    keys.map(([k, what]) => `<kbd>${k}</kbd><span>${what}</span>`).join('') +
    '</div><p class="overlay-note">Double-click a tile to pin it. Move the mouse for buttons.</p>'
}

function showPeople() {
  const rows = session.participants().map((p, i) => {
    const marks = []
    if (p.presence?.audioEnabled === false) marks.push('muted')
    if (p.presence?.sharingScreen) marks.push('sharing')
    if (p.net?.relayed) marks.push('relayed')
    if (p.net?.rtt != null) marks.push(`${p.net.rtt}ms`)

    return `<div class="roster-row${p.id === session.pinned ? ' pinned' : ''}" data-id="${p.id}">
      <span>${i + 1}. ${escapeHtml(p.nick)}${p.self ? ' (you)' : ''}</span>
      <span class="roster-marks">${marks.join(' · ')}</span></div>`
  }).join('')

  $('#overlay-card').innerHTML = `<h2>people</h2>${rows}
    <p class="overlay-note">Click, or press 1–9 to pin. 0 unpins.</p>`

  for (const row of $('#overlay-card').querySelectorAll('.roster-row')) {
    row.addEventListener('click', () => { session.pin(row.dataset.id); render() })
  }
}

function showInvite() {
  const link = inviteUrl(roomCode)
  const matrix = qr(link)

  $('#overlay-card').innerHTML = `<h2>invite</h2>
    <div id="invite-qr">${qrSvg(matrix, qrPath(matrix))}</div>
    <div class="link-row">
      <input id="invite-url" readonly value="${escapeHtml(link)}">
      <button id="invite-copy" type="button">copy</button>
    </div>
    <p class="overlay-note">Anyone with this link can join — there is no other
    access control, the same as a link to a shared document.</p>`

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
 */
let chromeTimer = null

function flashChrome() {
  document.body.classList.add('show-chrome')
  clearTimeout(chromeTimer)
  chromeTimer = setTimeout(() => document.body.classList.remove('show-chrome'), 2400)
}

document.addEventListener('mousemove', flashChrome)
document.addEventListener('touchstart', flashChrome, { passive: true })

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
