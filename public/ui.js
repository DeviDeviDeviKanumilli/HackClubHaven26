// The big screen's DOM: the HUD, the pause menu, and the title with the keyboard fighter select.
import { CHARS, ORDER, picStyle, picture, STAGE_ORDER, STAGES } from './roster.js';
import {
  $,
  addBot,
  addPlayer,
  backToLobby,
  botSkill,
  buildStage,
  clamp,
  endMatch,
  fighterAfter,
  G,
  mix,
  nextStage,
  PAD,
  params,
  players,
  removePlayer,
  saveSettings,
  setChar,
  setState,
  SETTINGS,
  startCountdown,
} from './game.js';
import { tearAway } from './draw.js';
import { dismiss, tell } from './input.js';
import { live, setVolumes, sfx, voice } from './sound.js';

const HTML_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => HTML_ENTITIES[c]);

const roster = () => [...players.values()];
const humans = () => roster().filter((p) => !p.bot);
const cpus = () => roster().filter((p) => p.bot);
const lastCpu = () => cpus().at(-1);

// For stepping through a list: an index one past either end wraps round to the other.
const wrapIndex = (i, length) => (i + length) % length;

// Plays a CSS animation again from the start. Reading offsetWidth makes the browser notice the class was gone.
function restartAnimation(el, className) {
  el.classList.remove(className);
  void el.offsetWidth;
  el.classList.add(className);
}

// Banner and kill feed

let bannerTimer = 0;
// high: sit near the top of the screen instead of the middle (the winner's close-up needs the middle)
export function banner(text, sub, ms, color, high = false) {
  const el = $('#banner');
  const subLine = sub ? `<small><span>${sub}</span></small>` : '';
  el.classList.toggle('high', high);
  el.innerHTML = `<span class="big sticker" style="color:${color || '#ffd84a'}">${text}</span>${subLine}`;
  restartAnimation(el, 'show');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => el.classList.remove('show'), ms);
}

export function feed(html) {
  const list = $('#feed');
  const line = document.createElement('div');
  line.innerHTML = html;
  list.appendChild(line);
  while (list.children.length > 5) list.firstChild.remove();
  setTimeout(() => line.remove(), 4000);
}

// The phone lobby's title card: the cast with their names and roles.
let titleBuilt = false;
function buildTitle() {
  titleBuilt = true;
  $('#title .lineup').innerHTML = ORDER.map(titleFigure).join('');
}

function titleFigure(id, i) {
  const caption = `<figcaption><b>${CHARS[id].name}</b><small>${CHARS[id].role}</small></figcaption>`;
  return `<figure style="--d:${-i * 0.37}s">${picture('poster', id)}${caption}</figure>`;
}

// Called every frame; each part only touches the DOM when its text or state changed.
let lastStatus = '';
let lastStage = null;
let cardsDrawnAt = 0;
export function hud(now) {
  notes(now);

  // an empty phone lobby shows the title card
  const empty = G.mode === 'phones' && G.state === 'lobby' && players.size === 0;
  const titleShown = 'empty' in document.body.dataset;
  if (empty !== titleShown) {
    if (empty) {
      if (!titleBuilt) buildTitle();
      document.body.dataset.empty = '';
    } else {
      delete document.body.dataset.empty;
    }
  }

  const [status, urgent] = statusText();
  if (status !== lastStatus) {
    lastStatus = status;
    $('#stTxt').textContent = status;
    $('#status').classList.toggle('hot', urgent);
  }
  const stage = stageLine();
  if (stage !== lastStage) {
    lastStage = stage;
    $('#stageName').textContent = stage;
  }
  if (G.hudDirty && now - cardsDrawnAt > 60) {
    G.hudDirty = false;
    cardsDrawnAt = now;
    cards();
  }
}

// The "Sound is off" and "Lost the game server" notes.
let soundNoteShown = null;
let offlineNoteShown = null;
function notes(now) {
  // a beat after load, so an audio-enabled kiosk never flashes it
  const silent = !live() && !G.moved && now > 1500;
  if (silent !== soundNoteShown) {
    soundNoteShown = silent;
    $('#sound').classList.toggle('show', silent);
  }
  // once another tab has taken over, or this page was refused, standDown() in input.js owns the offline note
  if (G.moved) return;
  // brief blips don't count
  const offline = !!G.offlineSince && performance.now() - G.offlineSince > 2500;
  if (offline !== offlineNoteShown) {
    offlineNoteShown = offline;
    $('#offline').classList.toggle('show', offline);
  }
}

const clockText = (secs) => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;

// The top status: lobby countdown and ready count, the match clock, sudden death. Returns [text, urgent].
function statusText() {
  if (G.paused) return ['Paused', false];
  if (G.state === 'lobby') return [lobbyStatus(), false];
  if (G.state === 'countdown') return [`${players.size} fighters`, false];
  if (G.state === 'play') {
    if (!SETTINGS.time) return [clockText(Math.floor(G.matchT)), false];
    if (G.sudden) return ['SUDDEN DEATH', true];
    const left = Math.ceil(Math.max(0, SETTINGS.time - G.matchT));
    return [clockText(left), left <= 10];
  }
  return ['Results', false];
}

function lobbyStatus() {
  if (players.size === 0) return 'Scan the code to join';
  if (players.size < 2) return 'Warm-up · need one more fighter';
  const countdown = `Starting in ${Math.ceil(G.lobbyT)}`;
  const phones = humans().filter((p) => !p.kb);
  if (!phones.length) return countdown;
  const ready = phones.filter((p) => p.ready).length;
  return `${countdown} · ${ready}/${phones.length} ready`;
}

// Under the status: this stage, or which one is up next.
function stageLine() {
  if (G.state === 'countdown') return STAGES[G.stageId].name;
  if (G.state !== 'lobby') return '';
  if (players.size < 2) return STAGES[G.stageId].name;
  return `Next: ${STAGES[nextStage()].name}`;
}

