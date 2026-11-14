// Everything that steers a fighter: the keyboard, gamepads, and phones through the relay server.
import { CHARS } from './roster.js';
import {
  $,
  addBot,
  addPlayer,
  BTN,
  changeChar,
  fighterAfter,
  G,
  PAD,
  players,
  randomFighter,
  removePlayer,
  setButtons,
  startCountdown,
} from './game.js';
import { cycleStage, esc, feed, frontKey, frontPad, menuKey, setMode, toggleMenu } from './ui.js';
import { ac, rumble, setVolumes, sfx, wake } from './sound.js';

// The link to the relay server: phones join and send input, the host sends back HUD updates, buzzes and results.

let ws = null;
const isPhone = (p) => !p.bot && !p.kb;
const isPad = (id) => id.startsWith('pad-');

function send(m) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(m));
}

// Message to one player's phone. A gamepad has no phone, but it can feel the buzzes.
export function tell(p, m) {
  if (m.t === 'buzz' && isPad(p.id)) rumble(p.id, m.k);
  if (isPhone(p)) send({ t: 'to', id: p.id, m });
}

// Takes a fighter out from the big screen. A phone is sent back to its join screen.
export function dismiss(p) {
  if (isPhone(p)) send({ t: 'kick', id: p.id });
  removePlayer(p.id);
}

function phoneScreen(p) {
  if (G.state === 'play') return p.alive ? 'play' : 'wait';
  if (G.state === 'countdown' && p.alive) return 'ready';
  return 'lobby';
}

export function tellYou(p) {
  tell(p, {
    t: 'you',
    color: p.color,
    tag: p.tag,
    name: p.name,
    ch: p.ch,
    s: phoneScreen(p),
    ready: p.ready,
  });
}

// stocks -1: not in a match
export function tellHud(p) {
  const inMatch = (G.state === 'play' || G.state === 'countdown') && p.inMatch;
  tell(p, { t: 'hud', pct: Math.round(p.pct), stocks: inMatch ? p.stocks : -1 });
}

export function connect() {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${scheme}://${location.host}`);
  ws.onopen = () => {
    if (G.offlineSince) loadInfo(); // a restarted server has a new join link
    G.offlineSince = 0;
    send({ t: 'host' });
  };
  ws.onmessage = onMessage;
  ws.onclose = () => {
    if (G.moved) return;
    if (!G.offlineSince) G.offlineSince = performance.now();
    setTimeout(connect, 1000);
  };
}

// This page can't be (or is no longer) the big screen: say why and go quiet, instead of fighting over the seat.
function standDown(why) {
  G.moved = true;
  $('#offline').textContent = why;
  $('#offline').classList.add('show');
  if (ac) ac.suspend();
  for (const p of [...players.values()]) if (isPhone(p)) removePlayer(p.id);
}

function onMessage(e) {
  let m;
  try {
    m = JSON.parse(e.data);
  } catch {
    return;
  }
  if (m.t === 'join') {
    if (!G.mode) setMode('phones'); // a phone scanned in from the title: that settles how we're playing
    addPlayer(m.id, m.name, m.ch);
  } else if (m.t === 'leave') {
    removePlayer(m.id);
  } else if (m.t === 'replaced') {
    standDown('The game was opened in another tab. Reload this one to play here instead.');
  } else if (m.t === 'denied') {
    standDown(`This page can't be the big screen. Open ${m.at} on the computer running the game.`);
  }

  // the rest comes from a phone that has joined
  const p = players.get(m.id);
  if (!p) return;
  if (m.t === 'i') {
    p.in.x = m.x;
    p.in.y = m.y;
    setButtons(p, m.b | 0);
  } else if (m.t === 'ch') {
    changeChar(p, m.ch);
  } else if (m.t === 'ready') {
    p.ready = !!m.on;
    G.hudDirty = true;
    if (p.ready) sfx.ready();
  }
}

