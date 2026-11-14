// The phone: works out what this phone can do, then it's the fighter picker and a touch gamepad.
import { CHARS, ORDER, picStyle, picture } from './roster.js';

// What this phone can do, worked out before the controller builds anything: full screen and haptics differ by phone.
// Android has the Fullscreen API and navigator.vibrate. iPhone Safari has neither, but goes full screen from the Home
// Screen, and (iOS 18+) plays a haptic tick when a switch input is toggled.
const ua = navigator.userAgent;
// iPadOS asks for desktop sites, so it looks like a Mac with a touch screen
const apple = /iPhone|iPod|iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
// Safari's "Version/18.2" tracks iOS; the "OS 18_2" part is frozen on newer releases
const versionMatch = ua.match(/Version\/(\d+(\.\d+)?)/) || ua.match(/OS (\d+)/);
const iosVersion = versionMatch ? parseFloat(versionMatch[1]) : 0;

function fullscreenSupport() {
  const root = document.documentElement;
  const hasApi = root.requestFullscreen || root.webkitRequestFullscreen;
  const allowed = document.fullscreenEnabled !== false && document.webkitFullscreenEnabled !== false;
  if (hasApi && allowed) return 'api';
  return apple ? 'homescreen' : 'none';
}

function hapticsSupport() {
  if (typeof navigator.vibrate === 'function') return 'vibrate';
  if (apple && iosVersion >= 18 && 'switch' in HTMLInputElement.prototype) return 'ios-switch';
  return 'none';
}

const device = {
  // opened from the Home Screen icon: already full screen
  standalone:
    navigator.standalone === true ||
    matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches,
  fullscreen: fullscreenSupport(),
  haptics: hapticsSupport(),
};

// The hidden switch iOS ticks through, built up front so the first tick isn't late. In the page but invisible:
// display:none would stop the toggle and its tick.
let iosSwitch = null;
if (device.haptics === 'ios-switch') {
  iosSwitch = document.createElement('label');
  iosSwitch.style.cssText =
    'position:fixed;left:-100px;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
  iosSwitch.innerHTML = '<input type="checkbox" switch tabindex="-1">';
  iosSwitch.setAttribute('aria-hidden', 'true');
  document.body.appendChild(iosSwitch);
}
const tick = () => iosSwitch.click();

// pattern: milliseconds on, off, on, ... (or one number), as for navigator.vibrate. iOS can't buzz long or hard: each
// "on" becomes a tick, a strong one a double tick.
let iosBusyUntil = 0;
function haptic(pattern) {
  try {
    if (device.haptics === 'vibrate') navigator.vibrate(pattern);
    if (device.haptics !== 'ios-switch') return;
    const now = performance.now();
    if (now < iosBusyUntil) return; // ticks too close together blur into one
    const times = Array.isArray(pattern) ? pattern : [pattern];
    let when = 0;
    for (let i = 0; i < times.length; i++) {
      if (i % 2 === 0) {
        // the first tick goes now, inside the touch that caused it
        if (when === 0) tick();
        else setTimeout(tick, when);
        if (times[i] >= 60) setTimeout(tick, when + 45);
      }
      when += times[i];
    }
    iosBusyUntil = now + Math.max(30, when);
  } catch {}
}

const $ = (s) => document.querySelector(s);
const NAMES =
  'Mango Pudding Boba Tofu Miso Pebble Biscuit Noodle Peach Kiwi Bean Waffle Olive Pickle Sprout Taro';
const anyOf = (list) => list[Math.floor(Math.random() * list.length)];
// localStorage throws in some private modes
const store = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};
const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ENTITIES[c]);

// Who this phone is: an id that survives reloads, a name and a fighter, all remembered on the phone.
let pid = store.get('ko-pid');
if (!pid) {
  pid = 'p-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  store.set('ko-pid', pid);
}
$('#nm').value = store.get('ko-name') || anyOf(NAMES.split(' '));
const savedPick = store.get('ko-ch');
let pick = CHARS[savedPick] ? savedPick : anyOf(ORDER);