function ordinal(n) {
  if (n % 100 >= 11 && n % 100 <= 13) return 'th';
  return ['th', 'st', 'nd', 'rd'][n % 10] || 'th';
}

// White at 0%, through yellow, to red at 150% and beyond.
const pctColors = []; // by whole per cent, worked out once each
function pctColor(pct) {
  if (!pctColors[pct]) {
    const t = clamp(pct / 150, 0, 1);
    pctColors[pct] = t < 0.5 ? mix('#ffffff', '#ffd166', t * 2) : mix('#ffd166', '#ff5c7a', (t - 0.5) * 2);
  }
  return pctColors[pct];
}

// The row of player cards along the bottom: portrait, name, damage (or OUT/NEXT, or the finishing place), lives.
// Writing to the page and then reading its layout makes the browser lay everything out again, so the cards only write
// what changed, and the row's height is only measured when something that could change it did.
const cardsById = new Map();
let rowKey = '';
function cards() {
  const list = roster();
  const row = $('#cards');
  let sizeClass = '';
  if (list.length > 12) sizeClass = 'tiny';
  else if (list.length > 6) sizeClass = 'small';
  if (row.className !== sizeClass) row.className = sizeClass;
  const inPlay = G.state === 'play' || G.state === 'countdown';

  // the camera keeps the action above this row
  const key = `${list.length}|${sizeClass}|${inPlay}|${innerWidth}x${innerHeight}`;
  if (key !== rowKey) {
    rowKey = key;
    queueMicrotask(() => {
      G.cardsH = list.length ? (row.offsetHeight || 0) + 16 : 0;
    });
  }

  for (const p of list) {
    let card = cardsById.get(p.id);
    if (!card) {
      card = makeCard(row, p.id);
      cardsById.set(p.id, card);
    }
    fillCard(card, p, inPlay);
  }
  for (const [id, card] of cardsById) {
    if (players.has(id)) continue;
    card.el.remove();
    cardsById.delete(id);
  }
}

// A card keeps hold of the elements it writes to and of what each one shows now.
function makeCard(row, id) {
  const el = document.createElement('div');
  el.className = 'card';
  el.dataset.id = id;
  el.innerHTML =
    '<span class="pic face" aria-hidden="true"></span>' +
    '<div><div class="nm"></div><div class="pc"></div><span class="st"></span></div>' +
    '<b class="rd">READY</b>' +
    '<button class="x" title="Take out of the game" aria-label="Take out of the game">×</button>';
  row.appendChild(el);
  return {
    el,
    portrait: el.querySelector('.pic'),
    name: el.querySelector('.nm'),
    score: el.querySelector('.pc'),
    lives: el.querySelector('.st'),
    shown: {},
    shookAt: -1,
  };
}

// True when a part of the card has to be rewritten: its value differs from what the card shows now.
function changed(card, part, value) {
  if (card.shown[part] === value) return false;
  card.shown[part] = value;
  return true;
}

function fillCard(card, p, inPlay) {
  const { el } = card;
  const sittingOut = inPlay && (!p.inMatch || p.out);
  // during the results, each card shows where that player finished
  const placed = G.state === 'result' && p.place;

  let score;
  if (placed) score = `${p.place}<small>${ordinal(p.place)}</small>`;
  else if (sittingOut) score = p.inMatch ? 'OUT' : 'NEXT';
  else score = `${Math.round(p.pct)}<small>%</small>`;

  let scoreColor;
  if (placed) scoreColor = p.place === 1 ? '#ffd166' : '#ffffff';
  else scoreColor = pctColor(Math.round(p.pct));

  // lives during a match, otherwise the wins so far
  let lives = '';
  if (inPlay && p.inMatch) lives = '<i></i>'.repeat(Math.max(0, p.stocks));
  else if (p.wins) lives = '♛ ' + p.wins;

  const ready = G.state === 'lobby' && p.ready;

  if (changed(card, 'tag', p.tag)) el.style.setProperty('--tag', p.tag);
  if (changed(card, 'sittingOut', sittingOut)) el.classList.toggle('out', sittingOut);
  if (changed(card, 'picture', p.ch + p.color)) card.portrait.style.cssText = picStyle(p.ch, p.color);
  if (changed(card, 'name', p.name)) card.name.textContent = p.name;
  if (changed(card, 'score', score)) card.score.innerHTML = score;
  if (changed(card, 'scoreColor', scoreColor)) card.score.style.color = scoreColor;
  if (changed(card, 'ready', ready)) el.classList.toggle('ready', ready);
  if (changed(card, 'lives', lives)) card.lives.innerHTML = lives;

  // a fresh hit gives the card a shake
  if (p.hitAt > card.shookAt) {
    card.shookAt = p.hitAt;
    restartAnimation(el, 'shake');
  }
}

// Results screen

const MEDALS = ['1st', '2nd', '3rd'];

function resultRow(p, i) {
  const winClass = i === 0 && p === G.lastWinner ? ' win' : '';
  const place = MEDALS[i] || `${i + 1}th`;
  const award = p.award ? `<span class="aw">${esc(p.award)}</span>` : '<span></span>';
  return `
    <div class="row paper${winClass}" style="--tag:${p.tag};--d:${i * 0.12}s">
      <span class="pl">${place}</span>${picture('face', p.ch, { color: p.color })}
      <span class="who"><b>${esc(p.name)}</b><small>${p.c.name}</small></span>
      ${award}
      <span class="n"><b>${p.stats.kos}</b>KOs</span><span class="n"><b>${p.stats.falls}</b>falls</span>
      <span class="n"><b>${Math.round(p.stats.dmg)}</b>dmg</span><span class="n"><b>${p.stats.combo}</b>combo</span>
    </div>`;
}