// The join card: QR code, link and a warning when phones can't reach us. Polled, so a dropped tunnel or a restarted
// server never leaves a dead QR code on screen.
let infoTimer = 0;
export async function loadInfo() {
  clearTimeout(infoTimer);
  let wait = 2000;
  try {
    const response = await fetch('/info');
    const info = await response.json();
    const qr = `/qr.svg?u=${encodeURIComponent(info.joinUrl)}`;
    const address = info.joinUrl.replace(/^https?:\/\//, '');
    for (const img of [$('#qr'), $('#title .qr2')]) if (img.getAttribute('src') !== qr) img.src = qr;
    $('#url').textContent = address;
    $('#title .url2').textContent = address;

    let warning = '';
    if (info.tunnelPending) warning = 'Opening join link…';
    else if (info.tunnelDown) warning = 'Join link is down · reconnecting (VPN or network change?)';
    else if (!info.secure) warning = 'Phones must be on the same Wi-Fi';
    $('#warn').textContent = warning;
    $('#warn').style.display = warning ? 'block' : 'none';
    if (!info.tunnelPending && !info.tunnelDown) wait = 10000;
  } catch {
    // server not answering: try again soon
  }
  infoTimer = setTimeout(loadInfo, wait);
}

// Big-screen input: keyboard players, gamepads (Gamepad API) and host keys (Enter, B/N, T, Esc, M). The title and the
// keyboard fighter select get first look at every key and button (ui.js).

// Two players share the keyboard. Up is jump: tap it for a short hop, hold it for a full jump, press it again in the
// air to double jump. Up with Attack or Special still aims the move upward.
const KEYBOARDS = [
  {
    id: 'kb-wasd',
    name: 'WASD',
    left: 'KeyA',
    right: 'KeyD',
    up: 'KeyW',
    down: 'KeyS',
    attack: 'KeyF',
    special: 'KeyG',
    shield: 'KeyH',
    nextFighter: 'KeyQ',
  },
  {
    id: 'kb-arrows',
    name: 'Arrows',
    left: 'ArrowLeft',
    right: 'ArrowRight',
    up: 'ArrowUp',
    down: 'ArrowDown',
    attack: 'KeyK',
    special: 'KeyL',
    shield: 'Semicolon',
    nextFighter: 'KeyP',
  },
];
const fightKeys = (kb) => [kb.left, kb.right, kb.up, kb.down, kb.attack, kb.special, kb.shield];

const keysDown = new Set();
const axis = (negative, positive) => (keysDown.has(positive) ? 1 : 0) - (keysDown.has(negative) ? 1 : 0);

// Turns the keys held right now into each keyboard player's stick and buttons.
function readKeyboards() {
  // on the fighter select the keys move cursors, not fighters
  const onSelect = G.mode === 'keys' && G.state === 'lobby';
  for (const kb of KEYBOARDS) {
    const p = players.get(kb.id);
    if (!p) continue;
    if (onSelect) {
      p.in.x = p.in.y = p.in.b = 0;
      continue;
    }
    p.in.x = axis(kb.left, kb.right);
    p.in.y = axis(kb.up, kb.down);
    setButtons(
      p,
      (keysDown.has(kb.attack) ? BTN.A : 0) |
        (keysDown.has(kb.special) ? BTN.S : 0) |
        (keysDown.has(kb.shield) ? BTN.D : 0),
    );
  }
}

// Queues the next fighter in the roster for this player (straight away in the lobby, else for the next match).
function cycleFighter(p) {
  changeChar(p, fighterAfter(p.nextCh || p.ch));
  if (p.nextCh) feed(`${esc(p.name)}: ${CHARS[p.nextCh].name} next match`);
}

function toggleMute() {
  G.muted = !G.muted;
  setVolumes();
  feed(G.muted ? 'Sound off' : 'Sound on');
}

// USB and Bluetooth gamepads: stick or d-pad moves, A (or Y) jumps, the right trigger (or X) attacks, the left trigger
// (or B) is the special, the bumpers shield, Start pauses, View changes fighter. On the title, the fighter select and
// the results the buttons work the screen instead (frontPad); in the pause menu the stick chooses, A picks, B closes.
const STICK_DEADZONE = 0.22;
const TRIGGER_PULL = 0.35; // how far a trigger has to be squeezed to count: a resting finger shouldn't attack
const MENU_PUSH = 0.55; // how far the stick has to lean to count as a push in menus
const wasDown = new Map(); // per pad: which buttons were down last frame
const wasLeaning = new Map(); // per pad: which way the stick or d-pad leaned last frame, as [x, y]
// Per pad: buttons pressed while a screen or menu had the controller. They stay out of the fight until let go, so the
// A that closed the menu doesn't also jump.
const spent = new Map();
const oddLayouts = new Set(); // pads already told that their buttons may be mixed up
// A controller that drops out keeps its fighter for a while (Bluetooth pads blink and fall asleep): the fighter
// stands still and carries on when the pad is back. Only after the wait is the fighter taken out.
const PAD_WAIT_IN_MATCH = 15; // seconds
const PAD_WAIT_IN_LOBBY = 3;
const lostAt = new Map(); // per pad: when it dropped out, in ms
const usable = (pad) => pad && pad.connected !== false && pad.buttons.length >= 10;

function forgetPad(id) {
  wasDown.delete(id);
  wasLeaning.delete(id);
  spent.delete(id);
}

// Called for every pad fighter whose controller isn't there this frame.
function padMissing(p, now) {
  if (!lostAt.has(p.id)) {
    lostAt.set(p.id, now);
    forgetPad(p.id);
    p.in.x = p.in.y = p.in.b = 0;
    feed(`${esc(p.name)}: controller dropped out · press a button on it to carry on`);
    return;
  }
  const inMatch = (G.state === 'play' || G.state === 'countdown') && p.inMatch;
  const wait = inMatch ? PAD_WAIT_IN_MATCH : PAD_WAIT_IN_LOBBY;
  if (now - lostAt.get(p.id) > wait * 1000) {
    lostAt.delete(p.id);
    removePlayer(p.id);
  }
}

function lean(negative, positive, stick) {
  if (negative || stick < -MENU_PUSH) return -1;
  if (positive || stick > MENU_PUSH) return 1;
  return 0;
}

function padMenu(pressed, pushX, pushY) {
  if (pressed(PAD.START) || pressed(PAD.B)) toggleMenu(false);
  else if (pressed(PAD.A)) menuKey('Enter');
  else if (pushY) menuKey(pushY < 0 ? 'ArrowUp' : 'ArrowDown');
  else if (pushX) menuKey(pushX < 0 ? 'ArrowLeft' : 'ArrowRight');
}

// Called every frame: reads every gamepad (and the keyboard, so keys held through a screen change count at once).
export function padUpdate() {
  if (G.moved) return;
  readKeyboards();
  const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
  const here = new Set();
  for (const pad of pads) if (usable(pad)) here.add(`pad-${pad.index}`);
  const now = performance.now();
  for (const p of [...players.values()]) {
    if (!isPad(p.id)) continue;
    if (!here.has(p.id)) {
      padMissing(p, now);
    } else if (lostAt.has(p.id)) {
      lostAt.delete(p.id);
      feed(`${esc(p.name)}: controller is back`);
    }
  }
  for (const pad of pads) {
    if (!usable(pad)) continue;
    const id = `pad-${pad.index}`;
    const down = pad.buttons.map((b, i) =>
      i === PAD.LT || i === PAD.RT ? b.value > TRIGGER_PULL : b.pressed,
    );
    const before = wasDown.get(id) || [];
    wasDown.set(id, down);
    const pressed = (i) => down[i] && !before[i];
    const anyPressed = down.some((isDown, i) => isDown && !before[i]);

    // menus and the fighter select move once per push, not for as long as the stick is held
    const leanX = lean(down[PAD.LEFT], down[PAD.RIGHT], pad.axes[0] || 0);
    const leanY = lean(down[PAD.UP], down[PAD.DOWN], pad.axes[1] || 0);
    const [lastX, lastY] = wasLeaning.get(id) || [0, 0];
    wasLeaning.set(id, [leanX, leanY]);
    const pushX = leanX !== lastX ? leanX : 0;
    const pushY = leanY !== lastY ? leanY : 0;

    if (!spent.has(id)) spent.set(id, new Set());
    const spentButtons = spent.get(id);
    for (const i of spentButtons) if (!down[i]) spentButtons.delete(i);
    const spendAll = () => {
      for (let i = 0; i < down.length; i++) if (down[i]) spentButtons.add(i);
    };

    if (anyPressed) {
      wake();
      if (pad.mapping !== 'standard' && !oddLayouts.has(id)) {
        oddLayouts.add(id);
        feed(
          'This browser reads that controller oddly: buttons may be swapped. Chrome or Edge know it best.',
        );
      }
    }
    if (G.paused) {
      padMenu(pressed, pushX, pushY);
      spendAll();
      continue;
    }
    if (frontPad(id, pressed, pushX)) {
      spendAll();
      continue;
    }
    if (pressed(PAD.START)) {
      toggleMenu(true);
      spendAll();
      continue;
    }

    let p = players.get(id);
    if (!p) {
      // the phone lobby and its matches: a controller joins with any button
      if (!anyPressed) continue;
      p = addPlayer(id, `Pad ${pad.index + 1}`, randomFighter(), { kb: true });
      if (!p) continue;
      spendAll();
    }
    if (pressed(PAD.SELECT)) cycleFighter(p);

    let x = pad.axes[0] || 0;
    let y = pad.axes[1] || 0;
    if (Math.hypot(x, y) < STICK_DEADZONE) x = y = 0;
    if (down[PAD.LEFT]) x = -1;
    else if (down[PAD.RIGHT]) x = 1;
    if (down[PAD.UP]) y = -1;
    else if (down[PAD.DOWN]) y = 1;
    p.in.x = x;
    p.in.y = y;
    const on = (i) => down[i] && !spentButtons.has(i);
    p.in.b =
      (on(PAD.RT) || on(PAD.X) ? BTN.A : 0) |
      (on(PAD.LT) || on(PAD.B) ? BTN.S : 0) |
      (on(PAD.A) || on(PAD.Y) ? BTN.J : 0) |
      (on(PAD.RB) || on(PAD.LB) ? BTN.D : 0);
  }
}

function onKeyDown(e) {
  if (G.moved) return; // another tab is the big screen
  wake();
  if (e.code === 'Escape') {
    e.preventDefault();
    toggleMenu();
    return;
  }
  if (menuKey(e.code)) {
    e.preventDefault();
    return;
  }
  if (e.repeat) {
    if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault(); // no page scrolling
    return;
  }
  keysDown.add(e.code);
  if (frontKey(e.code)) {
    e.preventDefault();
    readKeyboards();
    return;
  }

  for (const kb of KEYBOARDS) {
    if (fightKeys(kb).includes(e.code)) {
      e.preventDefault();
      // in the phone lobby, keyboard players simply join by pressing their keys
      if (!players.has(kb.id) && G.mode === 'phones') {
        addPlayer(kb.id, kb.name, randomFighter(), { kb: true, tapJump: true });
      }
    }
    if (e.code === kb.nextFighter && players.has(kb.id)) cycleFighter(players.get(kb.id));
  }
  readKeyboards();

  if (e.code === 'KeyM') {
    toggleMute();
    return;
  }
  // The host keys below belong to the phone lobby; keyboard mode has its own (frontKey).
  if (G.mode !== 'phones') return;
  if (e.code === 'Enter') {
    if (G.state === 'lobby' && players.size >= 2) startCountdown();
  } else if (e.code === 'KeyB') {
    addBot();
  } else if (e.code === 'KeyN') {
    const lastBot = [...players.values()].reverse().find((p) => p.bot);
    if (lastBot) removePlayer(lastBot.id);
  } else if (e.code === 'KeyT') {
    cycleStage(1);
  }
}

export function bindInput() {
  addEventListener('keydown', onKeyDown);
  addEventListener('keyup', (e) => {
    keysDown.delete(e.code);
    readKeyboards();
  });
  addEventListener('pointerdown', wake);
  // the × on a card in the phone lobby takes that fighter out (a phone goes back to its join screen)
  $('#cards').addEventListener('click', (e) => {
    const button = e.target.closest ? e.target.closest('.x') : null;
    if (!button || G.mode !== 'phones' || G.state !== 'lobby') return;
    const p = players.get(button.parentElement.dataset.id);
    if (p) dismiss(p);
  });
  addEventListener('blur', () => {
    keysDown.clear();
    readKeyboards();
  });
  // (the fighter itself waits a while for the pad to come back: see padMissing)
  addEventListener('gamepaddisconnected', (e) => forgetPad(`pad-${e.gamepad.index}`));
}