let ws = null;
let joined = false;
let name = '';
let ready = false;
// the pad right now: the stick (-1..1 each way) and the buttons held, as bits
let stickX = 0;
let stickY = 0;
let mask = 0;
// what the big screen was last told, and when
let sentX = 0;
let sentY = 0;
let sentB = 0;
let lastSend = 0;

// Fighter select

const grid = $('#grid');
for (const id of ORDER) {
  const fighter = CHARS[id];
  const el = document.createElement('button');
  el.className = 'fc paper';
  el.dataset.id = id;
  el.style.setProperty('--pick', fighter.color);
  el.innerHTML = `${picture('face', id)}<b>${fighter.name}</b><span>${fighter.role}</span>`;
  grid.appendChild(el);
  el.addEventListener('click', () => choose(id));
}

// A row of five pips, `filled` of them filled in.
function statBar(filled) {
  const pips = [1, 2, 3, 4, 5].map((i) => `<i class="${i <= filled ? 'f' : ''}"></i>`);
  return `<div class="bar">${pips.join('')}</div>`;
}

// How each special is done, in the order of a fighter's kit.
const KIT_INPUTS = ['SPECIAL', 'SIDE +', 'UP +', 'DOWN +'];

function choose(id) {
  pick = id;
  const fighter = CHARS[id];
  for (const el of grid.children) el.classList.toggle('on', el.dataset.id === id);
  const [power, speed, weight] = fighter.bars;
  const kit = KIT_INPUTS.map((input, i) => `<em>${input}</em><span>${fighter.kit[i]}</span>`);
  const info = $('#info');
  info.style.setProperty('--pick', fighter.color);
  info.innerHTML = `<h2>${fighter.name} · ${fighter.role}</h2><p>${fighter.blurb}</p>
    <div class="bars"><span>Power</span>${statBar(power)}<span>Speed</span>${statBar(speed)}<span>Weight</span>${statBar(weight)}</div>
    <div class="kit">${kit.join('')}</div>
    <div class="gen">Everyone: push the stick <b>up</b> to jump, or press <b>Jump</b> (quick tap = short hop) · flick sideways to dash · jump again off walls · <b>Shield + Attack</b> grabs, push the stick to throw</div>`;
}
choose(pick);

// Connection

// One socket at a time. The retry timer and coming back to the foreground can both ask to reconnect, and two live
// sockets would keep knocking each other off the server.
let retryTimer = 0;
let lostAt = 0; // when the connection dropped; 0 while it's up
function connect() {
  if (ws && ws.readyState <= 1) return; // already open, or opening
  clearTimeout(retryTimer);
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${scheme}://${location.host}`);
  ws = socket;
  socket.onopen = () => {
    lostAt = 0;
    socket.send(JSON.stringify({ t: 'join', pid, name, ch: pick }));
    sentB = -1; // so the pad's state goes out again with the next flush
  };
  socket.onmessage = (e) => {
    let m;
    try {
      m = JSON.parse(e.data);
    } catch {
      return;
    }
    if (m.t === 'you') showMe(m);
    else if (m.t === 'hud') setHud(m.pct, m.stocks);
    else if (m.t === 'st') setStatus(m.s, m.who);
    else if (m.t === 'buzz') buzz(m.k);
    else if (m.t === 'note') $('#msg').textContent = m.text;
    else if (m.t === 'res') showResult(m);
    else if (m.t === 'nohost') $('#msg').textContent = 'Waiting for the big screen…';
    else if (m.t === 'full') $('#msg').textContent = 'Game is full — try again soon';
    else if (m.t === 'out') sentHome();
    else if (m.t === 'pong') showPing(performance.now() - m.c);
  };
  socket.onclose = () => {
    if (ws !== socket || !joined) return; // an old socket closing is not news
    if (!lostAt) lostAt = Date.now();
    // a restarted server has a new join link, and this page may be on the old one
    const longGone = Date.now() - lostAt > 10000;
    $('#msg').textContent = longGone
      ? 'Can’t reach the game · scan the code on the big screen again'
      : 'Reconnecting…';
    retryTimer = setTimeout(connect, 800);
  };
}

function send(message) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(message));
}

// The big screen took this fighter out: back to the join screen, one tap from coming back in.
function sentHome() {
  joined = false;
  clearTimeout(retryTimer);
  showSelect();
  $('#go').textContent = 'JOIN';
  $('#select .lbl').textContent = 'The big screen took you out · JOIN to come back';
}