let resultsTimer = 0;
export function showResults(ranked) {
  const el = $('#results');
  const whatNext =
    G.mode === 'keys'
      ? 'Press <kbd>Enter</kbd>, or <kbd>A</kbd> on a controller, to choose fighters for the next match'
      : 'Tap READY on your phone for the next match';
  el.innerHTML =
    `<h2 class="sticker">Results</h2><div class="rows">` +
    ranked.slice(0, 8).map(resultRow).join('') +
    `</div><p class="foot">${whatNext}</p>`;
  clearTimeout(resultsTimer);
  resultsTimer = setTimeout(() => el.classList.add('show'), 2600); // let the winner shot play first
}

export function hideResults() {
  clearTimeout(resultsTimer);
  $('#results').classList.remove('show');
}

// Pause menu and host settings (Esc, or Start on a controller). Arrows or the stick move and change, Enter or A picks.
// Mouse works too.

const pct = (v) => `${Math.round(v * 100)}%`;
const capitalized = (v) => v[0].toUpperCase() + v.slice(1);
const onOff = (v) => (v ? 'On' : 'Off');

const inLobby = () => G.state === 'lobby' && !!G.mode;

// A row either changes a setting (key, opts) or does something (act). `when` hides it while it makes no sense. What a
// match or a lobby most often wants comes first, so a controller is never more than a press or two away from it.
const ROWS = [
  { act: 'resume', label: 'Resume', when: () => G.state !== 'lobby' },
  { act: 'end', label: 'End this match', when: () => G.state === 'play' },
  { act: 'start', label: 'Start the match', when: () => inLobby() && players.size >= 2 },
  { act: 'stage', label: 'Stage', fmt: () => STAGES[G.stageId].name, when: () => G.state === 'lobby' },
  { act: 'addcpu', label: 'Add a CPU', when: inLobby },
  { act: 'delcpu', label: 'Remove a CPU', when: () => inLobby() && cpus().length > 0 },
  { key: 'stocks', label: 'Lives', opts: [0, 1, 2, 3, 4, 5], fmt: (v) => (v ? String(v) : 'Auto') },
  {
    key: 'time',
    label: 'Time limit',
    opts: [60, 120, 180, 300, 0],
    fmt: (v) => (v ? `${v / 60} min` : 'None'),
  },
  { key: 'items', label: 'Items', opts: [true, false], fmt: onOff },
  { key: 'events', label: 'Stage events', opts: [true, false], fmt: onOff },
  { key: 'bots', label: 'Bot level', opts: ['easy', 'normal', 'hard'], fmt: capitalized },
  { key: 'shake', label: 'Shake & flashes', opts: ['full', 'low', 'off'], fmt: capitalized },
  { key: 'music', label: 'Music', opts: [0, 0.25, 0.5, 0.7, 1], fmt: pct },
  { key: 'sfx', label: 'Sound effects', opts: [0, 0.25, 0.5, 0.75, 0.9, 1], fmt: pct },
  {
    act: 'mode',
    label: 'Phones or keyboard',
    fmt: () => (G.mode === 'keys' ? 'Keyboard' : 'Phones'),
    when: inLobby,
  },
  { act: 'resume', label: 'Close', when: () => G.state === 'lobby' },
];
const FIRST_SETTING = ROWS.findIndex((row) => row.key);

// In the phone lobby, a fighter on the keyboard or a controller has no button of their own for leaving: each gets a
// "Take ... out" row here instead. (The keyboard fighter select has its own keys and buttons for that.)
const leaveRows = new Map();
function leaveRow(p) {
  if (!leaveRows.has(p.id)) leaveRows.set(p.id, { act: 'leave', id: p.id });
  const row = leaveRows.get(p.id);
  row.label = `Take ${esc(p.name)} out`;
  return row;
}

// The selection is a row, not a position: rows come and go (Start appears once two fighters are in), and a click or key
// must act on the row the player actually sees, never on whatever has slid into its old place.
let selRow = ROWS[0];
let shownRows = [];
function visible() {
  const rows = ROWS.filter((row) => !row.when || row.when());
  if (G.mode !== 'phones' || G.state !== 'lobby') return rows;
  const locals = roster().filter((p) => p.kb);
  const at = rows.findIndex((row) => ROWS.indexOf(row) >= FIRST_SETTING);
  rows.splice(at, 0, ...locals.map(leaveRow)); // just above the settings
  return rows;
}
const selIndex = (rows) => Math.max(0, rows.indexOf(selRow));

export function toggleMenu(on = !G.paused) {
  G.paused = on;
  G.hudDirty = true;
  $('#menu').classList.toggle('show', on);
  if (on) {
    $('#menu h2').textContent = G.state === 'lobby' ? 'Settings' : 'Paused';
    selRow = visible()[0];
    renderMenu();
  }
  const note = on ? 'Paused by the big screen' : 'Back to it!';
  for (const p of players.values()) tell(p, { t: 'note', text: note });
  sfx.ui(on ? 1 : 0);
}

// Cycles the lobby stage (also bound to T in the lobby). Rebuilds the island art right away.
export function cycleStage(dir = 1) {
  if (G.state !== 'lobby') return;
  const i = STAGE_ORDER.indexOf(G.stageId);
  G.stageId = STAGE_ORDER[wrapIndex(i + dir, STAGE_ORDER.length)];
  G.stageLock = true; // the host picked it: don't rotate away on the next match
  tearAway();
  sfx.tear();
  buildStage(Math.max(2, players.size));
  G.hudDirty = true;
}

// A setting row steps through its options (dir -1 or 1); any other row does what it says.
function change(row, dir) {
  if (row.key) changeSetting(row, dir);
  else if (row.act === 'stage') cycleStage(dir);
  else if (row.act === 'resume') toggleMenu(false);
  else if (row.act === 'addcpu') addCpu();
  else if (row.act === 'delcpu') removeCpu();
  else if (row.act === 'end') {
    if (G.state === 'play') endMatch(null);
    toggleMenu(false);
  } else if (row.act === 'mode') {
    toggleMenu(false);
    backToTitle();
  } else if (row.act === 'start') {
    toggleMenu(false);
    if (G.state === 'lobby' && players.size >= 2) startCountdown();
  } else if (row.act === 'leave') {
    removePlayer(row.id);
    sfx.ui(0);
  }
}

function changeSetting(row, dir) {
  const i = Math.max(0, row.opts.indexOf(SETTINGS[row.key]));
  SETTINGS[row.key] = row.opts[wrapIndex(i + dir, row.opts.length)];
  saveSettings();
  if (row.key === 'music' || row.key === 'sfx') setVolumes();
  if (row.key === 'bots') updateBotSkill();
  sfx.ui(2);
}

// The CPUs already in play take on a new bot level straight away.
function updateBotSkill() {
  for (const p of cpus()) p.bot.skill = botSkill(p.bot.u);
}

const labelsOf = (rows) => rows.map((row) => row.label).join('|');
let shownLabels = '';

function rowButton(row) {
  const value = row.fmt ? `<b>‹ ${row.fmt(SETTINGS[row.key])} ›</b>` : '';
  return `
    <button class="mrow${row === selRow ? ' on' : ''}" data-i="${shownRows.indexOf(row)}">
      <span>${row.label}</span>${value}
    </button>`;
}

function renderMenu() {
  const rows = visible();
  // The selected row has gone (the last CPU was just removed, say): the row that was above it takes over. Not the one
  // below: pressing "Remove a CPU" once too often must not land on "Take ... out".
  if (!rows.includes(selRow)) {
    const above = shownRows.slice(0, shownRows.indexOf(selRow)).reverse();
    selRow = above.find((row) => rows.includes(row)) || rows[0];
  }
  shownRows = rows;
  const list = $('#menu .list');
  const scrolledTo = list.scrollTop;
  list.innerHTML = rows.map(rowButton).join('');
  // on a short screen the list scrolls: stay where it was, and keep the selected row in sight
  list.scrollTop = scrolledTo;
  const selected = list.querySelector('.mrow.on');
  if (selected && selected.scrollIntoView) selected.scrollIntoView({ block: 'nearest' });
  shownLabels = labelsOf(rows);
  for (const button of document.querySelectorAll('#menu .mrow')) {
    const row = rows[Number(button.dataset.i)]; // the row this button was drawn for
    button.addEventListener('click', (e) => {
      // it has just gone away: redraw instead of acting
      if (!visible().includes(row)) {
        renderMenu();
        return;
      }
      selRow = row;
      // a click on the left half of a setting steps it back, anywhere else steps it on
      const rect = button.getBoundingClientRect();
      const onLeft = e.clientX < rect.left + rect.width * 0.55;
      change(row, onLeft && row.opts ? -1 : 1);
      if (G.paused) renderMenu();
    });
  }
}

// Called every frame while paused: redraw when rows appear or disappear (a phone joined or left).
export function refreshMenu() {
  if (G.paused && labelsOf(visible()) !== shownLabels) renderMenu();
}

// Returns true when the key was used by the menu.
export function menuKey(code) {
  if (!G.paused) return false;
  const rows = visible();
  const i = selIndex(rows);
  if (code === 'ArrowUp' || code === 'KeyW') selRow = rows[wrapIndex(i - 1, rows.length)];
  else if (code === 'ArrowDown' || code === 'KeyS') selRow = rows[wrapIndex(i + 1, rows.length)];
  else if (code === 'ArrowLeft' || code === 'KeyA') change(rows[i], -1);
  else if (['ArrowRight', 'KeyD', 'Enter', 'Space'].includes(code)) change(rows[i], 1);
  else return false;
  if (G.paused) renderMenu();
  return true;
}

// The front end: the title, where you choose how to play (on phones, or right here on the keyboard), and the fighter
// select for keyboard play. Everything here works from the keyboard alone; gamepads and the mouse work too.
//
// G.mode is null on the title, 'phones' for the phone lobby (QR code, phones pick and ready up on their own screens) or
// 'keys' for local play: P1 on WASD, P2 joins on the arrow keys, controllers join with A, plus computer fighters.
// Whoever opens the select gets the first seat: the keyboard, or the controller that pressed A on the title.
//
// Everything on the select can be done from any of them. Taking a fighter out: a player backs out with their own back
// key or button (G, L, B on a controller), N or a controller's X removes a CPU, and every card has an × for the mouse
// (a phone taken out that way goes back to its join screen).

const MODES = ['phones', 'keys'];
const P1 = 'kb-wasd';
const P2 = 'kb-arrows';
const MAX_FIGHTERS = 8; // on the select screen: the slot row and the stage both stay readable
const RESULTS_HOLD = 2.5; // seconds of results before a key press can skip them

function load(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null');
  } catch {
    return null;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // private browsing: nothing is remembered, and that's fine
  }
}

// Which way to play

let titleChoice = load('ko-mode') === 'keys' ? 1 : 0; // the title remembers the last choice

// The mode the page opens in: the title (null), unless the URL says otherwise. Debug and test URLs (?bots, ?go) open
// the phone lobby; ?mode=phones|keys opens either directly.
export function firstMode() {
  const asked = params.get('mode');
  if (MODES.includes(asked)) return asked;
  return params.has('bots') || params.has('go') ? 'phones' : null;
}

// `first` is who opened it: the keyboard's P1 seat, or a controller's id.
export function setMode(mode, first = P1) {
  G.mode = mode;
  G.hudDirty = true;
  document.body.dataset.mode = mode || 'title';
  if (mode) {
    titleChoice = MODES.indexOf(mode);
    save('ko-mode', mode);
  }
  if (mode === 'keys') {
    keyboardUsed = false;
    joinSelect(first);
    if (!cpus().length) addStandIn(); // someone to fight straight away
  }
}