function showMe(m) {
  const fighter = CHARS[m.ch];
  document.documentElement.style.setProperty('--tag', m.tag);
  $('#name').innerHTML = `<i></i>${esc(m.name)} · ${fighter ? fighter.name : ''}`;
  if (fighter) $('#me').style.cssText = picStyle(m.ch, m.color);
  if (typeof m.ready === 'boolean') setReady(m.ready, false);
  setStatus(m.s);
}

// The pad's own buttons (Ready, Fighter, ⇄, full screen) act when the finger lifts, on pointer events: no wait for
// the browser to decide it was a tap, and they keep working while the zoom guard below cancels touch defaults.
function onTap(el, fn) {
  let downId = null; // the pointer that pressed it
  const release = () => el.classList.remove('press');
  el.addEventListener('pointerdown', (e) => {
    downId = e.pointerId;
    el.classList.add('press');
  });
  el.addEventListener('pointerup', (e) => {
    release();
    if (e.pointerId === downId) fn(e);
    downId = null;
  });
  el.addEventListener('pointercancel', () => {
    downId = null;
    release();
  });
  el.addEventListener('pointerleave', release);
  // a click with no pointer behind it came from the keyboard
  el.addEventListener('click', (e) => {
    if (e.detail === 0) fn(e);
  });
}

// Lag to the game server, small in the corner.
let pingAvg = 0;
function showPing(ms) {
  pingAvg = pingAvg ? pingAvg * 0.6 + ms * 0.4 : ms;
  const lag = Math.round(pingAvg);
  let quality = 'bad';
  if (lag < 60) quality = 'good';
  else if (lag < 130) quality = 'ok';
  $('#ping').textContent = `${lag} ms`;
  $('#ping').dataset.q = quality;
}
setInterval(() => {
  if (joined && !document.hidden) send({ t: 'ping', c: performance.now() });
}, 2000);

function setHud(pct, stocks) {
  const el = $('#pct');
  if ($('#pad').dataset.s === 'out') {
    el.innerHTML = 'OUT';
    el.style.color = '';
    $('#stocks').innerHTML = '';
    return;
  }
  // the damage goes from white to red as it climbs to 150%
  const heat = Math.min(1, pct / 150);
  el.innerHTML = `${pct}<small>%</small>`;
  el.style.color = `hsl(${48 - heat * 48} 100% ${100 - heat * 32}%)`;
  $('#stocks').innerHTML = stocks > 0 ? '<i></i>'.repeat(stocks) : '';
}

const STATUS = {
  lobby: 'Warm-up · tap READY',
  ready: 'Get ready…',
  play: 'Fight!',
  wait: 'You’re in the next match',
  ko: 'KO! Back in a sec',
  out: 'Out · back next match',
  win: 'You win! 👑',
};
const KO_BUZZ = [90, 50, 140];

function setStatus(s, who) {
  $('#pad').dataset.s = s;
  let text = STATUS[s] || '';
  if (s === 'over') text = who ? `${who} wins` : 'Draw';
  $('#msg').textContent = text;
  if (s === 'ready' || s === 'play') {
    $('#resLine').classList.remove('show');
    setReady(false, false);
  }
  if (s === 'out') setHud(0, 0);
  if (s === 'ko' || s === 'out') {
    pulse('ko');
    haptic(KO_BUZZ);
  } else if (s === 'win') {
    pulse('win');
    haptic([60, 60, 60, 60, 220]);
  } else if (s === 'ready') {
    haptic(30);
  }
}

// Takes the classes off and makes the browser lay the page out, so adding one back starts its CSS animation over.
function restartAnimation(el, ...classes) {
  el.classList.remove(...classes);
  void el.offsetWidth;
}

// Feedback never covers the controls: the status strip shakes (KO) or swells (win), and hits tint the screen edge.
function pulse(kind) {
  restartAnimation($('#hud'), 'ko', 'win');
  $('#hud').classList.add(kind);
}