// Back to the title from a lobby: local fighters and bots leave (phones stay connected, and come back into whichever
// mode is picked next).
function backToTitle() {
  if (G.state === 'result') {
    hideResults();
    setState('lobby');
  }
  if (G.state !== 'lobby') return;
  for (const p of [...players.values()]) if (p.bot || p.kb) removePlayer(p.id);
  setMode(null);
  sfx.ui(0);
}

function chooseMode(mode, first) {
  sfx.ready();
  setMode(mode, first);
}

function moveTitleChoice(to) {
  if (titleChoice !== to) sfx.ui(2);
  titleChoice = to;
}

// A controller turning up on the title means controller play: the highlight moves to that card, so the A that woke
// the controller up is also the A that starts. (Pushing the stick left first still picks phones.)
const padsSeenOnTitle = new Set();
function greetPad(id) {
  if (padsSeenOnTitle.has(id)) return;
  padsSeenOnTitle.add(id);
  moveTitleChoice(MODES.indexOf('keys'));
}

// Who is on the select screen

// What each kind of local player's card says about their controls.
// prettier-ignore
const KEYBOARD_CARDS = {
  [P1]: {
    name: 'P1', how: 'WASD',
    keys: [['A', 'D', 'move'], ['W', 'jump'], ['F', 'attack'], ['G', 'special'], ['H', 'shield']], pick: 'F',
    back: 'G', moveKeys: 'A D',
  },
  [P2]: {
    name: 'P2', how: 'Arrows',
    keys: [['←', '→', 'move'], ['↑', 'jump'], ['K', 'attack'], ['L', 'special'], [';', 'shield']], pick: 'K',
    back: 'L', moveKeys: '← →',
  },
};
// prettier-ignore
const GAMEPAD_CARD = {
  how: 'Controller',
  keys: [['Stick', 'move'], ['A', 'jump'], ['RT', 'attack'], ['LT', 'special'], ['RB', 'shield']], pick: 'A',
  back: 'B', moveKeys: 'Stick',
};
const controlsOf = (p) => KEYBOARD_CARDS[p.id] || GAMEPAD_CARD;
const isPad = (id) => id.startsWith('pad-');

// The CPU put in for a lone P1. It steps aside when a second person joins (two people means 1v1), and comes back if
// they leave again. A CPU added with B, or one whose fighter was changed, is the players' own and stays put.
let standIn = null;
// Players who joined during a match or on the results: they still have to pick on the select screen.
const lateJoiners = new Set();
// P1 is seated on the keyboard before anyone has touched it. Until someone does (a P1 key, or locking P1 in), that
// seat is only a guess, and a controller that joins takes it over instead of fighting an empty chair.
let keyboardUsed = false;

const onSelect = () => G.mode === 'keys' && G.state === 'lobby' && !G.paused;
const canStart = () => onSelect() && players.size >= 2 && humans().every((p) => p.ready);

// Brings a keyboard or gamepad player in, on the fighter they picked last time if they have one.
function joinSelect(id) {
  if (players.has(id)) return players.get(id);
  if (isPad(id) && G.state === 'lobby' && !keyboardUsed && players.has(P1)) removePlayer(P1);
  if (roster().length >= MAX_FIGHTERS) {
    // full: a CPU gives up its place, but never in the middle of a match
    const cpu = G.state === 'lobby' ? lastCpu() : null;
    if (!cpu) {
      nudge();
      return null;
    }
    removePlayer(cpu.id);
  }
  const picks = load('ko-picks') || {};
  let ch = picks[id];
  if (!CHARS[ch]) {
    // nothing remembered: the first fighter no other person is on
    const taken = new Set(humans().map((p) => p.ch));
    ch = ORDER.find((c) => !taken.has(c)) || ORDER[0];
  }
  const card = KEYBOARD_CARDS[id];
  const name = card ? card.name : `Pad ${Number(id.slice(4)) + 1}`;
  const p = addPlayer(id, name, ch, { kb: true, tapJump: !!card });
  if (p) {
    p.ready = false;
    updateStandIn();
  }
  return p;
}

// Two or more people on the select: the stand-in CPU leaves. Back down to one with nobody to fight: it returns.
function updateStandIn() {
  if (G.mode !== 'keys' || G.state !== 'lobby') return;
  if (standIn && !players.has(standIn)) standIn = null;
  const people = humans().length;
  if (people >= 2 && standIn) {
    removePlayer(standIn);
    standIn = null;
  } else if (people === 1 && !cpus().length) {
    addStandIn();
  }
}

function addStandIn() {
  const cpu = addBot();
  standIn = cpu ? cpu.id : null; // null: the game is full
}

// Someone joining from the keyboard or a pad outside the select screen: in the countdown they're straight in, mid-match
// they're in from the next one, on the results they're on the select screen that follows.
function joinLate(id) {
  const p = joinSelect(id);
  if (!p) return;
  if (G.state === 'countdown') {
    p.ready = true;
    return;
  }
  lateJoiners.add(id);
  if (G.state === 'play') feed(`<b style="color:${p.tag}">${esc(p.name)}</b> is in for the next match`);
}

function rememberPick(p) {
  const picks = load('ko-picks') || {};
  picks[p.id] = p.ch;
  save('ko-picks', picks);
}

// What a player does on the select screen

function moveCursor(p, step) {
  if (p.ready) return;
  setChar(p, fighterAfter(p.ch, step));
  sfx.ui(2);
  G.hudDirty = true;
}

// Locks the player's fighter in. Pressed again once everyone is locked in, it starts the match.
function lockIn(p) {
  if (p.ready) {
    fight();
    return;
  }
  if (p.id === P1) keyboardUsed = true;
  p.ready = true;
  sfx.ready();
  voice(p.ch, 'yay');
  rememberPick(p);
  G.hudDirty = true;
}

// Someone else is here to hold the select screen open, so this player can go.
const canLeave = (p) => humans().length >= 2 || !humans().includes(p);

// Takes a fighter off the select screen: a person who backed out, or anyone whose card's × was clicked.
function takeOut(p) {
  if (!canLeave(p)) return;
  dismiss(p);
  if (p.id === standIn) standIn = null;
  if (!p.bot) updateStandIn(); // a CPU that was taken out stays out
  sfx.ui(0);
  G.hudDirty = true;
}

// Unlocks the player's fighter; pressed again, they leave. The only person here has nowhere to leave to: a controller's
// B goes back to the title, like any back button, and a lone keyboard player stays (Backspace is their way back).
function stepBack(p) {
  if (p.ready) {
    p.ready = false;
    sfx.ui(0);
    G.hudDirty = true;
  } else if (canLeave(p)) takeOut(p);
  else if (isPad(p.id)) backToTitle();
}

function fight() {
  if (canStart()) startCountdown();
}

function leaveResults() {
  backToLobby();
  updateStandIn();
}

// The select screen has room for eight; the phone lobby takes as many as the game does.
function addCpu() {
  if (G.mode === 'keys' && roster().length >= MAX_FIGHTERS) {
    nudge();
    return;
  }
  addBot();
  standIn = null; // the players are choosing their own CPUs now: the one put in for them stays too
}

// Takes out the CPU that was added last.
function removeCpu() {
  const cpu = lastCpu();
  if (!cpu) return;
  removePlayer(cpu.id);
  if (cpu.id === standIn) standIn = null;
  sfx.ui(0);
}

function changeCpuFighter(cpu) {
  setChar(cpu, fighterAfter(cpu.ch));
  sfx.ui(2);
  G.hudDirty = true;
  if (cpu.id === standIn) standIn = null; // the players chose this one: it's theirs now
}

function cycleCpuLevel() {
  const levels = ['easy', 'normal', 'hard'];
  const i = levels.indexOf(SETTINGS.bots);
  SETTINGS.bots = levels[wrapIndex(i + 1, levels.length)];
  saveSettings();
  updateBotSkill();
  sfx.ui(2);
}

// The footer hint gives a little shake: "here's what's missing".
let nudgedAt = 0;
function nudge() {
  nudgedAt = performance.now();
  sfx.ui(0);
}

// Keyboard

// On the select screen each player's keys move their cursor (-1 / 1), lock in or step back. The rest of their fighting
// keys are swallowed there, so they don't do anything unexpected.
const SELECT_KEYS = {
  [P1]: { KeyA: -1, KeyD: 1, KeyF: 'lock', KeyG: 'back' },
  [P2]: { ArrowLeft: -1, ArrowRight: 1, KeyK: 'lock', KeyL: 'back' },
};
const OTHER_KEYS = {
  [P1]: ['KeyW', 'KeyS', 'KeyH', 'KeyQ'],
  [P2]: ['ArrowUp', 'ArrowDown', 'Semicolon', 'KeyP'],
};
const ownsKey = (id, code) => code in SELECT_KEYS[id] || OTHER_KEYS[id].includes(code);
const CONFIRM_KEYS = ['Enter', 'Space', 'KeyF', 'KeyK'];

function selectAction(p, action) {
  if (action === 'lock') lockIn(p);
  else if (action === 'back') stepBack(p);
  else moveCursor(p, action);
}

// Returns true when the key was used here (onKeyDown then leaves it alone).
export function frontKey(code) {
  if (!G.mode) return titleKey(code);
  if (G.mode === 'phones') {
    if (code !== 'Backspace' || G.state !== 'lobby') return false;
    backToTitle();
    return true;
  }
  if (G.state === 'lobby') return selectKey(code);
  // outside the select screen, someone can still drop in on their half of the keyboard
  for (const seat of [P1, P2]) {
    if (ownsKey(seat, code) && !players.has(seat)) {
      joinLate(seat);
      return true;
    }
  }
  if (G.state === 'result') return resultsKey(code);
  // mid-match the select screen's own keys do nothing
  return ['KeyB', 'KeyN', 'KeyV', 'KeyT', 'Backspace', 'Enter'].includes(code);
}

function titleKey(code) {
  if (['ArrowLeft', 'KeyA', 'ArrowUp', 'KeyW'].includes(code)) moveTitleChoice(0);
  else if (['ArrowRight', 'KeyD', 'ArrowDown', 'KeyS'].includes(code)) moveTitleChoice(1);
  else if (CONFIRM_KEYS.includes(code)) chooseMode(MODES[titleChoice]);
  else if (code === 'Digit1') chooseMode('phones');
  else if (code === 'Digit2') chooseMode('keys');
  else return code !== 'KeyM'; // M still mutes; everything else waits for a choice
  return true;
}

function resultsKey(code) {
  if (CONFIRM_KEYS.includes(code)) {
    if (G.stT > RESULTS_HOLD) {
      leaveResults();
      sfx.ui(1);
    }
    return true;
  }
  if (code === 'Backspace') {
    backToTitle();
    return true;
  }
  return ownsKey(P1, code) || ownsKey(P2, code);
}

function selectKey(code) {
  if (code === 'Backspace') backToTitle();
  else if (code === 'KeyB') addCpu();
  else if (code === 'KeyN') removeCpu();
  else if (code === 'KeyV') cycleCpuLevel();
  else if (code === 'KeyT') cycleStage(1);
  else if (code === 'Enter' || code === 'Space') confirmSelect();
  else if (/^Digit[1-8]$/.test(code)) {
    // the number on a CPU's card changes its fighter
    const p = [...humans(), ...cpus()][Number(code.slice(5)) - 1];
    if (p && p.bot) changeCpuFighter(p);
  } else {
    // a player's own keys: the first press takes their seat if they aren't in it, after that the keys act
    const seat = [P1, P2].find((id) => ownsKey(id, code));
    if (!seat) return false;
    if (seat === P1) keyboardUsed = true;
    const p = players.get(seat);
    if (!p) joinSelect(seat);
    else if (code in SELECT_KEYS[seat]) selectAction(p, SELECT_KEYS[seat][code]);
  }
  return true;
}