function buzz(kind) {
  if (kind === 'hit' || kind === 'bighit') {
    const big = kind === 'bighit';
    haptic(big ? 60 : 18);
    restartAnimation($('#edge'), 'show');
    $('#edge').classList.toggle('big', big);
    $('#edge').classList.add('show');
  } else if (kind === 'ko') {
    pulse('ko');
    haptic(KO_BUZZ);
  } else if (kind === 'pick') {
    haptic([20, 30, 20]);
  } else if (kind === 'warn') {
    haptic([12, 60, 12, 60, 12]); // a stage event is coming: look up
  }
}

// 1st, 2nd, 3rd, 4th ... 11th, 12th, 13th ... 21st
const SUFFIX = { 1: 'st', 2: 'nd', 3: 'rd' };
function ordinal(n) {
  const lastTwo = n % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return n + 'th';
  return n + (SUFFIX[n % 10] || 'th');
}
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// The result folds into the status strip until the next match starts; READY is right below it.
function showResult(m) {
  let head = `<b>${ordinal(m.place)}</b> of ${m.of}`;
  if (m.award) head += ' · ' + esc(m.award);
  const stats = [plural(m.kos, 'KO'), plural(m.falls, 'fall'), `${m.dmg} dmg`, `best combo ${m.combo}`];
  if (m.wins) stats.push(`♛ ${m.wins}`);
  $('#resLine').innerHTML = `${head}<br><span>${stats.join(' · ')}</span>`;
  $('#resLine').classList.add('show');
}

function setReady(on, tell = true) {
  ready = on;
  $('#ready').classList.toggle('on', on);
  $('#ready').textContent = on ? 'READY ✓' : 'READY?';
  if (tell) {
    send({ t: 'ready', on });
    haptic(on ? [20, 40, 20] : 15);
  }
}
onTap($('#ready'), () => setReady(!ready));

// The stick

// In portrait the pad is rotated 90° with CSS so it is always landscape; touch points are turned to match.
function padPoint(e) {
  if (matchMedia('(orientation: portrait)').matches) return { x: e.clientY, y: innerWidth - e.clientX };
  return { x: e.clientX, y: e.clientY };
}
const DEAD = 0.18; // dead zone in the middle; the rest of the travel is stretched back out to 0..1
let stickTouch = null; // the finger on the stick, and where the centre of the base is
let stickRange = 58; // px of thumb travel for a full push
const zone = $('#stickZone');
const base = $('#base');
const knob = $('#knob');
// The range is 13% of the screen's short side, kept between 46 and 100 px.
function sizeStick() {
  const shortSide = Math.min(innerWidth, innerHeight);
  stickRange = Math.round(Math.max(46, Math.min(100, shortSide * 0.13)));
  zone.style.setProperty('--range', stickRange + 'px');
}
sizeStick();
addEventListener('resize', sizeStick);
// Touches are measured on the whole pad, but the base sits inside the stick zone (which is on the right when
// left-handed).
function placeBase(x, y) {
  base.style.left = x - zone.offsetLeft + 'px';
  base.style.top = y - zone.offsetTop + 'px';
}
function capture(el, e) {
  try {
    el.setPointerCapture(e.pointerId);
  } catch {}
}
zone.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (stickTouch) return;
  const point = padPoint(e);
  stickTouch = { id: e.pointerId, x: point.x, y: point.y };
  capture(zone, e);
  base.style.display = 'block';
  placeBase(point.x, point.y);
  $('#stickHint').style.display = 'none';
  knob.style.transform = '';
});
// pointerrawupdate (Chrome) reports the finger as soon as it moves, not once per screen refresh
const MOVE_EVENT = 'onpointerrawupdate' in window ? 'pointerrawupdate' : 'pointermove';
zone.addEventListener(MOVE_EVENT, (e) => {
  if (!stickTouch || e.pointerId !== stickTouch.id) return;
  const point = padPoint(e);
  let dx = (point.x - stickTouch.x) / stickRange;
  let dy = (point.y - stickTouch.y) / stickRange;
  const dist = Math.hypot(dx, dy);
  if (dist > 1) {
    // the base follows the thumb
    dx /= dist;
    dy /= dist;
    stickTouch.x = point.x - dx * stickRange;
    stickTouch.y = point.y - dy * stickRange;
    placeBase(stickTouch.x, stickTouch.y);
  }
  knob.style.transform = `translate(${dx * stickRange}px, ${dy * stickRange}px)`;
  const push = Math.min(1, dist);
  const stretch = push < DEAD ? 0 : (push - DEAD) / (1 - DEAD) / push;
  stickX = dx * stretch;
  stickY = dy * stretch;
  flush(false);
});
function stickUp(e) {
  if (!stickTouch || e.pointerId !== stickTouch.id) return;
  stickTouch = null;
  stickX = 0;
  stickY = 0;
  base.style.display = 'none';
  $('#stickHint').style.display = '';
  flush(true);
}
zone.addEventListener('pointerup', stickUp);
zone.addEventListener('pointercancel', stickUp);