// Enter locks in everyone at the keyboard or on a pad who hasn't yet; once they all have, it starts the match.
function confirmSelect() {
  const choosing = humans().filter((p) => p.kb && !p.ready);
  if (choosing.length) {
    for (const p of choosing) lockIn(p);
  } else if (canStart()) startCountdown();
  else nudge();
}

// Gamepads

// any face button but B (that one means "back" everywhere), or Start
const wantsIn = (pressed) => pressed(PAD.A) || pressed(PAD.X) || pressed(PAD.Y) || pressed(PAD.START);

// pressed(i): button i went down this frame. push: -1 or 1 on the frame the stick or d-pad is pushed left or right,
// else 0. Returns true when the pad was used here (padUpdate then keeps its buttons out of the fight).
export function frontPad(id, pressed, push) {
  if (!G.mode) {
    greetPad(id);
    if (push) moveTitleChoice(push < 0 ? 0 : 1);
    if (pressed(PAD.A) || pressed(PAD.START)) chooseMode(MODES[titleChoice], id);
    return true;
  }
  if (G.mode !== 'keys') return false;

  const p = players.get(id);
  if (G.state === 'result') {
    if (!p) {
      if (wantsIn(pressed)) joinLate(id);
      return true;
    }
    const next = pressed(PAD.A) || pressed(PAD.B) || pressed(PAD.START);
    if (next && G.stT > RESULTS_HOLD) {
      leaveResults();
      sfx.ui(1);
      return true;
    }
    return pressed(PAD.START); // not yet: meanwhile they can run about under the results, like the keyboards
  }
  if (G.state !== 'lobby') {
    // mid-match: a pad that isn't playing yet can drop in; one that is, plays
    if (p) return false;
    if (wantsIn(pressed)) joinLate(id);
    return true;
  }
  if (!p) {
    if (wantsIn(pressed)) joinSelect(id);
    return true;
  }
  p.in.x = p.in.y = p.in.b = 0;
  if (push) moveCursor(p, push);
  if (pressed(PAD.A)) lockIn(p);
  else if (pressed(PAD.B)) stepBack(p);
  else if (pressed(PAD.Y)) addCpu();
  else if (pressed(PAD.X)) removeCpu();
  else if (pressed(PAD.LB)) cycleStage(-1);
  else if (pressed(PAD.RB)) cycleStage(1);
  else if (pressed(PAD.START)) confirmSelect();
  else if (pressed(PAD.SELECT)) toggleMenu(true);
  return true;
}

// Mouse

export function bindFront() {
  for (const button of document.querySelectorAll('#front .mode')) {
    button.addEventListener('click', () => chooseMode(button.dataset.mode));
    button.addEventListener('pointerenter', () => {
      titleChoice = MODES.indexOf(button.dataset.mode);
    });
  }
  $('#pick').addEventListener('click', (e) => {
    const target = e.target.closest ? e.target.closest('[data-do]') : null;
    if (!target || !onSelect()) return;
    const action = target.dataset.do;
    // the mouse belongs to P1, or to whoever is playing if nobody is on the keyboard
    const p = players.get(target.dataset.id) || players.get(P1) || humans().find((h) => h.kb);
    if (action === 'ch' && p) {
      // clicking a fighter picks it and locks in
      p.ready = false;
      setChar(p, target.dataset.ch);
      lockIn(p);
    } else if (action === 'cpu' && p) changeCpuFighter(p);
    else if (action === 'remove') {
      const who = players.get(target.dataset.id);
      if (who) takeOut(who);
    } else if (action === 'add') addCpu();
    else if (action === 'join') joinSelect(target.dataset.seat);
    else if (action === 'level') cycleCpuLevel();
    else if (action === 'stage') cycleStage(1);
    else if (action === 'fight') fight();
    else if (action === 'back') backToTitle();
  });
}

// Drawing

// Called every frame; the page is only rewritten when what it shows has changed.
let shown = '';
export function drawFront() {
  if (!G.mode) {
    drawTitle();
    return;
  }
  if (G.mode !== 'keys' || G.state !== 'lobby') return;

  for (const id of lateJoiners) {
    const p = players.get(id);
    if (p) p.ready = false;
  }
  lateJoiners.clear();
  if (standIn && humans().length >= 2) updateStandIn(); // also after the results time out on their own
  if (!humans().length) joinSelect(P1); // the last controller was unplugged: the keyboard has the seat again

  drawSelect(roster());
}

let castBuilt = false;
function drawTitle() {
  if (!castBuilt) {
    castBuilt = true;
    $('#front .cast').innerHTML = ORDER.map((id, i) =>
      picture('poster', id, { label: CHARS[id].name, style: `--d:${-i * 0.37}s` }),
    ).join('');
  }
  const showing = `title ${titleChoice}`;
  if (showing === shown) return;
  shown = showing;
  for (const button of document.querySelectorAll('#front .mode')) {
    button.classList.toggle('on', button.dataset.mode === MODES[titleChoice]);
  }
}

let rosterBuilt = false;
function buildRoster() {
  rosterBuilt = true;
  $('#pick .roster').innerHTML = ORDER.map(
    (id) => `
      <button class="ftile" data-do="ch" data-ch="${id}">
        ${picture('poster', id)}<b>${CHARS[id].name}</b><small>${CHARS[id].role}</small>
        <span class="curs"></span>
      </button>`,
  ).join('');
}

function drawSelect(fighters) {
  if (!rosterBuilt) buildRoster();
  const people = fighters.filter((p) => !p.bot);
  const bots = fighters.filter((p) => p.bot);

  // cards: people, the open keyboard seat, CPUs, the "add a CPU" seat. A card's number is its place among the fighters.
  let slots = people.map(playerCard).join('');
  const openSeat = [P1, P2].find((id) => !players.has(id));
  if (openSeat && fighters.length < MAX_FIGHTERS) {
    const keys = openSeat === P1 ? ['W', 'A', 'S', 'D'] : ['←', '→', '↑', '↓'];
    slots += `<div class="slot open" data-do="join" data-seat="${openSeat}"><b>${KEYBOARD_CARDS[openSeat].name}</b>
      <p>Press ${keyCaps(keys)}<br>to join</p>
      <small>or press <kbd>A</kbd> on a controller</small></div>`;
  }
  slots += bots.map((p, i) => cpuCard(p, people.length + i + 1)).join('');
  if (fighters.length < MAX_FIGHTERS) {
    slots += `<div class="slot open add" data-do="add"><b>+ CPU</b><p>Press <kbd>B</kbd></p>
      <small>or <kbd>Y</kbd> on a controller</small></div>`;
  }

  // each person's tag sits on the fighter their cursor is on
  const cursors = ORDER.map((id) =>
    people
      .filter((p) => p.ch === id)
      .map(cursorTag)
      .join(''),
  ).join('\n');
  const hintText = whatIsMissing(fighters, people);
  const stageName = STAGES[nextStage()].name;
  const ready = canStart();
  const onPads = people.some((p) => isPad(p.id));
  // The cards themselves are the picture. A new field on a card changes this on its own.
  // nudgedAt is separate: the hint shakes even when its words stay the same.
  const picture = [slots, cursors, hintText, stageName, ready, onPads, nudgedAt].join('\n');
  if (picture === shown) return;
  shown = picture;

  for (const tile of document.querySelectorAll('#pick .ftile')) {
    const here = people.filter((p) => p.ch === tile.dataset.ch);
    tile.classList.toggle('on', here.length > 0);
    tile.style.setProperty('--tag', here.length ? here[0].tag : 'transparent');
    tile.querySelector('.curs').innerHTML = here.map(cursorTag).join('');
  }
  $('#pick .slots').innerHTML = slots;
  $('#pick .stage b').textContent = stageName;
  $('#pick').classList.toggle('go', ready);
  $('#pick').classList.toggle('pads', onPads); // the footer adds the controller's buttons
  const hint = $('#pick .need');
  hint.innerHTML = hintText;
  if (performance.now() - nudgedAt < 100) restartAnimation(hint, 'nudge');
}

function cursorTag(p) {
  return `<i style="--tag:${p.tag}" class="${p.ready ? 'lock' : ''}">${esc(p.name)}${p.ready ? ' ✓' : ''}</i>`;
}

function whatIsMissing(fighters, people) {
  if (fighters.length < 2) {
    const addKey = people.some((p) => isPad(p.id)) ? '<kbd>Y</kbd>' : '<kbd>B</kbd>';
    return `Add a CPU with ${addKey} or a second player to fight`;
  }
  const choosing = people.filter((p) => !p.ready);
  if (choosing.length) return `Waiting for ${choosing.map((p) => esc(p.name)).join(' and ')} to lock in`;
  return '';
}

const crown = (p) => (p.wins ? `<em>♛ ${p.wins}</em>` : '');
const fighterArt = (p) => `
  ${picture('poster art', p.ch, { color: p.color })}
  <div class="fn">${CHARS[p.ch].name}<small>${CHARS[p.ch].role}</small></div>`;

// The × in a card's corner, for the mouse.
const removeButton = (p, who) =>
  `<button class="x" data-do="remove" data-id="${p.id}" title="Take ${who} out" aria-label="Take ${who} out">×</button>`;

function cpuCard(p, number) {
  return `<div class="slot paper cpu" style="--tag:${p.tag}" data-do="cpu" data-id="${p.id}">
    ${removeButton(p, 'this CPU')}
    <div class="who"><b>CPU</b><span data-do="level">${capitalized(SETTINGS.bots)}</span>${crown(p)}</div>
    ${fighterArt(p)}
    <div class="state"><kbd>${number}</kbd> change fighter</div>
  </div>`;
}

// A person's card: who they are, their fighter, whether they've locked in, and (for keyboards and pads) their controls.
function playerCard(p) {
  const controls = p.kb ? controlsOf(p) : null; // a phone has its controls on its own screen
  let state;
  if (p.ready) state = `<div class="state rdy">READY</div>`;
  else if (!controls) state = `<div class="state">choosing on their phone</div>`;
  else {
    state = `<div class="state">
      <kbd>${controls.moveKeys}</kbd> choose · <kbd>${controls.pick}</kbd> lock in</div>`;
  }
  // what their back key does next: unlock, leave, or (a lone controller) go back to the title
  let backDoes = '';
  if (p.ready) backDoes = 'change';
  else if (canLeave(p)) backDoes = 'leave';
  else if (isPad(p.id)) backDoes = 'back';
  const undo = controls && backDoes ? `<div class="undo"><kbd>${controls.back}</kbd> ${backDoes}</div>` : '';
  const remove = canLeave(p) ? removeButton(p, esc(p.name)) : '';
  const how = controls ? controls.how : 'Phone';
  const keyList = controls ? controlsList(controls) : '';
  return `<div class="slot paper${p.ready ? ' ready' : ''}" style="--tag:${p.tag}">
    ${remove}
    <div class="who"><b>${esc(p.name)}</b><span>${how}</span>${crown(p)}</div>
    ${fighterArt(p)}
    ${state}${undo}${keyList}
  </div>`;
}

// The last entry of each row is what the keys before it do: ['A', 'D', 'move'].
function controlsList(controls) {
  const rows = controls.keys.map((row) => `<li>${keyCaps(row.slice(0, -1))}<span>${row.at(-1)}</span></li>`);
  return `<ul class="ctl">${rows.join('')}</ul>`;
}

const keyCaps = (keys) => keys.map((key) => `<kbd>${key}</kbd>`).join('');