// The buttons

// The four buttons are one touch surface. A finger presses the button it's nearest to (a little outside the edge
// still counts), and sliding onto another switches to it, the way a thumb rolls across a real controller. Drifting
// into a gap keeps the button you were on, so a charge isn't dropped.
const btnBox = $('#btns');
const btnEls = [...btnBox.querySelectorAll('.b')];
const fingers = new Map(); // pointerId -> bit of the button under that finger
function buttonAt(x, y) {
  let nearest = null;
  let nearestDist = 1.5; // in button radii: 1 is the button's edge
  for (const el of btnEls) {
    const r = el.getBoundingClientRect();
    const radius = Math.min(r.width, r.height) / 2;
    const dist = Math.hypot(x - (r.left + r.width / 2), y - (r.top + r.height / 2)) / radius;
    if (dist < nearestDist) {
      nearestDist = dist;
      nearest = el;
    }
  }
  return nearest;
}

// Works out the buttons held from the fingers down, sends that, then lights the buttons up.
function setMask() {
  let held = 0;
  for (const bit of fingers.values()) held |= bit;
  const newlyPressed = held & ~mask;
  mask = held;
  flush(true); // send first, then the rest
  for (const el of btnEls) el.classList.toggle('down', (held & Number(el.dataset.b)) !== 0);
  if (newlyPressed) haptic(8);
}
function fingerOn(e) {
  const el = buttonAt(e.clientX, e.clientY);
  if (!el || Number(el.dataset.b) === fingers.get(e.pointerId)) return;
  fingers.set(e.pointerId, Number(el.dataset.b));
  setMask();
}
function lift(e) {
  if (fingers.delete(e.pointerId)) setMask();
}
btnBox.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  capture(btnBox, e);
  fingerOn(e);
});
btnBox.addEventListener('pointermove', (e) => {
  if (fingers.has(e.pointerId)) fingerOn(e);
});
btnBox.addEventListener('pointerup', lift);
btnBox.addEventListener('pointercancel', lift);

// Buttons go out the instant they change. Stick moves go out at up to 60 a second: at once if the last message was
// 16 ms ago or more, otherwise the newest position goes the moment that gap is up. With nothing changing, a heartbeat
// keeps the big screen's view of the pad current.
const GAP = 16;
const HEARTBEAT = 500;
let trailTimer = 0;
function flush(force) {
  if (!joined) return;
  const now = performance.now();
  const sinceLast = now - lastSend;
  const moved = Math.abs(stickX - sentX) > 0.02 || Math.abs(stickY - sentY) > 0.02;
  const stickDue = moved && (force || sinceLast >= GAP);
  if (mask !== sentB || stickDue || sinceLast > HEARTBEAT) {
    clearTimeout(trailTimer);
    trailTimer = 0;
    send({ t: 'i', x: Number(stickX.toFixed(2)), y: Number(stickY.toFixed(2)), b: mask });
    sentX = stickX;
    sentY = stickY;
    sentB = mask;
    lastSend = now;
  } else if (moved && !trailTimer) {
    trailTimer = setTimeout(() => {
      trailTimer = 0;
      flush(true);
    }, GAP - sinceLast);
  }
}
setInterval(() => flush(false), 250);

// Lets go of everything (the pad is being put away, or the page is going to the background).
function releaseAll() {
  fingers.clear();
  mask = 0;
  stickX = 0;
  stickY = 0;
  flush(true);
  for (const el of btnEls) el.classList.remove('down');
}

// Join, change fighter, the small tools

function showSelect() {
  releaseAll();
  $('#pad').classList.remove('on');
  $('#select').classList.remove('off');
}

function join() {
  name = ($('#nm').value || '').trim().slice(0, 12) || 'Player';
  store.set('ko-name', name);
  store.set('ko-ch', pick);
  $('#nm').blur();
  $('#select').classList.add('off');
  $('#pad').classList.add('on');
  window.scrollTo(0, 0);
  if (joined) {
    send({ t: 'ch', ch: pick });
    return;
  }
  joined = true;
  $('#select .lbl').textContent = 'Pick your fighter';
  $('#name').textContent = name;
  $('#go').textContent = 'DONE';
  connect();
  keepAwake();
  if (device.fullscreen === 'api') goFullscreen(); // inside the JOIN tap, which browsers require
}
$('#go').addEventListener('click', join);
if (new URLSearchParams(location.search).has('demo')) join(); // debug: straight to the pad
$('#nm').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#nm').blur();
});
onTap($('#swap'), showSelect);

// left-handed layout, remembered on this phone
function setHand(lefty) {
  $('#pad').classList.toggle('lefty', lefty);
  store.set('ko-lefty', lefty ? '1' : '');
}
setHand(store.get('ko-lefty') === '1');
onTap($('#hand'), () => {
  setHand(!$('#pad').classList.contains('lefty'));
  haptic(12);
});

async function keepAwake() {
  try {
    await navigator.wakeLock?.request('screen');
  } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') {
    releaseAll();
  } else if (joined) {
    keepAwake();
    if (!ws || ws.readyState > 1) connect();
  }
});

// No zooming, no menus. iOS Safari ignores user-scalable=no, so a double tap or a pinch would zoom the page and wreck
// the controls. On the pad every touch default is cancelled (the controls run on pointer events, which still
// arrive). On the fighter select, which scrolls, only a quick second tap on the same spot is.
const cancel = (e) => e.preventDefault();
const ACTIVE = { passive: false };
$('#pad').addEventListener('touchstart', cancel, ACTIVE);
$('#pad').addEventListener('touchmove', cancel, ACTIVE);
let lastTouch = { timeStamp: 0, target: null };
function cancelSecondTap(e) {
  const secondTap = e.timeStamp - lastTouch.timeStamp < 350 && e.target === lastTouch.target;
  if (secondTap && !e.target.closest('input')) e.preventDefault();
  lastTouch = e;
}
document.addEventListener('touchend', cancelSecondTap, ACTIVE);
for (const type of ['gesturestart', 'gesturechange', 'gestureend', 'dblclick', 'contextmenu']) {
  document.addEventListener(type, cancel, ACTIVE);
}

// Full screen: the Fullscreen API where there is one (Android, iPad), plus a landscape lock where allowed. iPhone
// Safari has none, so there the button explains the Home Screen route instead.
const isFullscreen = () =>
  !!(document.fullscreenElement || document.webkitFullscreenElement) || device.standalone;
function goFullscreen() {
  const el = document.documentElement;
  try {
    const asked = el.requestFullscreen
      ? el.requestFullscreen({ navigationUI: 'hide' })
      : el.webkitRequestFullscreen();
    Promise.resolve(asked)
      .then(() => screen.orientation?.lock?.('landscape'))
      .catch(() => {})
      .finally(syncFullscreenButton);
  } catch {}
}
// The button goes away once the page is full screen (or can't be), and the iPhone tip with it.
function syncFullscreenButton() {
  const fullscreen = isFullscreen();
  $('#fs').hidden = device.fullscreen === 'none' || fullscreen;
  if (fullscreen) $('#fsTip').classList.remove('show');
}
onTap($('#fs'), () => {
  if (device.fullscreen === 'api') goFullscreen();
  else $('#fsTip').classList.toggle('show');
  haptic(12);
});
onTap($('#fsTip'), () => $('#fsTip').classList.remove('show'));
document.addEventListener('fullscreenchange', syncFullscreenButton);
document.addEventListener('webkitfullscreenchange', syncFullscreenButton);
syncFullscreenButton();
