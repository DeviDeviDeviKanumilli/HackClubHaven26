// The game: shared state and settings, the world, move tables, fighters, combat, bots, stage events and the
// match flow. Runs the same in the browser and headless (test.js).
import { CHARS, ORDER, STAGE_ORDER, STAGES } from './roster.js';
import { cam, popText, popTexts, tearAway, updateCamera } from './draw.js';
import { banner, esc, feed, hideResults, showResults } from './ui.js';
import { tell, tellHud, tellYou } from './input.js';
import { sfx, voice } from './sound.js';

// Shared mutable session state.
export const G = {
  // where the session is: 'lobby', 'countdown', 'play' or 'result'
  state: 'lobby',
  stageId: 'meadow',
  stT: 0, // seconds spent in that state
  matchT: 0, // seconds of fighting in this match
  clock: 0, // game time since the page loaded; hits, shields and effects are stamped with it
  lobbyT: null, // seconds until the lobby starts the match by itself (null = not counting down)
  sudden: false, // the match clock ran out: sudden death
  lastBeep: -1, // the last countdown second that beeped
  stage: null, // the stage as built for stageId: platforms, blast zone, art
  nextItem: 8, // seconds until the next item drops

  // Screen effects, set by hits and KOs and faded out every frame in main.js.
  shake: 0,
  flash: 0,
  slowT: 0, // seconds of slow motion left after a finishing hit
  impact: null, // the last KO hit, for the spotlight and focus lines (visual only: { x, y, t, color })

  lastWinner: null, // wears the crown until the next match ends
  hudDirty: true, // something the HUD shows has changed: redraw it
  botSeq: 0, // numbers the bots' ids
  muted: false,
  matchStocks: 0, // lives each fighter started this match with
  cardsH: 0, // height of the HUD card row in px (the HUD), so the camera can keep fighters above it
  offlineSince: 0, // when the big screen lost the game server (0 = connected), see connect() and the HUD
  moved: false, // this page isn't the big screen any more (another tab took over, or the server refused it)
  paused: false,
  stageLock: false, // the host picked the stage by hand: don't rotate
  mode: null, // how this session plays: null (the title, still choosing), 'phones' or 'keys' (see ui.js)
};

// Small shared helpers: seeded randomness, math and colour.
export const $ = (s) => document.querySelector(s);
export const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
export const params = new URLSearchParams(location.search);
// The itch.io build (npm run itch): there's no server.js behind it, so no phones, no join link and no music.
export const OFFLINE = 'offline' in document.documentElement.dataset;

// Simulation randomness can be seeded (?seed=N) so debug captures are reproducible. Seeded, it is the
// standard mulberry32 generator.
let rng = Math.random;
if (params.has('seed')) {
  let state = Number(params.get('seed')) >>> 0 || 1;
  rng = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// rand(a): a random number from 0 to a. rand(a, b): from a to b.
const rand = (a, b) => (b === undefined ? rng() * a : a + rng() * (b - a));
export const vrand = (a, b) => a + Math.random() * (b - a); // visual-only randomness
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const sign = (v) => (v < 0 ? -1 : 1);
export const easeOut = (t) => 1 - (1 - t) * (1 - t);

// Mixes two #rrggbb colours: t = 0 is `hex`, 1 is `to`.
const channels = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
export function mix(hex, to, t) {
  const target = channels(to);
  const mixed = channels(hex).map((v, i) => Math.round(v + (target[i] - v) * t));
  return '#' + mixed.map((v) => v.toString(16).padStart(2, '0')).join('');
}
export const FONT = 'Fredoka, ui-rounded, system-ui, sans-serif';
export const DISPLAY = '"Lilita One", Fredoka, ui-rounded, system-ui, sans-serif';

// The fighter `step` places along the roster from `ch`, wrapping round at either end.
export const fighterAfter = (ch, step = 1) => ORDER[(ORDER.indexOf(ch) + step + ORDER.length) % ORDER.length];
// Not from the seeded rng: who a keyboard or gamepad player starts as is not part of a replay.
export const randomFighter = () => ORDER[Math.floor(Math.random() * ORDER.length)];

// Game tuning, palettes and the host's settings.

// Host settings: changed from the pause menu (Esc) and remembered between sessions.
export const SETTINGS = {
  stocks: 0, // lives per player; 0 = automatic by player count
  time: 120, // seconds before sudden death; 0 = no limit
  items: true,
  events: true, // stage events: wind gusts, rolling tumbleweeds, snowballs
  bots: 'normal', // easy | normal | hard
  music: 0.7,
  sfx: 0.9,
  shake: 'full', // screen shake and white flashes: full | low | off
};

// First run on a machine that asks for reduced motion: start calm (the menu can still turn it up).
try {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) SETTINGS.shake = 'low';
} catch {
  // no DOM (the tests)
}
try {
  Object.assign(SETTINGS, JSON.parse(localStorage.getItem('ko-settings') || '{}'));
} catch {
  // no storage: the defaults stand
}

export function saveSettings() {
  try {
    localStorage.setItem('ko-settings', JSON.stringify(SETTINGS));
  } catch {
    // no storage: the settings last for this session only
  }
}

// How much of the screen shake and flashes to show (0..1), from the Shake & flashes setting.
const SHAKE_SCALE = { full: 1, low: 0.35, off: 0 };
export const shakeK = () => SHAKE_SCALE[SETTINGS.shake] ?? 1;

const LOBBY_WAIT = 30; // seconds the lobby waits once two fighters are in (less when everyone is ready)
const RESULT_T = 9; // seconds on the results screen

// Tuning
const GRAV = 3100;
// these two scale the roster's jump and fall stats to the snappier gravity
const JUMP_K = 1.09;
const FALL_K = 1.12;
const LAUNCH_K = 1.45; // launch speed decay (/s): launch distance ≈ knockback / LAUNCH_K
const KB_GROWTH = 2.2; // how fast knockback rises with damage %
const DAMAGE_K = 1.15; // global damage multiplier
const BUFFER_T = 0.18; // input buffer (s): forgiving, since phones play through a network hop
const CHARGE_T = 0.9; // time to full charge

// Buttons, as bits of a fighter's input: attack, special, jump, shield (defend).
export const BTN = { A: 1, S: 2, J: 4, D: 8 };
// Gamepad button numbers in the browser's standard mapping.
// prettier-ignore
export const PAD = { A: 0, B: 1, X: 2, Y: 3,
  LB: 4, RB: 5, LT: 6, RT: 7,
  SELECT: 8, START: 9,
  UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15,
};

// Name-tag colours, handed out in order as players join.
// prettier-ignore
const PALETTE = [
  '#ff8fa3', '#7cc6ff', '#ffe66d', '#9be88a', '#c9a4ff', '#ffb86b', '#6ee7d2', '#ff9ed8', '#93a8ff', '#c8f27a',
  '#ffa48f', '#8fe3ff', '#e59bff', '#ffd3a8', '#8af0b4', '#f6f1a9', '#ffc8dd', '#b5ead7', '#d0d7ff', '#a79bff',
];
export const ITEMS = { heavy: '#b8a1ff', speed: '#ffe66d', shock: '#7ef0ff', heart: '#ff8fa3' }; // item colours
// prettier-ignore
const BOT_NAMES = [
  'Pudding', 'Boba', 'Tofu', 'Miso', 'Pebble', 'Biscuit', 'Noodle', 'Peach', 'Kiwi', 'Bean',
  'Dumpling', 'Waffle', 'Olive', 'Pickle', 'Sprout', 'Taro', 'Clover', 'Marble', 'Button', 'Fig',
];

// Shared world lists (players, projectiles, items, effects) and the stage geometry.

export const players = new Map();

// live things in the world, and the effects drawn over it
export const projs = [];
export const items = [];
export const particles = [];
export const rings = [];
export const bolts = [];
export const koFx = [];
export const impacts = [];
export const smokes = [];
export const ghosts = [];

// what happened, for the tests and the debug URL flags
export const matchLog = [];
export const koLog = [];
export const dbg = {};

const ZERO = { x: 0, y: 0, b: 0 }; // the input of a fighter who isn't allowed to act

// Lays out the island for n fighters: it grows past four of them, and a wide one gets six platforms instead of three.
export function buildStage(n) {
  const half = clamp(470 + 30 * Math.max(0, n - 4), 470, 900);
  const y = 160;
  const halfWidth = 115; // half a floating platform's width
  const main = { x1: -half, x2: half, y, solid: true };
  const plats = [main];
  const addPlatform = (x, platY) => plats.push({ x1: x - halfWidth, x2: x + halfWidth, y: platY });
  if (half > 680) {
    for (const f of [-0.78, -0.27, 0.27, 0.78]) addPlatform(half * f, y - 130);
    addPlatform(-half * 0.52, y - 260);
    addPlatform(half * 0.52, y - 260);
  } else {
    addPlatform(-half * 0.6, y - 130);
    addPlatform(half * 0.6, y - 130);
    addPlatform(0, y - 260);
  }
  G.stage = {
    half,
    y,
    plats,
    main,
    // the island's rock body is solid: you can't fall or fly through it
    solids: [
      { x1: -half, x2: half, y1: y + 6, y2: y + 70 },
      { x1: -half * 0.72, x2: half * 0.72, y1: y + 70, y2: y + 165 },
      { x1: -half * 0.45, x2: half * 0.45, y1: y + 165, y2: y + 250 },
    ],
    ledges: [
      { x: -half, y, side: -1, by: null },
      { x: half, y, side: 1, by: null },
    ],
    blast: { l: -half - 540, r: half + 540, t: y - 760, b: y + 540 },
  };
}

// Lives each: the host's setting, or fewer the more fighters there are, so a crowded match doesn't drag.
function stocksFor(n) {
  if (SETTINGS.stocks) return SETTINGS.stocks;
  if (n <= 3) return 3;
  return n <= 8 ? 2 : 1;
}

// Effect spawners: dust puffs, sparks, rings and per-fighter motif confetti. They never affect the fight, but they draw from
// the seeded rng, so they are part of a replay too.

function puff(x, y, color, n, speed, g = 0) {
  for (let i = 0; i < n; i++) {
    const angle = rand(TAU);
    const v = rand(speed * 0.15, speed);
    particles.push({
      x,
      y,
      vx: Math.cos(angle) * v,
      vy: Math.sin(angle) * v,
      g,
      life: rand(0.2, 0.5),
      max: 0.5,
      size: rand(2.5, 6),
      color,
      drag: 3.5,
    });
  }
}

function sparks(x, y, color, n, speed) {
  for (let i = 0; i < n; i++) {
    const angle = rand(TAU);
    const v = rand(speed * 0.4, speed);
    particles.push({
      x,
      y,
      vx: Math.cos(angle) * v,
      vy: Math.sin(angle) * v,
      life: rand(0.15, 0.3),
      max: 0.3,
      size: rand(2.5, 4.5),
      color,
      drag: 6,
      streak: 1,
    });
  }
}

// Each fighter sheds its own paper bits when it lands a hit. Visual only (vrand), so the seeded sim is untouched.
const MOTIFS = {
  mochi: 'petal',
  ember: 'flame',
  boulder: 'pebble',
  volt: 'bolt',
  bubbles: 'bubble',
  thorn: 'leaf',
  pinwheel: 'pinwheel',
};

function motif(x, y, ch, color, n, speed) {
  const shape = MOTIFS[ch];
  if (!shape) return;
  for (let i = 0; i < n; i++) {
    const angle = vrand(0, TAU);
    const v = vrand(speed * 0.3, speed);
    particles.push({
      x,
      y,
      vx: Math.cos(angle) * v,
      vy: Math.sin(angle) * v - 120,
      g: shape === 'bubble' || shape === 'flame' ? -260 : 700, // bubbles and flames float up; the rest fall
      life: vrand(0.45, 0.8),
      max: 0.8,
      size: vrand(6, 10),
      color,
      drag: 2.8,
      shape,
      rot0: vrand(0, TAU),
      spin: vrand(-9, 9),
    });
  }
}

function dust(x, y, dir, n) {
  for (let i = 0; i < n; i++) {
    smokes.push({
      x: x + rand(-10, 10),
      y: y - rand(0, 8),
      vx: dir * rand(40, 160),
      vy: -rand(20, 80),
      r: rand(6, 11),
      grow: 30,
      life: rand(0.3, 0.5),
      max: 0.5,
    });
  }
}

// Shockwaves: a paper hoop that flies out and thins away. kind: 'hoop' (round, or squashed along `ang`, the way a hit
// sends its target), 'air' (lying flat under a mid-air jump and sinking away), 'ground' (flat along the floor) or
// 'wall' (flat against a wall). `delay` holds it back, so a hit's hoop goes out when the hit-pause ends.
function ring(x, y, r, maxR, life, color, thick, { kind = 'hoop', ang = null, delay = 0 } = {}) {
  rings.push({ x, y, r, maxR, life: life + delay, max: life, color, thick, kind, ang });
}

// Move tables: every fighter's attacks and specials as data (timing, hitboxes, damage, knockback angles).

// Timing: st / ac / rc are the startup, active and recovery seconds.
// Hitboxes (hb): circles in body-local units (x forward, y down, r radius), each with dmg (damage %), kb (base
// knockback), kbg (knockback growth per 100% damage) and ang (launch angle in degrees: 0 forward, 90 up).
// Visuals: arc [from, to] in degrees (0 forward, -90 up, 90 down) with radius ar and width aw draws a swing smear;
// spin draws a spinning smear; poke draws a thrust.

// The same hitbox on both sides of the body.
const bothSides = (hitbox) => [hitbox, { ...hitbox, x: -hitbox.x }];

// Normal attacks, shared by every fighter (each scales them by its own reach, tempo and damage).
// The key is also the sprite name:
//   da dash attack · jab1 jab2 jab3 the jab chain
//   gs gu gd grounded smash: side, up, down
//   an as au ad aerials: neutral, side, up, down
// prettier-ignore
export const N = {
  da: { // dash attack
    st: 0.07, ac: 0.18, rc: 0.3, slide: true, poke: true,
    hb: [{ x: 46, y: 2, r: 40, dmg: 10, kb: 300, kbg: 420, ang: 58 }],
  },
  jab1: { // first jab
    st: 0.04, ac: 0.06, rc: 0.1, poke: true, jab: 1,
    hb: [{ x: 50, y: -2, r: 30, dmg: 2, kb: 60, kbg: 0, ang: 20, stunT: 0.26 }],
  },
  jab2: { // second jab
    st: 0.03, ac: 0.06, rc: 0.1, poke: true, jab: 2,
    hb: [{ x: 54, y: 4, r: 30, dmg: 2, kb: 60, kbg: 0, ang: 20, stunT: 0.26 }],
  },
  jab3: { // third jab, the one that knocks away
    st: 0.06, ac: 0.1, rc: 0.24, arc: [-60, 40], ar: 50, aw: 46,
    hb: [{ x: 58, y: 0, r: 38, dmg: 4, kb: 300, kbg: 200, ang: 40 }],
  },
  gs: { // grounded side smash
    st: 0.15, ac: 0.1, rc: 0.26, charge: true, arc: [-100, 30], ar: 58, aw: 54,
    hb: [{ x: 68, y: -4, r: 40, dmg: 12, kb: 330, kbg: 620, ang: 35 }],
  },
  gu: { // grounded up smash
    st: 0.13, ac: 0.12, rc: 0.26, charge: true, arc: [25, -205], ar: 56, aw: 50,
    // overhead, and the start of the swing in front: it scoops up whoever the jabs were hitting
    // (a launcher: it pops a fresh opponent high enough to jump after)
    hb: [
      { x: 8, y: -62, r: 46, dmg: 11, kb: 400, kbg: 540, ang: 86 },
      { x: 52, y: -22, r: 34, dmg: 11, kb: 400, kbg: 540, ang: 86 },
    ],
  },
  gd: { // grounded down smash
    st: 0.13, ac: 0.1, rc: 0.3, charge: true, arc: [-20, 70], ar: 56, aw: 42, mirror: true,
    hb: bothSides({ x: 60, y: 22, r: 34, dmg: 10, kb: 300, kbg: 520, ang: 28 }),
  },
  an: { // neutral air
    st: 0.06, ac: 0.2, rc: 0.1, air: true, spin: true, ar: 50, aw: 40,
    hb: [{ x: 0, y: 0, r: 60, dmg: 6, kb: 200, kbg: 250, ang: 45, away: true }],
  },
  as: { // forward air
    st: 0.1, ac: 0.12, rc: 0.14, air: true, arc: [-85, 55], ar: 58, aw: 50,
    hb: [{ x: 62, y: 0, r: 40, dmg: 9, kb: 260, kbg: 430, ang: 38 }],
  },
  au: { // up air
    st: 0.08, ac: 0.12, rc: 0.12, air: true, arc: [-195, 15], ar: 56, aw: 46,
    hb: [{ x: 0, y: -62, r: 42, dmg: 8, kb: 250, kbg: 420, ang: 85 }],
  },
  ad: { // down air
    st: 0.15, ac: 0.14, rc: 0.2, air: true, arc: [30, 150], ar: 54, aw: 48,
    hb: [{ x: 0, y: 60, r: 38, dmg: 11, kb: 260, kbg: 480, ang: -78 }],
  },
};
for (const key in N) {
  N[key].name = key; // the sprite frames are `${name}-w`, `-a`, `-b` (windup, active, end)
  N[key].normal = true;
}

export const GRAB = {
  name: 'grab',
  st: 0.06,
  ac: 0.1,
  rc: 0.32,
  grab: true,
  hb: [{ x: 48, y: 0, r: 28 }],
};
// The attack out of a ledge climb.
// prettier-ignore
export const GETUP = {
  name: 'getup',
  st: 0.1, ac: 0.1, rc: 0.2, arc: [-30, 60], ar: 54, aw: 44, mirror: true,
  hb: bothSides({ x: 56, y: 10, r: 38, dmg: 7, kb: 280, kbg: 180, ang: 35 }),
};

// Throws by direction: forward, back, up, down.
// prettier-ignore
const THROWS = {
  f: { dmg: 8, kb: 340, kbg: 430, ang: 38 }, b: { dmg: 10, kb: 360, kbg: 520, ang: 40 },
  u: { dmg: 7, kb: 330, kbg: 410, ang: 90 }, d: { dmg: 6, kb: 230, kbg: 180, ang: 78 },
};

// Specials, per fighter. n neutral, s side, u up, d down. The sprite frames are spn, sps, spu, spd.
// prettier-ignore
export const SP = {
  mochi: {
    n: {
      st: 0.18, ac: 0.05, rc: 0.22,
      proj: [{ vx: 620, vy: 0, r: 16, dmg: 6, kb: 160, kbg: 180, ang: 30, life: 1.1, kind: 'puff' }],
    },
    s: {
      st: 0.12, ac: 0.32, rc: 0.2, vx: 820, vy: 0, grav: 0.25, spin: true, ar: 44, aw: 34,
      hb: [{ x: 8, y: 0, r: 46, dmg: 9, kb: 280, kbg: 400, ang: 40 }],
    },
    u: {
      st: 0.08, ac: 0.3, rc: 0.1, vy: -1150, drift: 300, helpless: true, arc: [-10, -170], ar: 46, aw: 40,
      hb: [{ x: 0, y: -30, r: 46, dmg: 7, kb: 260, kbg: 330, ang: 80 }],
    },
    d: {
      type: 'pound', st: 0.2, rc: 0.25,
      hb: [{ x: 0, y: 30, r: 50, dmg: 12, kb: 300, kbg: 520, ang: 70, away: true }],
      land: bothSides({ x: 55, y: 20, r: 40, dmg: 6, kb: 240, kbg: 300, ang: 50 }),
    },
  },
  ember: {
    n: {
      st: 0.14, ac: 0.05, rc: 0.2,
      proj: [
        {
          vx: 520, vy: -260, g: 1400, bounce: 2, r: 14, dmg: 5, kb: 140, kbg: 150, ang: 40, life: 1.6,
          kind: 'fire',
        },
      ],
    },
    s: {
      st: 0.1, ac: 0.22, rc: 0.22, vx: 1250, vy: 0, grav: 0, fire: true,
      hb: [{ x: 0, y: 0, r: 44, dmg: 8, kb: 240, kbg: 380, ang: 50 }],
    },
    u: {
      st: 0.1, ac: 0.26, rc: 0.12, steer: 1150, grav: 0, fire: true, helpless: true,
      hb: [{ x: 0, y: 0, r: 44, dmg: 8, kb: 250, kbg: 360, ang: 75, away: true }],
    },
    d: {
      st: 0.14, ac: 0.12, rc: 0.3, ring: 95, fire: true,
      hb: [{ x: 0, y: 0, r: 95, dmg: 10, kb: 300, kbg: 430, ang: 50, away: true }],
    },
  },
  boulder: {
    n: {
      st: 0.45, ac: 0.12, rc: 0.4, armor: true, charge: true, airCharge: true, poke: true,
      hb: [{ x: 74, y: 0, r: 50, dmg: 22, kb: 420, kbg: 760, ang: 38 }],
    },
    s: {
      st: 0.22, ac: 0.4, rc: 0.3, vx: 700, armor: true,
      hb: [{ x: 30, y: 0, r: 52, dmg: 13, kb: 330, kbg: 480, ang: 45 }],
    },
    u: {
      st: 0.16, ac: 0.34, rc: 0.14, vy: -1250, drift: 160, helpless: true, arc: [-20, -160], ar: 50, aw: 50,
      hb: [{ x: 0, y: -36, r: 50, dmg: 10, kb: 300, kbg: 420, ang: 85 }],
    },
    d: {
      type: 'pound', st: 0.24, rc: 0.34, quake: true,
      hb: [{ x: 0, y: 34, r: 54, dmg: 14, kb: 320, kbg: 540, ang: 70, away: true }],
      land: bothSides({ x: 80, y: 16, r: 70, dmg: 12, kb: 320, kbg: 480, ang: 55 }),
    },
  },
  volt: {
    n: {
      st: 0.12, ac: 0.05, rc: 0.3,
      proj: [
        { vx: 1100, vy: 0, r: 12, dmg: 4, kb: 60, kbg: 40, ang: 20, life: 0.55, stun: 0.5, kind: 'zap' },
      ],
    },
    s: {
      type: 'tele', st: 0.1, ac: 0.1, rc: 0.24, dist: 300, horiz: true,
      hb: [{ x: 0, y: 0, r: 54, dmg: 8, kb: 250, kbg: 380, ang: 60, away: true }],
    },
    u: { type: 'tele', st: 0.14, ac: 0.05, rc: 0.16, dist: 400, helpless: true },
    d: {
      st: 0.28, ac: 0.14, rc: 0.3, bolt: true,
      hb: [
        { x: 0, y: -70, r: 46, dmg: 13, kb: 320, kbg: 560, ang: 88 },
        { x: 0, y: -160, r: 46, dmg: 13, kb: 320, kbg: 560, ang: 88 },
        { x: 0, y: -250, r: 46, dmg: 13, kb: 320, kbg: 560, ang: 88 },
      ],
    },
  },
  bubbles: {
    n: {
      st: 0.2, ac: 0.05, rc: 0.25,
      proj: [{ vx: 240, vy: -20, r: 30, dmg: 8, kb: 260, kbg: 380, ang: 80, life: 2.4, kind: 'bubble' }],
    },
    s: {
      st: 0.1, ac: 0.45, rc: 0.2, vx: 560, vy: 0, grav: 0.2, spin: true, ar: 50, aw: 40, rehit: 0.15,
      hb: [{ x: 0, y: 0, r: 56, dmg: 3, kb: 120, kbg: 110, ang: 60 }],
    },
    u: {
      st: 0.08, ac: 0.7, rc: 0.1, vy: -620, hold: true, grav: 0, helpless: true,
      hb: [{ x: 0, y: -30, r: 40, dmg: 4, kb: 180, kbg: 200, ang: 80 }],
    },
    d: {
      st: 0.1, ac: 0.1, rc: 0.32, ring: 150,
      hb: [{ x: 0, y: 0, r: 150, dmg: 2, kb: 520, kbg: 60, ang: 30, away: true }],
    },
  },
  thorn: {
    n: {
      st: 0.16, ac: 0.05, rc: 0.26,
      proj: [
        // three needles: 9° up, straight, 9° down
        {
          vx: 800 * Math.cos(-9 * DEG), vy: 800 * Math.sin(-9 * DEG), r: 9, dmg: 3, kb: 80, kbg: 60,
          ang: 25, life: 0.5, kind: 'needle',
        },
        { vx: 800, vy: 0, r: 9, dmg: 3, kb: 80, kbg: 60, ang: 25, life: 0.5, kind: 'needle' },
        {
          vx: 800 * Math.cos(9 * DEG), vy: 800 * Math.sin(9 * DEG), r: 9, dmg: 3, kb: 80, kbg: 60,
          ang: 25, life: 0.5, kind: 'needle',
        },
      ],
    },
    s: {
      st: 0.2, ac: 0.1, rc: 0.32, vine: 210,
      hb: [
        { x: 210, y: -4, r: 36, dmg: 13, kb: 330, kbg: 560, ang: 35 },
        { x: 140, y: -4, r: 30, dmg: 8, kb: 240, kbg: 330, ang: 35 },
        { x: 80, y: -4, r: 30, dmg: 8, kb: 240, kbg: 330, ang: 35 },
      ],
    },
    u: {
      st: 0.1, ac: 0.3, rc: 0.12, vy: -1100, drift: 260, spin: true, ar: 50, aw: 40, helpless: true,
      hb: [{ x: 0, y: -40, r: 48, dmg: 8, kb: 260, kbg: 360, ang: 85 }],
    },
    d: { type: 'counter', st: 0.06, ac: 0.5, rc: 0.3 },
  },
  // Gale (pinwheel): little damage, lots of shove
  pinwheel: {
    n: {
      st: 0.15, ac: 0.05, rc: 0.24,
      proj: [{ vx: 760, vy: 0, r: 24, dmg: 4, kb: 290, kbg: 140, ang: 22, life: 0.55, kind: 'gust' }],
    },
    s: {
      st: 0.08, ac: 0.24, rc: 0.22, vx: 1150, vy: -80, grav: 0, spin: true, ar: 46, aw: 36,
      hb: [{ x: 4, y: 0, r: 46, dmg: 7, kb: 280, kbg: 380, ang: 48 }],
    },
    u: {
      st: 0.06, ac: 0.42, rc: 0.1, vy: -1040, drift: 420, spin: true, ar: 50, aw: 40, helpless: true, rehit: 0.12,
      hb: [{ x: 0, y: -10, r: 52, dmg: 3, kb: 150, kbg: 110, ang: 85 }],
    },
    d: {
      st: 0.16, ac: 0.18, rc: 0.3, ring: 125,
      hb: [{ x: 0, y: 0, r: 115, dmg: 6, kb: 370, kbg: 230, ang: 55, away: true }],
    },
  },
};
for (const fighter of Object.values(SP)) {
  fighter.n.name = 'spn';
  fighter.s.name = 'sps';
  fighter.u.name = 'spu';
  fighter.d.name = 'spd';
}

// Stage events (the "Stage events" setting in the Esc menu). Every 20 to 30 s of a match the stage does
// something, always telegraphed first:
//   meadow  a gust of wind shoves everyone sideways, hardest in the air
//   mesa    a giant tumbleweed rolls across the mesa
//   peaks   a snowball rolls across, or a blizzard gust blows through
// Jump over a roller or shield it. Timing uses the seeded rng so matches stay reproducible.

const WARN = 1.4; // seconds of warning before anything happens
const GUST_T = 4; // how long a gust blows
const ROLL_V = 430; // roller speed (world px/s)
export const ROLL_R = 50; // roller radius: low enough to clear with a full jump
const ROLL_HIT = { dmg: 13, kb: 300, kbg: 380, ang: 38 };

// What the renderer reads: { kind: 'gust'|'roll', phase: 'warn'|'on', t, dir, x, y, spin }
export const hazard = { ev: null, next: 0 };

function resetHazards() {
  hazard.ev = null;
  hazard.next = rand(18, 26);
}

// Which events a stage can have; any stage not listed here gets a roller.
const STAGE_EVENTS = { meadow: ['gust'], peaks: ['roll', 'gust'] };

// Each tick of a match: count down to the next event, announce it, then run it (a gust or a roller) until it ends.
function stepHazards(dt, alive) {
  if (G.state !== 'play' || !SETTINGS.events) {
    hazard.ev = null;
    return;
  }
  if (!hazard.ev) {
    hazard.next -= dt;
    if (hazard.next <= 0) announce(alive);
    return;
  }
  const ev = hazard.ev;
  ev.t += dt;
  if (ev.phase === 'warn') {
    if (ev.t < WARN) return;
    ev.phase = 'on';
    ev.t = 0;
    dbg.hazard = G.clock;
    if (ev.kind === 'roll') dbg.rolls = (dbg.rolls || 0) + 1;
    if (ev.kind === 'gust') sfx.gust(GUST_T);
    else sfx.rumble();
  }
  if (ev.kind === 'gust') stepGust(ev, dt, alive);
  else stepRoller(ev, dt, alive);
}

// Picks this stage's event and a side, warns the room (sound, phone buzz, a sign over the edge) and parks a roller offstage.
function announce(alive) {
  const kinds = STAGE_EVENTS[G.stageId] || ['roll'];
  const kind = kinds[Math.floor(rng() * kinds.length)];
  const dir = rng() < 0.5 ? 1 : -1; // 1: it comes in from the left and heads right
  hazard.ev = { kind, phase: 'warn', t: 0, dir, x: 0, y: 0, spin: 0, vy: 0, hitIds: new Set() };
  sfx.warn();
  dbg.warn = G.clock;
  for (const p of alive) tell(p, { t: 'buzz', k: 'warn' }); // phones give a little triple buzz

  const floor = G.stage.main;
  const edge = dir > 0 ? floor.x1 : floor.x2;
  let label = '!';
  if (kind === 'gust') label = dir > 0 ? 'WIND →' : '← WIND';
  popText(edge + dir * 120, floor.y - 260, label, '#ff8fa3', 1.4);
  if (kind === 'roll') {
    hazard.ev.x = edge - dir * (ROLL_R * 3);
    hazard.ev.y = floor.y - ROLL_R;
  }
}

// A gust pushes everyone one way, harder in the air and on light fighters.
function stepGust(ev, dt, alive) {
  const strength = Math.sin(Math.min(1, ev.t / GUST_T) * Math.PI); // swells and dies away
  for (const p of alive) {
    if (p.heldBy || p.ledge || p.hover > 0) continue; // not while held, hanging on, or on the respawn perch
    const push = p.grounded ? 110 : 300;
    p.x += (ev.dir * strength * push * dt) / p.c.weight;
  }
  if (Math.random() < 0.6) {
    // paper scraps and snow blowing through (visual only, so it never touches the seeded rng)
    const floor = G.stage.main;
    const y = floor.y - 40 - vrand(0, 700);
    particles.push({
      x: ev.dir > 0 ? floor.x1 - 400 : floor.x2 + 400,
      y,
      vx: ev.dir * vrand(900, 1400),
      vy: vrand(-60, 60),
      g: 0,
      life: 1.6,
      max: 1.6,
      size: vrand(3, 7),
      color: G.stageId === 'peaks' ? '#ffffff' : '#fff4d6',
      drag: 0.1,
    });
  }
  if (ev.t > GUST_T) endHazard();
}

// A roller crosses the main floor, hitting each fighter once, then drops off the far edge.
function stepRoller(ev, dt, alive) {
  const stage = G.stage;
  const floor = stage.main;
  ev.x += ev.dir * ROLL_V * dt;
  ev.spin += ((ev.dir * ROLL_V) / ROLL_R) * dt;
  const onFloor = ev.x > floor.x1 - ROLL_R * 0.3 && ev.x < floor.x2 + ROLL_R * 0.3;
  if (onFloor) ev.entered = true;
  if (!ev.entered || (onFloor && ev.vy === 0)) {
    // rolling along the floor (or still on its way to it), kicking up dust
    ev.y = floor.y - ROLL_R;
    if (rng() < 0.3) puff(ev.x - ev.dir * ROLL_R * 0.6, floor.y, '#e8d8c0', 1, 120, -200);
  } else {
    // past the far edge: it falls away
    ev.vy += 1800 * dt;
    ev.y += ev.vy * dt;
  }
  const reach = ROLL_R * 0.85; // a forgiving hitbox: grazing the top doesn't count
  for (const p of alive) {
    if (ev.hitIds.has(p.id) || !vulnerable(p)) continue;
    if (Math.hypot(p.x - ev.x, p.y - ev.y) >= reach + p.R * 0.7) continue;
    ev.hitIds.add(p.id);
    dbg.rollHits = (dbg.rollHits || 0) + 1;
    hit(null, p, ROLL_HIT, ev.dir, 1, 1, 'proj', { x: ev.x, y: ev.y });
  }
  const blast = stage.blast;
  if (ev.y > blast.b || ev.x < blast.l - 200 || ev.x > blast.r + 200) endHazard();
}

function endHazard() {
  hazard.ev = null;
  hazard.next = rand(20, 30);
}

// Bot players: pick a target, approach, space, attack, recover to the stage, tech, edge-guard and jump stage hazards.
// Skill (easy/normal/hard) scales reaction times and mistakes. Uses the seeded rng so matches replay exactly.

// A bot's state (p.bot, `bt` below) is mostly timers:
//   a, s, j, d   how much longer each button (attack, special, jump, shield) stays pressed
//   sx, sy, st   a stick direction to hold, and for how much longer
//   t            time until the next decision; r, the same for recovery moves and hazard jumps
//   plan, pt     a short-hop aerial under way, and time until its attack

// "Presses" a button for t seconds.
function press(bt, button, t = 0.08) {
  bt[button] = t;
}

// Holds the stick at (x, y) for t seconds, whatever else the bot decides meanwhile.
function holdStick(bt, x, y, t) {
  bt.sx = x;
  bt.sy = y;
  bt.st = t;
}

// One think: pick what to do for the situation the bot is in, then turn it into stick and button input.
function botThink(p, dt) {
  const bt = p.bot;
  bt.t -= dt;
  bt.r = (bt.r || 0) - dt;
  bt.a -= dt;
  bt.s -= dt;
  bt.j -= dt;
  bt.d -= dt;
  bt.st -= dt;
  if (bt.next) {
    // a press queued for this tick (the button had to come up first)
    press(bt, bt.next);
    bt.next = null;
  }
  let x = 0;
  let y = 0;
  const ledge = G.stage.ledges[p.x < 0 ? 0 : 1]; // the one on the bot's side
  if (p.heldBy) {
    if (rng() < dt * 12) press(bt, 'a', 0.04); // mash out of grabs
  } else if (p.hitstun > 0) {
    [x, y] = survive(p, bt);
  } else if (p.ledge) {
    onLedge(p, bt, ledge.side);
  } else if (p.holding) {
    throwSomewhere(p, bt);
  } else {
    [x, y] = free(p, bt, ledge, dt);
  }
  if (bt.st > 0) {
    x = bt.sx;
    y = bt.sy;
  }
  p.in.x = x;
  p.in.y = y;
  p.in.b = (bt.a > 0 ? BTN.A : 0) | (bt.s > 0 ? BTN.S : 0) | (bt.j > 0 ? BTN.J : 0) | (bt.d > 0 ? BTN.D : 0);
}

// Launched: hold the stick up and toward the middle to survive, and try to tech the landing.
function survive(p, bt) {
  const falling = p.vy + p.kvy > 0;
  const feet = p.y + p.R;
  const aboutToLand = G.stage.plats.some(
    (plat) => p.x > plat.x1 && p.x < plat.x2 && plat.y - feet > 0 && plat.y - feet < 50,
  );
  if (falling && !bt.teched && aboutToLand) {
    bt.teched = true;
    if (rng() < 0.75 - bt.skill * 0.3) press(bt, 'd', 0.05);
  }
  return [p.x > 0 ? -0.75 : 0.75, -0.65];
}

// Hanging on a ledge: after a moment, climb, jump, attack or roll up.
function onLedge(p, bt, side) {
  if (bt.t > 0 || p.hangT <= 0.25) return;
  const roll = rng();
  if (roll < 0.5) holdStick(bt, -side, 0, 0.2);
  else if (roll < 0.75) press(bt, 'j', 0.1);
  else if (roll < 0.9) press(bt, 'a');
  else press(bt, 'd');
  bt.t = 0.5;
}

// prettier-ignore
const THROW_DIRECTIONS = [[1, 0], [-1, 0], [0, -1], [0, 1]];

// Holding someone: pummel now and then, or throw in a random direction.
function throwSomewhere(p, bt) {
  if (p.holdT <= 0.2 || bt.t > 0) return;
  if (rng() < 0.3) {
    press(bt, 'a');
  } else {
    const [x, y] = THROW_DIRECTIONS[Math.floor(rng() * THROW_DIRECTIONS.length)];
    holdStick(bt, x, y, 0.1);
  }
  bt.t = 0.25;
}

// Free to act: jump stage hazards, then either recover to the stage or go after the nearest foe.
function free(p, bt, ledge, dt) {
  bt.teched = false;
  jumpRoller(p, bt);
  const [target, dist] = nearestFoe(p);
  const out = (p.x - ledge.x) * ledge.side; // how far past the ledge, away from the stage
  const offStage = !p.grounded && (out > -10 || p.y > G.stage.y + 10);
  const ready = canAct(p);
  if (offStage) return [recover(p, bt, ledge, out, ready), 0];
  if (target) return fight(p, bt, target, dist, ready, dt);
  return [0, 0];
}

// A roller coming along the floor: jump it (sharper bots wait for the last moment).
function jumpRoller(p, bt) {
  const ev = hazard.ev;
  if (!ev || ev.kind !== 'roll' || ev.phase !== 'on') return;
  const inItsPath = p.grounded && p.plat === G.stage.main && sign(p.x - ev.x) === ev.dir;
  if (!inItsPath) return;
  const gap = Math.abs(p.x - ev.x) - ROLL_R - p.R;
  if (gap < 60 + bt.skill * 90 && bt.r <= 0 && rng() < 0.85 - bt.skill * 0.25) {
    press(bt, 'j', 0.3);
    bt.r = 0.5;
  }
}

// Returns [the nearest foe in play, how far away they are].
function nearestFoe(p) {
  let nearest = null;
  let best = 1e9;
  for (const q of players.values()) {
    if (q === p || !q.alive || q.hover > 0) continue;
    const dist = Math.hypot(q.x - p.x, q.y - p.y);
    if (dist < best) {
      best = dist;
      nearest = q;
    }
  }
  return [nearest, best];
}

// Off stage: get out from under the island, then head for the ledge, using wall jumps, air jumps and the up special.
// Returns the stick x.
function recover(p, bt, ledge, out, ready) {
  const side = ledge.side;
  const under = p.y > ledge.y + 30 && out < 45; // beneath the island: head outward first
  const low = p.y > ledge.y - 60;
  const falling = p.vy + p.kvy > 0;
  if (p.wallT > 0 && p.wallJumps > 0 && p.y > ledge.y + 40 && bt.r <= 0) {
    press(bt, 'j', 0.25); // wall jump
    bt.r = 0.3;
  } else if (p.hitstun <= 0 && bt.r <= 0 && low && (falling || p.y > ledge.y + 60)) {
    if (p.airJumps > 0) {
      press(bt, 'j', 0.3);
      bt.r = 0.3;
    } else if (!p.helpless && ready) {
      holdStick(bt, under ? side * 0.35 : -side * 0.5, -1, 0.25); // up special
      press(bt, 's');
      bt.r = 0.6;
    }
  }
  return under ? side : -side;
}

// On stage with a target: close the distance without running off the edge, then pick an action when ready.
// Returns the stick [x, y].
function fight(p, bt, target, dist, ready, dt) {
  const half = G.stage.half;
  const dx = target.x - p.x;
  const dy = target.y - p.y;
  const distX = Math.abs(dx);
  if (bt.plan) bt.pt -= dt;
  if (bt.plan && bt.pt <= 0) {
    // second half of a short-hop aerial
    bt.plan = null;
    if (!p.grounded && canAct(p)) {
      let aimY = 0;
      if (dy < -50) aimY = -1;
      else if (dy > 50) aimY = 1;
      holdStick(bt, distX > 30 ? sign(dx) : 0, aimY, 0.12);
      press(bt, 'a');
    }
  }
  followUp(p, bt, dx, dy);
  const range = 72 * p.size * p.c.reach + target.R;
  const targetOff = Math.abs(target.x) > half + 40 || target.y > G.stage.y + 60; // the target is off stage
  let x = distX > range * 0.75 ? sign(dx) : 0;
  let y = 0;
  if (targetOff && Math.abs(p.x) > half - 120) x = 0; // don't chase off the edge
  if (p.grounded && p.plat && p.plat.solid && Math.abs(p.x + x * 70) > half - 20) x = 0; // nor walk off it
  if (!p.grounded && Math.abs(p.x + p.vx * 0.3) > half - 30) x = p.x > 0 ? -1 : 1; // drift back over the stage
  if (dy > 110 && p.grounded && p.plat && !p.plat.solid && distX < 220) y = 1; // drop through to a target below
  if (bt.t <= 0 && ready) decide(p, bt, target, dist, { dx, dy, distX, range, targetOff, half });
  return [x, y];
}

// The bot's attack has just landed: sharper bots go straight on, with a jump after a foe sent upward or a different
// attack at one still in reach. One roll of the dice per landed move.
function followUp(p, bt, dx, dy) {
  const move = p.move;
  if (!move || !move.landed || move.followed || !move.def.normal) return;
  move.followed = true;
  if (rng() > clamp(1.05 - bt.skill * 0.8, 0.05, 0.8)) return;
  const toward = sign(dx);
  const sentUp = move.def.hb[0].ang > 60;
  const canJump = p.grounded || p.airJumps > 0;
  if (sentUp && canJump) {
    // jump after them; fight() adds the aerial once airborne
    holdStick(bt, toward * 0.6, 0, 0.2);
    press(bt, 'j', 0.12);
    bt.plan = 'air';
    bt.pt = 0.14;
    bt.t = 0.3;
    return;
  }
  // a different attack: the next jab from a jab, else whichever way the target is
  let aimX = toward;
  let aimY = 0;
  if (move.def.jab === 1) {
    aimX = 0;
  } else if (dy < -40 || (p.grounded && !move.string.has(N.gu))) {
    aimX = 0;
    aimY = -1;
  } else if (dy > 40 && !p.grounded) {
    aimX = 0;
    aimY = 1;
  }
  holdStick(bt, aimX, aimY, 0.14);
  bt.a = 0; // let go first, so this counts as a new press
  bt.next = 'a';
  bt.t = 0.2;
}

// The action menu, in priority order: grab a shield, dodge an incoming attack, edge-guard with a projectile, short
// hop in, jump after someone above, attack in range, or throw a projectile from mid range. The dice (rng) are only
// rolled for an option once everything else about it fits, and bt.t is how long until the next decision.
function decide(p, bt, target, dist, { dx, dy, distX, range, targetOff, half }) {
  const toward = sign(dx);

  const canGrabShield = target.shielding && p.grounded && distX < range + 10 && Math.abs(dy) < 40;
  if (canGrabShield) {
    press(bt, 'd', 0.12);
    press(bt, 'a');
    bt.t = 0.5;
    return;
  }

  const attackComing = target.move && target.move.phase === 'startup' && dist < 140 && p.grounded;
  if (attackComing && rng() < 0.55 - bt.skill * 0.2) {
    if (rng() < 0.6) {
      press(bt, 'd', rand(0.2, 0.35)); // shield it
      holdStick(bt, 0, 0, 0.25);
    } else {
      press(bt, 'd', 0.1); // spot dodge
      holdStick(bt, 0, 1, 0.1);
    }
    bt.t = 0.35;
    return;
  }

  const canEdgeGuard = targetOff && p.grounded && Math.abs(p.x) > half - 220 && sign(target.x) === sign(p.x);
  if (canEdgeGuard && SP[p.ch].n.proj && rng() < 0.45) {
    p.face = toward;
    holdStick(bt, 0, 0, 0.1);
    press(bt, 's');
    bt.t = rand(0.5, 0.9) * bt.skill;
    return;
  }

  const hopRange = p.grounded && !targetOff && distX > range + 15 && distX < 270 && Math.abs(dy) < 60;
  if (hopRange && rng() < 0.35) {
    // short hop in; fight() follows up with the aerial
    press(bt, 'j', 0.03);
    bt.plan = 'air';
    bt.pt = 0.14;
    bt.t = 0.45;
    return;
  }

  const canJump = p.grounded || (p.airJumps > 0 && p.vy > 0);
  if (dy < -100 && distX < 240 && !targetOff && canJump && rng() < 0.6) {
    press(bt, 'j', 0.3);
    bt.t = 0.3;
    return;
  }

  if (distX < range + 25 && Math.abs(dy) < range + 45) {
    // in range: aim the attack at where the target is
    let aimX = toward;
    let aimY = 0;
    if (dy < -45 && distX < 70) {
      aimX = 0;
      aimY = -1;
    } else if (dy > 45 && !p.grounded && distX < 60) {
      aimX = 0;
      aimY = 1;
    } else if (rng() < 0.2) {
      aimX = 0; // a jab
      p.face = toward;
    }
    if (rng() < 0.2 && Math.abs(p.x + aimX * 300) < half) press(bt, 's');
    else press(bt, 'a', rng() < 0.3 ? rand(0.25, 0.75) : 0.08); // sometimes held, to charge a smash
    holdStick(bt, aimX, aimY, 0.16);
    bt.t = rand(0.14, 0.38) * bt.skill;
    return;
  }

  const midRange = distX > 220 && distX < 620 && Math.abs(dy) < 70 && Math.abs(p.x + toward * 330) < half;
  if (midRange && rng() < 0.3) {
    p.face = toward;
    holdStick(bt, 0, 0, 0.12);
    press(bt, 's');
    bt.t = rand(0.6, 1.2) * bt.skill;
    return;
  }

  bt.t = 0.08;
}

// One fighter's tick: input, running, jumping, wall jumps, ledges, dodges, gravity, platform collision and respawn.

const SPEED_ITEM_BOOST = 1.35;
const runSpeedOf = (p) => p.c.speed * (p.speedT > 0 ? SPEED_ITEM_BOOST : 1);

// How far up the stick has to be pushed to jump, and how far back it has to come before it can jump again. A push that
// is more up than sideways counts from less far out: a thumb on glass rarely travels the whole way.
const UP_TO_JUMP = 0.65;
const UP_MOSTLY = 0.45;
const UP_LET_GO = 0.3;
const pushedUp = (inp) => inp.y < -UP_TO_JUMP || (inp.y < -UP_MOSTLY && -inp.y > Math.abs(inp.x));
// In the air, a jump from the stick waits this long for Attack or Special: with one, the push was aiming an up attack
// and the air jump is kept.
const AIM_GRACE = 0.06;
// A flick: the stick was near the middle this recently and is now far out. A few ticks, since thumbs are slower than keys.
const FLICK_T = 0.05;

// A jump is held up by whatever started it: the Jump button, or a keyboard's Up key (jumpSrc 's'). A phone's stick
// always jumps full height: the thumb is free to steer and aim straight away, and the Jump button does the short hop.
function jumpHeld(p, inp) {
  if (p.jumpSrc !== 's') return inp.b & BTN.J;
  if (!p.kb) return true;
  return inp.y < -0.4;
}

// Steering in the air: accelerate toward the stick up to drift speed, and ease off when it is let go.
function airControl(p, inp, sp, dt) {
  const maxDrift = sp * 0.9;
  const stick = inp.x;
  const accel = sp * 5.5 * dt;
  const steering = Math.abs(stick) > 0.15;
  if (Math.abs(p.vx) > maxDrift) {
    // faster than drift speed (dash jump, wall jump): bleed off gently
    p.vx = sign(p.vx) * (maxDrift + (Math.abs(p.vx) - maxDrift) * Math.exp(-2.2 * dt));
    if (steering && sign(stick) !== sign(p.vx)) p.vx += stick * accel;
  } else if (steering) {
    p.vx = clamp(p.vx + stick * accel, -maxDrift, maxDrift);
  } else {
    p.vx *= Math.exp(-1.4 * dt);
  }
}

// White streaks left behind by a burst of speed (a dash or a dash attack).
function speedLines(p, dir) {
  for (let i = 0; i < 4; i++) {
    particles.push({
      x: p.x - dir * p.R * rand(0.3, 1.1),
      y: p.y + rand(-p.R * 0.7, p.R * 0.7),
      vx: -dir * rand(500, 900),
      vy: 0,
      life: rand(0.1, 0.18),
      max: 0.18,
      size: rand(2, 3.5),
      color: '#ffffff',
      drag: 6,
      streak: 1,
    });
  }
}

// Leaves the ground at the end of the jump squat. Letting go of jump during the squat gives a short hop.
function doJump(p, inp) {
  const sp = runSpeedOf(p);
  p.linkString = null;
  p.squat = 0;
  p.coyote = 0;
  p.vy = -p.c.jump * JUMP_K;
  p.grounded = false;
  p.plat = null;
  p.ff = false;
  p.sqV = 8;
  p.shortOK = true;
  p.jumpT = 0;
  if (!jumpHeld(p, inp)) {
    p.vy *= 0.62;
    p.shortOK = false;
  }
  if (Math.abs(inp.x) > 0.3) {
    // jumping sideways carries at least most of a run's speed, and all of a dash's
    const dir = sign(inp.x);
    const carried = sign(p.vx) === dir ? Math.abs(p.vx) : 0;
    p.vx = dir * Math.max(carried, sp * 0.7);
  }
  dust(p.x, p.y + p.R, 1, 3);
  dust(p.x, p.y + p.R, -1, 3);
  sfx.jump();
}

function wallJump(p, sp) {
  p.bufJ = 0;
  p.wallJumps--;
  p.wallT = 0;
  p.wallSlideT = 0;
  p.vy = -p.c.jump * JUMP_K * 0.95;
  p.vx = -p.wallSide * sp * 1.05;
  p.face = -p.wallSide;
  p.ff = false;
  p.shortOK = false;
  p.sqV = 6;
  p.dashT = 0.16;
  p.helpless = false;
  const wallX = p.x + p.wallSide * p.R * 0.8;
  sparks(wallX, p.y, '#ffffff', 7, 450);
  dust(wallX, p.y + p.R * 0.3, -p.wallSide, 4);
  ring(wallX, p.y, 10, 56, 0.22, '#ffffff', false, { kind: 'wall' });
  sfx.walljump();
  dbg.wall = G.clock;
}

// The second jump, in mid-air.
function airJump(p, inp, sp) {
  p.bufJ = 0;
  p.airJumps--;
  p.vy = -p.c.jump * JUMP_K * 0.92;
  p.sqV = 6;
  p.ff = false;
  p.shortOK = false;
  p.flipT = 0.3;
  if (Math.abs(inp.x) > 0.2) p.vx = inp.x * sp * 0.85;
  // stepping off the air: a flat hoop under the feet that sinks away, and a puff kicked out to each side
  ring(p.x, p.y + p.R * 0.9, 10, 60, 0.26, '#ffffff', false, { kind: 'air' });
  for (const side of [-1, 1]) {
    smokes.push({
      x: p.x + side * p.R * 0.3,
      y: p.y + p.R,
      vx: side * 170,
      vy: 90,
      r: p.R * 0.24,
      grow: 16,
      life: 0.3,
      max: 0.3,
    });
  }
  sfx.jump2();
}

// A player's name in their tag colour, for the feed.
const nameTag = (p) => `<b style="color:${p.tag}">${esc(p.name)}</b>`;

// Ends a combo on p and celebrates it if it was a good one.
function comboEnd(p) {
  if (p.combo >= 3 && p.comboDmg >= 20) {
    const attacker = players.get(p.comboBy);
    popText(p.x, p.y - p.R * 2.6, `${p.combo}-HIT COMBO!`, '#ffd166', 1.6, 'c' + p.id);
    if (attacker && p.combo >= 4) {
      feed(`${nameTag(attacker)} landed a ${p.combo}-hit combo · ${Math.round(p.comboDmg)}%`);
    }
    sfx.combo(p.combo);
    dbg.combo = G.clock;
  }
  p.combo = 0;
  p.comboDmg = 0;
}

// One tick of one fighter. Reads top to bottom as phases; each phase that ends the fighter's turn returns early.
function updateFighter(p, dt, frozen) {
  // presses since the last tick (see setButtons); none carry over a pause
  const tapped = frozen ? 0 : p.in.tap || 0;
  p.in.tap = 0;
  if (!p.alive) {
    whileDown(p, dt);
    return;
  }
  if (p.bot && !frozen) botThink(p, dt);
  const inp = frozen ? ZERO : p.in;
  const buttons = inp.b | tapped;
  const pressed = buttons & ~p.prevB;
  p.prevB = buttons;
  tickTimers(p, dt, pressed);

  if (p.freeze > 0) {
    p.freeze -= dt;
    return;
  }

  // a flick is the stick going from near the middle to far out in a moment; it counts once per push
  p.midX = Math.abs(inp.x) < 0.4 ? FLICK_T : p.midX - dt;
  p.midY = inp.y < 0.4 ? FLICK_T : p.midY - dt;
  const farX = Math.abs(inp.x) > 0.75;
  const farDown = inp.y > 0.75;
  const flickSide = farX && !p.outX && p.midX > 0;
  const flickDown = farDown && !p.outY && p.midY > 0;
  p.outX = farX;
  p.outY = farDown;
  p.flickD = flickDown; // fast fall needs a flick down, not just a held stick (phones drift)
  p.flickS = flickSide; // and the dash attack a flick sideways
  const rememberStick = () => {
    p.lastX = inp.x;
    p.lastY = inp.y;
  };
  // Pushing the stick up jumps, however fast or slowly the thumb gets there (a keyboard's Up key is the same thing,
  // all at once). It has to come back toward the middle before it can jump again, so a thumb resting high doesn't
  // spend the air jump.
  if (inp.y > -UP_LET_GO) p.upSpent = false;
  if (p.tapJump && !p.upSpent && pushedUp(inp)) {
    p.upSpent = true;
    p.bufJ = BUFFER_T;
    p.tapJ = true;
    p.aimT = p.grounded ? 0 : AIM_GRACE;
  }
  if (pressed & BTN.J) p.tapJ = false;

  if (p.hover > 0) {
    onRespawnPerch(p, inp, buttons, dt);
    rememberStick();
    return;
  }
  if (p.heldBy) {
    // mashing buttons or flicking the stick breaks out of a grab sooner
    if (pressed || flickSide || flickDown) p.escape -= 0.11;
    p.escape -= dt;
    if (p.escape <= 0) breakFree(p);
    rememberStick();
    return;
  }
  if (p.ledge) {
    ledgeUpdate(p, inp, pressed, dt);
    rememberStick();
    return;
  }

  const sp = runSpeedOf(p);
  const gravity = act(p, inp, buttons, pressed, flickSide, flickDown, sp, dt);
  rememberStick();
  fall(p, inp, gravity, dt);
  moveAndLand(p, dt);
}

// Knocked out: count down to the respawn perch (not while out of lives mid-match, nor during the winner close-up).
function whileDown(p, dt) {
  if (G.state === 'result' && G.stT < 4) return; // stay off-screen while the camera is on the winner
  const outOfLives = p.out && G.state === 'play';
  if (p.respawnT > 0 && !outOfLives) {
    p.respawnT -= dt;
    if (p.respawnT <= 0) {
      respawn(p, false);
      if (G.state === 'play') tell(p, { t: 'st', s: 'play' });
    }
  } else if ((G.state === 'lobby' || G.state === 'result') && p.respawnT <= 0) {
    respawn(p, false);
  }
}

// Waiting on the respawn perch: after a moment, any input steps off it; either way it ends with a spell of invulnerability.
function onRespawnPerch(p, inp, buttons, dt) {
  p.hover -= dt;
  p.vx = p.vy = 0;
  if (p.hover < 1.8 && (Math.hypot(inp.x, inp.y) > 0.4 || buttons)) p.hover = 0;
  if (p.hover <= 0) p.invuln = Math.max(p.invuln, 1.2);
}

// Input buffers, cooldowns, power-up timers, squash-and-stretch spring and shield regrowth.
function tickTimers(p, dt, pressed) {
  if (pressed & BTN.A) p.bufA = BUFFER_T;
  if (pressed & BTN.S) p.bufS = BUFFER_T;
  if (pressed & BTN.J) p.bufJ = BUFFER_T;
  if (pressed & BTN.D) p.bufD = BUFFER_T;
  p.bufA -= dt;
  p.bufS -= dt;
  p.bufJ -= dt;
  p.bufD -= dt;
  p.aimT -= dt;

  p.invuln -= dt;
  p.flashT -= dt;
  p.stunImm -= dt;
  p.dropT -= dt;
  p.ledgeCd -= dt;
  p.techW -= dt;
  p.throwT -= dt;
  p.climbT -= dt;
  p.jumpT += dt;
  p.coyote -= dt;
  p.teeter -= dt;
  p.wallT -= dt;
  p.wallSlideT -= dt;
  p.slideT -= dt;
  p.dashT -= dt;
  p.flipT -= dt;
  p.skidT -= dt;
  p.crouch = false;
  if (p.heavyT > 0) p.heavyT -= dt;
  if (p.speedT > 0) p.speedT -= dt;

  // squash and stretch: a damped spring back to the fighter's own shape
  p.sqV += (-700 * p.sq - 22 * p.sqV) * dt;
  p.sq = clamp(p.sq + p.sqV * dt, -0.4, 0.4);

  if (!p.shielding) p.shieldHP = Math.min(100, p.shieldHP + 10 * dt);
}

// What the fighter is busy with decides what input can do this tick. Returns the gravity scale for the fall phase.
function act(p, inp, buttons, pressed, flickSide, flickDown, sp, dt) {
  const gravity = p.c.grav;
  if (p.holding) {
    holdGrab(p, inp, dt);
    return gravity;
  }
  if (p.hitstun > 0) {
    tumble(p, inp, pressed, dt);
    return gravity * 0.6;
  }
  if (p.dizzy > 0) {
    p.dizzy -= dt;
    if (p.grounded) p.vx *= Math.exp(-10 * dt);
    return gravity;
  }
  if (p.move) return continueMove(p, inp, buttons, gravity, sp, dt);
  if (p.dodgeT > 0) return continueDodge(p, gravity, dt);
  if (p.lag > 0) {
    // landing or recovery lag: no new actions yet
    p.lag -= dt;
    if (p.grounded) p.vx *= Math.exp(-(p.slideT > 0 ? 3 : 14) * dt);
    else airControl(p, inp, sp, dt);
    return gravity;
  }
  if (p.squat > 0) {
    jumpSquat(p, inp, dt);
    return gravity;
  }

  // free: shield / grab / dodge, then attacks, then jumps and movement
  defend(p, inp, buttons, flickSide, flickDown, dt);
  if (!p.move && p.dodgeT <= 0 && p.dizzy <= 0 && !p.helpless && !p.shielding) attack(p, inp);
  if (!p.move && p.dodgeT <= 0 && p.dizzy <= 0) {
    jump(p, inp, buttons, sp);
    run(p, inp, flickSide, sp, dt);
  }
  return gravity;
}

// Launched and tumbling: the stick drifts against the launch, and Shield just before the floor sets up a tech.
function tumble(p, inp, pressed, dt) {
  p.hitstun -= dt;
  p.kvx += inp.x * 480 * dt;
  if (p.hitstun <= 0) comboEnd(p);
  if (pressed & BTN.D) p.techW = 0.25;
  if (p.grounded) p.vx *= Math.exp(-10 * dt);
}

// Mid-attack: the move runs itself (updateMove), and the fighter can still walk or drift unless the move is driving.
function continueMove(p, inp, buttons, gravity, sp, dt) {
  const def = p.move.def;
  gravity = updateMove(p, dt, inp, gravity);
  const move = p.move; // null if the move has just ended
  if (!move) return gravity;
  if (linkMove(p, inp, buttons, sp)) return gravity;

  const selfPropelled = def.vx != null || def.steer || def.type === 'pound' || def.type === 'tele';
  const driven = move.phase === 'active' && selfPropelled;
  if (p.grounded) {
    if (driven && def.vx != null) p.vx = def.vx * p.face;
    else if (def.slide && move.phase !== 'recovery') p.vx *= Math.exp(-2.5 * dt);
    else if (!driven) attackWalk(p, inp, move, sp, dt);
  } else if (!driven) {
    airControl(p, inp, sp, dt); // full drift while attacking in the air
  }
  return gravity;
}

// Links are what let hits flow into each other:
//  - a normal that has landed can be cut short at once, into a jump, a special, or a normal not yet used in this string;
//  - an aerial that missed can still go into a different aerial partway through its recovery.
// Returns true when the move was replaced.
const AERIAL_LINK = 0.35; // the share of a missed aerial's recovery that plays before the next aerial may start
function linkMove(p, inp, buttons, sp) {
  const move = p.move;
  const def = move.def;
  if (!def.normal) return false;
  const missedAerial = def.air && !p.grounded && move.phase === 'recovery';
  const aerialCanLink = missedAerial && move.t >= def.rc * move.k * AERIAL_LINK;
  if (!move.landed && !aerialCanLink) return false;

  if (move.landed) {
    const aiming = p.tapJ && p.aimT > 0;
    const canJump = p.grounded || (p.airJumps > 0 && !p.helpless);
    if (p.bufJ > 0 && canJump && !aiming) {
      p.move = null;
      jump(p, inp, buttons, sp);
      p.linkString = move.string; // an up attack out of the jump squat is still part of this string
      linked(p);
      return true;
    }
    if (p.bufS > 0) {
      p.move = null;
      attack(p, inp);
      linked(p);
      return true;
    }
  }
  if (p.bufA <= 0) return false;
  const dir = dirOf(inp);
  const next = nextInString(p, dir, move);
  if (!next) return false;
  p.bufA = 0;
  if (dir === 's') p.face = sign(inp.x);
  startMove(p, next, BTN.A, move.string);
  if (move.landed) linked(p);
  return true;
}

// The normal that would carry a string on in direction dir, or null if this string has already used it. Standing with
// the stick at rest runs through the jabs in order.
const JABS = [N.jab1, N.jab2, N.jab3];
function nextInString(p, dir, move) {
  const fresh = (def) => !move.string.has(def);
  if (p.grounded && dir === 'n') return JABS.slice(move.def.jab || 0).find(fresh) || null;
  const next = N[(p.grounded ? 'g' : 'a') + dir];
  return fresh(next) ? next : null;
}

// A landed hit went straight into something else: leave an afterimage where the first move was cut.
function linked(p) {
  ghosts.push({ x: p.x, y: p.y, face: p.face, ch: p.ch, s: p.R, col: p.light, life: 0.22, max: 0.22 });
  dbg.link = G.clock;
}

// Mid-dodge (roll, spot dodge or air dodge): it runs its course, then leaves a moment of lag.
function continueDodge(p, gravity, dt) {
  p.dodgeT -= dt;
  if (!p.grounded) gravity *= 0.3;
  else if (!p.spot) p.vx *= Math.exp(-3 * dt);
  if (p.dodgeT <= 0) {
    if (p.grounded) {
      p.vx = 0;
    } else {
      p.vx *= 0.4;
      p.vy *= 0.4;
    }
    p.lag = 0.07;
    p.spot = false;
    p.airDodge = false;
  }
  return gravity;
}

// Jump squat: a moment crouched before take-off. Up + Attack during it comes out as an up smash instead.
function jumpSquat(p, inp, dt) {
  p.squat -= dt;
  p.vx *= Math.exp(-3 * dt);
  p.shielding = false;
  // Attack while the stick's push up is still winding into a jump: the push was aiming an up attack. (A jump from the
  // button is a jump; and a string that has had its up attack jumps too, so the squat can't loop one.)
  const string = p.linkString;
  const aimedUp = p.jumpSrc === 's' && p.bufA > 0 && inp.y < -0.45 && !(string && string.has(N.gu));
  if (p.grounded && aimedUp) {
    p.squat = 0;
    p.bufA = 0;
    p.linkString = null;
    startMove(p, N.gu, BTN.A, string || new Set());
  } else if (p.squat <= 0) {
    doJump(p, inp);
  }
}

// Moving while attacking on the ground: the fighter keeps walking where the stick points, slower than a run (slower
// still while charging), without turning round mid-swing. Grabs plant the feet; moves that drive the fighter themselves
// (dash attack, charging specials) are handled by the caller.
function attackWalk(p, inp, move, sp, dt) {
  const lean = Math.abs(inp.x);
  if (move.def.grab || lean < 0.2) {
    p.vx *= Math.exp(-12 * dt);
    return;
  }
  const pace = move.phase === 'charge' ? 0.35 : 0.6;
  const want = sign(inp.x) * sp * pace * Math.min(1, lean);
  p.vx += (want - p.vx) * (1 - Math.exp(-14 * dt));
}

// Holding someone: pummel with Attack, push the stick to throw, or throw forward automatically after a while.
function holdGrab(p, inp, dt) {
  const held = p.holding;
  p.holdT += dt;
  p.pummelT -= dt;
  p.vx = 0;
  held.x = p.x + p.face * (p.R + held.R) * 0.72;
  held.y = p.y + p.R - held.R;
  if (p.holdT <= 0.12) return; // a beat before anything else, so the grab itself reads

  const dir = throwDirection(p, inp);
  if (dir) {
    doThrow(p, dir);
  } else if (p.bufA > 0 && p.pummelT <= 0) {
    p.bufA = 0;
    p.pummelT = 0.3;
    pummel(p);
  } else if (p.holdT > 1.6) {
    doThrow(p, 'f');
  }
}

// Forward, back, up or down, by where the stick is pushed; null while it is near the middle.
function throwDirection(p, inp) {
  if (Math.abs(inp.x) > 0.6 && Math.abs(inp.x) >= Math.abs(inp.y)) return sign(inp.x) === p.face ? 'f' : 'b';
  if (inp.y < -0.6) return 'u';
  if (inp.y > 0.6) return 'd';
  return null;
}

// On the ground Shield blocks (Attack grabs, a flick rolls or spot-dodges); in the air it is an air dodge.
function defend(p, inp, buttons, flickSide, flickDown, dt) {
  if (p.grounded) {
    groundShield(p, inp, buttons, flickSide, flickDown, dt);
  } else {
    p.shielding = false;
    airDodge(p, inp);
  }
}

function groundShield(p, inp, buttons, flickSide, flickDown, dt) {
  if (!(buttons & BTN.D)) {
    p.shielding = false;
    return;
  }
  if (!p.shielding) {
    p.shielding = true;
    p.shieldAt = G.clock;
  }
  if (p.bufA > 0) {
    p.bufA = 0;
    p.shielding = false;
    startMove(p, GRAB, BTN.A);
  } else if (flickSide) {
    roll(p, sign(inp.x));
  } else if (flickDown) {
    spotDodge(p);
  } else {
    // a held shield wears down, and breaks if it runs out
    p.shieldHP -= 14 * dt;
    if (p.shieldHP <= 0) shieldBreak(p);
  }
}

// One air dodge per airtime: a burst where the stick points, or a hover in place with the stick at rest.
const AIR_DODGE_SPEED = 720;
function airDodge(p, inp) {
  const canDodge = p.bufD > 0 && !p.airDodged && !p.helpless;
  if (!canDodge) return;
  p.bufD = 0;
  p.airDodged = true;
  p.airDodge = true;
  p.dodgeT = 0.32;
  p.ff = false;
  p.dashT = 0.2;
  const lean = Math.hypot(inp.x, inp.y);
  if (lean > 0.3) {
    p.vx = (inp.x / lean) * AIR_DODGE_SPEED;
    p.vy = (inp.y / lean) * AIR_DODGE_SPEED;
  } else {
    p.vx *= 0.3;
    p.vy = 0;
  }
  sfx.dodge();
}

// Special (by stick direction) or Attack: dash attack when running, a jab chain when standing, else tilts and aerials.
function attack(p, inp) {
  // a stick push that would have jumped was aiming this attack instead
  if (p.tapJ && (p.bufS > 0 || p.bufA > 0)) p.bufJ = 0;
  if (p.bufS > 0) {
    p.bufS = 0;
    const dir = dirOf(inp);
    if (Math.abs(inp.x) > 0.35) p.face = sign(inp.x);
    startMove(p, SP[p.ch][dir], BTN.S);
  } else if (p.bufA > 0) {
    p.bufA = 0;
    const dir = dirOf(inp);
    if (dir === 's') p.face = sign(inp.x);
    startMove(p, normalAttack(p, dir), BTN.A);
  }
}

// Which normal comes out for a stick direction ('n' neutral, 's' side, 'u' up, 'd' down).
const JAB_CHAIN_WINDOW = 0.32;
function normalAttack(p, dir) {
  // the dash attack comes out of a dash (a flick of the stick); a steady run goes into the side attack instead
  const dashing = p.flickS || (p.dashT > 0 && Math.abs(p.vx) > p.c.speed * 0.8);
  if (p.grounded && (dir === 's' || dir === 'n') && dashing) return N.da;
  if (p.grounded && dir === 'n') {
    const chaining = p.jabNext && G.clock - p.jabAt < JAB_CHAIN_WINDOW;
    return N[chaining ? p.jabNext : 'jab1'];
  }
  return N[(p.grounded ? 'g' : 'a') + dir];
}

// A buffered jump: squat then leave the ground, a coyote-time ground jump, a wall jump, or an air jump.
function jump(p, inp, buttons, sp) {
  if (p.bufJ <= 0) return;
  const fromButton = buttons & BTN.J || !p.tapJ;
  p.jumpSrc = fromButton ? 'b' : 's';
  if (p.grounded) {
    // jump (also cancels shield) after a short squat
    p.linkString = null;
    p.bufJ = 0;
    p.shielding = false;
    p.squat = 0.05;
    p.sqV = -7;
  } else if (p.coyote > 0) {
    // just walked off: still counts as a ground jump
    p.bufJ = 0;
    doJump(p, inp);
  } else if (p.wallT > 0 && p.wallJumps > 0 && !p.helpless) {
    wallJump(p, sp);
  } else if (p.airJumps > 0 && !p.helpless) {
    if (p.tapJ && p.aimT > 0) return; // the stick may be aiming an attack: give the button a moment
    airJump(p, inp, sp);
  }
}

// Running (dash, skid on turnaround, crouch, drop through platforms) or drifting and wall-sliding in the air.
function run(p, inp, flickSide, sp, dt) {
  if (!p.grounded) airDrift(p, inp, sp, dt);
  else if (!p.shielding) groundRun(p, inp, flickSide, sp, dt);
}

function groundRun(p, inp, flickSide, sp, dt) {
  const lean = Math.abs(inp.x);
  // speed follows how far the stick is pushed
  const want = lean > 0.2 ? sign(inp.x) * sp * clamp((lean - 0.2) / 0.45, 0.35, 1) : 0;
  if (flickSide) {
    // dash: a burst of speed; flicking back reverses instantly
    p.vx = sign(inp.x) * sp * 1.3;
    p.dashT = 0.2;
    dbg.dash = G.clock;
    dust(p.x, p.y + p.R, -sign(inp.x), 4);
    speedLines(p, sign(inp.x));
    sfx.dash();
  }

  const turningRound = lean > 0.5 && Math.abs(p.vx) > sp * 0.5 && sign(p.vx) !== sign(inp.x);
  if (turningRound) {
    // skid
    p.vx *= Math.exp(-24 * dt);
    p.skidT = 0.08;
    if (rng() < dt * 40) dust(p.x, p.y + p.R, sign(p.vx), 1);
  } else {
    // a dash or slide that is faster than the stick asks for coasts down instead of snapping to it
    const coasting =
      p.slideT > 0 || (p.dashT > 0 && sign(p.vx) === sign(want) && Math.abs(p.vx) > Math.abs(want));
    let grip = 24;
    if (coasting) grip = 3.5;
    else if (lean > 0.2) grip = 20;
    p.vx += (want - p.vx) * (1 - Math.exp(-grip * dt));
  }
  if (Math.abs(p.vx) > sp * 0.8 && rng() < dt * 9) dust(p.x - p.face * p.R * 0.3, p.y + p.R, -p.face, 1);

  p.crouch = inp.y > 0.6 && lean < 0.4;
  if (lean > 0.2) p.face = sign(inp.x);
  if (inp.y > 0.75 && p.plat && !p.plat.solid) {
    // drop through a floating platform
    p.dropPlat = p.plat;
    p.grounded = false;
    p.plat = null;
    p.dropT = 0.2;
    p.y += 3;
  }
}

function airDrift(p, inp, sp, dt) {
  airControl(p, inp, sp, dt);
  const wallSliding = p.wallT > 0 && inp.x * p.wallSide > 0.5 && p.vy > 0 && !p.ff;
  if (wallSliding) {
    p.wallSlideT = 0.06;
    p.face = -p.wallSide;
    if (rng() < dt * 25) dust(p.x + p.wallSide * p.R * 0.8, p.y, -p.wallSide, 1);
  } else if (Math.abs(inp.x) > 0.3) {
    p.face = sign(inp.x);
  }
}

// Footsteps on the ground; in the air gravity (floatier at the top of a held jump), fast fall, fall speed caps and
// short hops. Then knockback velocity decays, trailing smoke when launched hard.
function fall(p, inp, gravity, dt) {
  if (p.grounded) {
    p.vy = 0;
    footsteps(p, dt);
  } else {
    airFall(p, inp, gravity, dt);
  }
  decayKnockback(p, dt);
}

// The run cycle advances with distance covered; each half turn of it is a foot coming down.
function footsteps(p, dt) {
  const before = p.runPh;
  p.runPh += Math.abs(p.vx) * dt * 0.035;
  const stepped = Math.floor(p.runPh / Math.PI) !== Math.floor(before / Math.PI);
  if (Math.abs(p.vx) > 160 && stepped) sfx.step(p.c.weight);
}

const WALL_SLIDE_SPEED = 260;
function airFall(p, inp, gravity, dt) {
  const fallSpeed = p.c.fall * FALL_K;
  const pounding = p.move && p.move.def.type === 'pound' && p.move.phase === 'active';

  if (p.hitstun <= 0 && !p.move && p.dodgeT <= 0) {
    if (Math.abs(p.vy) < 170 && jumpHeld(p, inp)) gravity *= 0.6;
    else if (p.vy > 0) gravity *= 1.15;
  }
  p.vy += GRAV * gravity * dt;

  if (p.flickD && p.vy > -120 && !p.move && p.hitstun <= 0 && !p.ff && p.wallSlideT <= 0) {
    // fast fall: flick down
    p.ff = true;
    p.vy = Math.max(p.vy, fallSpeed * 1.2);
    sparks(p.x, p.y - p.R, '#ffffff', 3, 260);
  }
  let maxFall = p.ff ? fallSpeed * 1.55 : fallSpeed;
  if (p.wallSlideT > 0) maxFall = WALL_SLIDE_SPEED;
  if (p.vy > maxFall && !pounding) p.vy = maxFall;

  // let go of jump early for a lower jump
  if (p.shortOK) {
    if (!jumpHeld(p, inp) && p.vy < 0) {
      p.vy *= 0.6;
      p.shortOK = false;
    } else if (p.jumpT > 0.2 || p.vy >= 0) {
      p.shortOK = false;
    }
  }
}

function decayKnockback(p, dt) {
  const decay = Math.exp(-LAUNCH_K * dt);
  p.kvx *= decay;
  p.kvy *= decay;
  if (Math.abs(p.kvx) < 6) p.kvx = 0;
  if (Math.abs(p.kvy) < 6) p.kvy = 0;

  // launched hard: a trail of smoke
  if (p.hitstun > 0 && Math.hypot(p.kvx, p.kvy) > 620) {
    p.smokeT -= dt;
    if (p.smokeT <= 0) {
      p.smokeT = 0.035;
      smokes.push({ x: p.x, y: p.y, vx: 0, vy: 0, r: p.R * 0.45, grow: 40, life: 0.55, max: 0.55 });
    }
  }
}

// Integrate, then walk off edges or land on platforms, bump into solid walls, grab ledges, leave afterimages, and
// get KO'd past the blast zone.
const EDGE_SLACK = 8; // how far past a platform's end the feet still count as on it
function moveAndLand(p, dt) {
  const feetBefore = p.y + p.R;
  p.x += (p.vx + p.kvx) * dt;
  p.y += (p.vy + p.kvy) * dt;
  const fallSpeed = p.vy + p.kvy;

  if (p.grounded) {
    edgeHold(p, dt);
    if (!p.plat || p.x < p.plat.x1 - EDGE_SLACK || p.x > p.plat.x2 + EDGE_SLACK) {
      // walked off: a moment of coyote time in which a jump still counts as a ground jump
      p.grounded = false;
      p.plat = null;
      p.coyote = 0.14;
    } else {
      p.y = p.plat.y - p.R;
    }
  } else if (fallSpeed >= 0) {
    const feet = p.y + p.R;
    for (const plat of G.stage.plats) {
      if (plat === p.dropPlat && p.dropT > 0) continue; // still dropping through this one
      const crossedTop = feetBefore <= plat.y + 2 && feet >= plat.y;
      if (crossedTop && p.x > plat.x1 - EDGE_SLACK && p.x < plat.x2 + EDGE_SLACK) {
        land(p, plat, fallSpeed);
        break;
      }
    }
  }
  if (!p.grounded) collideSolids(p);
  tryLedge(p);

  // afterimages behind a dash or a sliding attack
  const sliding = p.move && p.move.def.slide && p.move.phase !== 'recovery';
  if (p.dashT > 0 || sliding) {
    p.ghostT -= dt;
    if (p.ghostT <= 0) {
      p.ghostT = 0.03;
      ghosts.push({ x: p.x, y: p.y, face: p.face, ch: p.ch, s: p.R, col: p.tag, life: 0.18, max: 0.18 });
    }
  }

  // past the blast zone: KO. Off the top only counts when launched there, so a high jump is safe.
  const blast = G.stage.blast;
  const offSideOrBottom = p.x < blast.l || p.x > blast.r || p.y > blast.b;
  const launchedOffTop = p.y < blast.t && (p.hitstun > 0 || p.kvy < -80);
  if (offSideOrBottom || launchedOffTop) ko(p);
}

// The main stage's edges hold you: walking, dashing, rolling or attacking up to the edge stops there with a teeter.
// To step off on purpose, push outward again once you're standing there (or keep holding for a moment, or jump).
// Being launched still carries you off.
const EDGE_HOLD = 0.45;
const EDGE_STEP = 0.12;
function edgeHold(p, dt) {
  const plat = p.plat;
  let side = 0; // which edge the fighter is standing right on, if either
  if (plat && plat.solid && p.hitstun <= 0 && !p.heldBy) {
    if (p.x >= plat.x2 - 1) side = 1;
    else if (p.x <= plat.x1 + 1) side = -1;
  }
  if (!side) {
    p.edgeT = 0;
    p.edgeReady = false;
    return;
  }

  const pushing = p.in.x * side > 0.3 && !p.move && p.dodgeT <= 0;
  if (!pushing) {
    p.edgeT = 0;
    p.edgeReady = true;
  } else {
    p.edgeT += dt;
  }
  if (p.edgeT >= (p.edgeReady ? EDGE_STEP : EDGE_HOLD)) return; // meant it: off you go

  p.x = side > 0 ? plat.x2 : plat.x1;
  if (p.vx * side > 0) p.vx = 0;
  if (p.kvx * side > 0) p.kvx = 0;
  if (p.teeter <= 0) dust(p.x, p.y + p.R, -side, 2);
  p.teeter = 0.25;
  p.teeterSide = side;
}

// Touching down on a platform at the given fall speed: tech, bounce while tumbling, or land (resetting jumps and
// dodges).
function land(p, plat, fallSpeed) {
  p.y = plat.y - p.R;
  if (p.hitstun > 0) {
    if (p.techW > 0) {
      tech(p, plat);
    } else if (Math.hypot(p.kvx, p.kvy) > 520) {
      bounce(p, plat);
      return;
    }
  }
  if (p.dodgeT > 0 && p.airDodge) {
    // an air dodge into the floor slides along it
    p.dodgeT = 0;
    p.airDodge = false;
    p.lag = 0.05;
    p.slideT = 0.28;
    dust(p.x, plat.y, sign(p.vx), 5);
  }

  p.grounded = true;
  p.plat = plat;
  p.kvy = 0;
  p.vy = 0;
  p.ff = false;
  p.flipT = 0;
  p.airJumps = p.c.airJumps;
  p.airDodged = false;
  p.ledgeInvUsed = false;
  p.sqV = -6;
  p.wallJumps = 2;
  if (fallSpeed > 900) ring(p.x, plat.y, 12, 70, 0.22, '#ffffff', false, { kind: 'ground' });
  if (p.helpless) {
    p.helpless = false;
    p.lag = 0.12;
  }
  if (p.move && p.move.def.air) {
    // an aerial is cut short by the floor (with hardly a pause if it landed its hit)
    p.lag = p.move.landed ? 0.02 : 0.05;
    p.move = null;
  }
  if (fallSpeed > 500) {
    dust(p.x, plat.y, 1, 3);
    dust(p.x, plat.y, -1, 3);
  }
  if (fallSpeed > 250) sfx.land(Math.min(1, (fallSpeed - 250) / 1100), p.c.weight);
}

// Tech: Shield pressed just before hitting the ground while tumbling. Back on your feet at once, briefly invulnerable.
function tech(p, plat) {
  p.hitstun = 0;
  p.kvx = p.kvy = 0;
  p.techW = 0;
  p.invuln = Math.max(p.invuln, 0.35);
  p.lag = 0.12;
  ring(p.x, plat.y, 12, 80, 0.26, '#ffffff', false, { kind: 'ground' });
  sparks(p.x, plat.y, '#ffffff', 6, 400);
  sfx.tech();
  popText(p.x, p.y - p.R * 1.8, 'TECH', '#8fe0ff');
}

// Tumbling fast into the floor: bounce off it and stay in the air.
function bounce(p, plat) {
  p.kvy = -Math.abs(p.kvy) * 0.6;
  p.vy = 0;
  dust(p.x, plat.y, 1, 4);
  dust(p.x, plat.y, -1, 4);
  sfx.thud();
}

// The island's rock body: a fighter inside it is pushed out through the nearest face (never the top, which is the
// stage floor). Touching a side counts as a wall, for wall slides and wall jumps; a launch bounces off.
function collideSolids(p) {
  for (const rock of G.stage.solids) {
    const left = rock.x1 - p.R * 0.75;
    const right = rock.x2 + p.R * 0.75;
    const top = rock.y1;
    const bottom = rock.y2 + p.R * 0.8;
    if (p.x <= left || p.x >= right || p.y <= top || p.y >= bottom) continue;

    const fromLeft = p.x - left;
    const fromRight = right - p.x;
    const fromBottom = bottom - p.y;
    const nearest = Math.min(fromLeft, fromRight, fromBottom);
    if (nearest === fromBottom) {
      p.y = bottom;
      if (p.vy < 0) p.vy = 0;
      if (p.kvy < 0) p.kvy = -p.kvy * 0.4;
    } else if (nearest === fromLeft) {
      p.x = left;
      if (p.vx > 0) p.vx = 0;
      if (p.kvx > 0) p.kvx = -p.kvx * 0.45;
      p.wallSide = 1;
      p.wallT = 0.12;
    } else {
      p.x = right;
      if (p.vx < 0) p.vx = 0;
      if (p.kvx < 0) p.kvx = -p.kvx * 0.45;
      p.wallSide = -1;
      p.wallT = 0.12;
    }
  }
}

// Combat: move hitboxes, damage and knockback, shields, perfect shields, counters, grabs and throws, KOs and match stats.

const AIM_DEADZONE = 0.3; // the stick has to lean at least this far to aim a move
const HEAVY_DMG = 1.25; // the Heavy item's damage bonus
const KO_MEMORY = 6; // seconds a hit still earns the KO (after that, the fall was your own doing)

// Can q be hit right now? Not while respawning, dodging (after the first instant) or held in a grab.
const vulnerable = (q) => q.alive && q.invuln <= 0 && q.hover <= 0 && q.dodgeT <= 0.06 && !q.heldBy;

// Free to start something new: not mid-move, stunned, dodging, lagging, hanging or in a grab.
const canAct = (p) =>
  !p.move &&
  p.hitstun <= 0 &&
  p.dizzy <= 0 &&
  p.dodgeT <= 0 &&
  p.lag <= 0 &&
  !p.ledge &&
  !p.heldBy &&
  !p.holding;

const damageScale = (p) => p.c.dmg * (p.heavyT > 0 ? HEAVY_DMG : 1);

function leaveGround(p) {
  p.grounded = false;
  p.plat = null;
}

// The stick as one of four move directions: 'u', 'd', 's' (side) or 'n' (neutral).
function dirOf(inp) {
  const ax = Math.abs(inp.x);
  const ay = Math.abs(inp.y);
  if (ay > 0.5 && ay >= ax) return inp.y < 0 ? 'u' : 'd';
  return ax > 0.35 ? 's' : 'n';
}

// `string` is the set of normals already used in the string this move carries on (see linkMove).
function startMove(p, def, btn, string = new Set()) {
  string.add(def);
  p.move = {
    def,
    t: 0,
    phase: 'startup',
    hit: new Set(),
    charge: 0,
    btn,
    rt: 0, // time since the hit list was last cleared (moves with `rehit`)
    k: def.normal ? p.c.tempo : 1, // timing scale: normals run at the fighter's own tempo
    string,
    landed: false, // true once it has hit someone who wasn't shielding: the move can then be cut short
  };
  p.shielding = false;
  if (def.type === 'pound') {
    // a ground pound hops up first; in the air it just stalls
    if (p.grounded) {
      p.vy = -620;
      leaveGround(p);
    } else {
      p.vy = Math.min(p.vy, 0) * 0.3;
    }
    p.vx *= 0.4;
  }
}

// A teleport special: blinks the fighter `def.dist` along the stick (straight up with no direction held; sideways only
// for a horizontal one), kept inside the blast zone, leaving a bolt behind.
function teleport(p, def, inp, tilt) {
  let dx = p.face;
  let dy = 0;
  if (def.horiz) {
    if (Math.abs(inp.x) > AIM_DEADZONE) dx = sign(inp.x);
  } else if (tilt > AIM_DEADZONE) {
    dx = inp.x / tilt;
    dy = inp.y / tilt;
  } else {
    dx = 0;
    dy = -1;
  }
  const fromX = p.x;
  const fromY = p.y;
  const blast = G.stage.blast;
  p.x = clamp(p.x + dx * def.dist, blast.l + 80, blast.r - 80);
  p.y = clamp(p.y + dy * def.dist, blast.t + 80, blast.b - 60);
  if (Math.abs(dx) > 0.2) p.face = sign(dx);
  p.vx = 0;
  p.vy = 0;
  leaveGround(p);
  bolts.push({ x1: fromX, y1: fromY, x2: p.x, y2: p.y, life: 0.22, max: 0.22, color: p.light });
  puff(fromX, fromY, p.light, 8, 220);
  sfx.zap();
}

// The wind-up is over and the move comes out: the fighter is set moving the way the move says, and whatever it throws
// or summons appears.
function beginActive(p, inp) {
  const move = p.move;
  const def = move.def;
  move.phase = 'active';
  move.t = 0;
  const tilt = Math.hypot(inp.x, inp.y);
  if (def.arc || def.spin || def.poke) dbg.smear = G.clock;

  if (def.type === 'tele') teleport(p, def, inp, tilt);
  if (def.vx != null) p.vx = def.vx * p.face;
  if (def.vy < 0) {
    // upward, scaled like a jump
    p.vy = def.vy * JUMP_K;
    leaveGround(p);
  } else if (def.vy != null) {
    p.vy = def.vy;
  }
  if (def.drift) p.vx = inp.x * def.drift;
  if (def.steer) {
    // flies wherever the stick points, or straight up with no direction held
    const dx = tilt > AIM_DEADZONE ? inp.x / tilt : 0;
    const dy = tilt > AIM_DEADZONE ? inp.y / tilt : -1;
    p.vx = dx * def.steer;
    p.vy = dy * def.steer;
    if (Math.abs(dx) > 0.2) p.face = sign(dx);
    if (dy < 0.2) leaveGround(p);
  }
  if (def.type === 'pound') {
    p.vy = 1500;
    p.vx = 0;
  }
  if (def.slide) {
    p.vx = p.face * Math.max(Math.abs(p.vx), p.c.speed * 1.2);
    p.dashT = 0.22;
    speedLines(p, p.face);
  }

  if (def.proj) {
    for (const shot of def.proj) {
      projs.push({
        ...shot,
        owner: p,
        x: p.x + p.face * 40 * p.size,
        y: p.y - 6,
        vx: shot.vx * p.face,
        dir: p.face,
        t: 0,
        dmgMul: damageScale(p),
        color: p.light,
      });
    }
  }
  if (def.ring) ring(p.x, p.y, p.R, def.ring * p.size, 0.25, def.fire ? '#ffb86b' : p.light, true);
  if (def.bolt) {
    bolts.push({
      x1: p.x + rand(-20, 20),
      y1: p.y - 340 * p.size,
      x2: p.x,
      y2: p.y - 20,
      life: 0.22,
      max: 0.22,
      color: '#fff7b0',
      thick: 1,
    });
  }

  // Math.random, not the seeded rng: the voice is sound only, so it must not touch the simulation
  if (def.proj || def.bolt || def.ring) {
    sfx.special();
    if (Math.random() < 0.5) voice(p.ch, 'hup');
  } else if (!def.grab) {
    sfx.swing(move.charge);
    if (move.charge > 0.45) voice(p.ch, 'hup');
  }
}

function endMove(p) {
  const def = p.move.def;
  p.move = null;
  if (def.jab) {
    // pressing attack again soon after continues the jab chain
    p.jabAt = G.clock;
    p.jabNext = def.jab === 1 ? 'jab2' : 'jab3';
  }
  if (def.helpless && !p.grounded) p.helpless = true;
}

// Advances the current move through its phases: startup, charge (while the button is held), active, land (ground
// pounds only) and recovery. Returns the gravity scale to use this step.
function updateMove(p, dt, inp, gravity) {
  const move = p.move;
  const def = move.def;
  move.t += dt;
  if (move.phase === 'startup') {
    if (def.type === 'pound') gravity *= 0.15;
    if (move.t >= def.st * move.k) {
      const charging = def.charge && inp.b & move.btn && (p.grounded || def.airCharge);
      if (charging) {
        move.phase = 'charge';
        move.t = 0;
      } else {
        beginActive(p, inp);
      }
    }
  } else if (move.phase === 'charge') {
    move.charge = Math.min(1, move.t / CHARGE_T);
    if (def.airCharge && !p.grounded) gravity *= 0.5;
    if (!(inp.b & move.btn) || move.t >= CHARGE_T) beginActive(p, inp);
  } else if (move.phase === 'active') {
    gravity = updateActive(p, dt, gravity);
  } else if (move.phase === 'land') {
    if (move.t >= 0.1) {
      move.phase = 'recovery';
      move.t = 0;
    }
  } else if (move.t >= def.rc * move.k) {
    endMove(p);
  }
  return gravity;
}

// While the hitboxes are out: multi-hit timing, a fire trail, a ground pound's touchdown, then recovery.
function updateActive(p, dt, gravity) {
  const move = p.move;
  const def = move.def;
  if (def.rehit) {
    // a multi-hit move may hit the same fighter again every `rehit` seconds
    move.rt += dt;
    if (move.rt >= def.rehit) {
      move.rt = 0;
      move.hit.clear();
    }
  }
  if (def.grav != null) gravity *= def.grav;
  if (def.fire && rng() < dt * 60) {
    particles.push({
      x: p.x + rand(-20, 20),
      y: p.y + rand(-20, 20),
      vx: rand(-60, 60),
      vy: rand(-160, -40),
      life: 0.35,
      max: 0.35,
      size: rand(4, 8),
      color: rng() < 0.5 ? '#ffb86b' : '#ffe66d',
      drag: 2,
    });
  }

  if (def.type === 'pound') {
    if (p.grounded) {
      // touchdown: the landing hitboxes come out
      move.phase = 'land';
      move.t = 0;
      move.hit.clear();
      G.shake = Math.max(G.shake, def.quake ? 14 : 7);
      dust(p.x, p.y + p.R, 1, 6);
      dust(p.x, p.y + p.R, -1, 6);
      if (def.quake) ring(p.x, p.y + p.R, 20, 190, 0.32, '#e9e1ff', true, { kind: 'ground' });
      sfx.thud();
    } else if (move.t > 1.5) {
      endMove(p); // fell for too long (off the stage): give control back
    }
    return gravity;
  }

  if (def.hold) p.vy = def.vy;
  if (move.t >= def.ac) {
    move.phase = 'recovery';
    move.t = 0;
    const selfPropelled = def.vx != null || def.steer || (def.vy != null && !def.hold);
    if (selfPropelled) {
      // bleed off the move's own speed so it doesn't carry on as a free launch
      p.vx *= 0.35;
      if (p.vy < 0) p.vy *= 0.45;
    }
  }
  return gravity;
}

// The hitboxes that are out right now, if any.
function liveHitboxes(move) {
  if (move.phase === 'active') return move.def.hb;
  if (move.phase === 'land') return move.def.land;
  return null;
}

// Which way a hitbox sends its target: away from the attacker, or the way the hitbox itself points.
function launchSide(p, q, hb) {
  if (hb.away) return q.x === p.x ? p.face : sign(q.x - p.x);
  return hb.x < 0 ? -p.face : p.face;
}

// Tests p's current move against everyone in `list`: each fighter can be hit once per move (or once per rehit).
function moveHits(p, list) {
  const move = p.move;
  if (!move) return;
  const def = move.def;
  const hitboxes = liveHitboxes(move);
  if (!hitboxes) return;
  const scale = p.size * (def.normal ? p.c.reach : 1);
  if (def.grab) {
    tryGrab(p, list, hitboxes[0], scale);
    return;
  }

  const chargeMul = 1 + move.charge * 0.5;
  for (const q of list) {
    if (q === p || !vulnerable(q) || move.hit.has(q.id)) continue;
    for (const hb of hitboxes) {
      const hx = p.x + p.face * hb.x * scale;
      const hy = p.y + hb.y * scale;
      if (Math.hypot(q.x - hx, q.y - hy) < hb.r * scale + q.R * 0.9) {
        move.hit.add(q.id);
        const at = { x: (hx + q.x) / 2, y: (hy + q.y) / 2 };
        if (hit(p, q, hb, launchSide(p, q, hb), chargeMul, damageScale(p), 'melee', at)) move.landed = true;
        break;
      }
    }
    if (p.move !== move) return; // countered
  }
}

// A grab catches the first foe in reach who is on about the same level and isn't hanging or holding someone.
function tryGrab(p, list, hb, scale) {
  const hx = p.x + p.face * hb.x * scale;
  const hy = p.y;
  for (const q of list) {
    if (q === p || !vulnerable(q) || q.holding || q.ledge || Math.abs(q.y - p.y) > 60) continue;
    if (Math.hypot(q.x - hx, q.y - hy) < hb.r * scale + q.R) {
      catchGrab(p, q);
      return;
    }
  }
}

const WORDS = ['BONK!', 'WHAM!', 'POW!', 'THWACK!', 'SMACK!', 'BOOF!', 'KRAK!'];

// Is this hit part of a combo? Yes when the same attacker hits again before the target has recovered.
const stillReeling = (q) => q.hitstun > 0 || q.freeze > 0 || G.clock - q.lastHitT < 0.1;
const continuesCombo = (att, q) => !!att && q.comboBy === att.id && q.combo > 0 && stillReeling(q);

// Every hit of a combo after the first does a little less damage, down to a floor: long strings pay, but less than
// the same hits landed one at a time.
const COMBO_DAMAGE_STEP = 0.07;
const COMBO_DAMAGE_FLOOR = 0.6;
const comboDamage = (hitsSoFar) => Math.max(COMBO_DAMAGE_FLOOR, 1 - COMBO_DAMAGE_STEP * hitsSoFar);

// att hits q with hitbox hb, launching toward dir. mul is the charge multiplier, dmgMul the attacker's damage scale.
// kind: 'melee' (can be countered, freezes the attacker), 'proj', or 'throw' (ignores shields). at: the contact point.
// Returns true when the hit landed (it wasn't countered or shielded).
function hit(att, q, hb, dir, mul, dmgMul, kind = 'melee', at = null) {
  if (kind === 'melee' && att && q.move && q.move.def.type === 'counter' && q.move.phase === 'active') {
    counter(att, q, hb, mul);
    return false;
  }
  const scaled = continuesCombo(att, q) ? comboDamage(q.combo) : 1;
  const dmg = hb.dmg * mul * dmgMul * DAMAGE_K * scaled;
  const kbMul = (1 + (mul - 1) * 0.6) * (att ? att.c.kb : 1);
  const x = at ? at.x : q.x;
  const y = at ? at.y : q.y;
  if (q.shielding && kind !== 'throw') {
    blocked(att, q, dmg, dir, mul, kind, x, y);
    return false;
  }
  takeDamage(att, q, dmg, kind);

  // knockback grows with the target's damage (taken after this hit) and shrinks with their weight; the Heavy
  // item makes its holder harder to launch
  const growth = (hb.kbg * KB_GROWTH * q.pct) / 100;
  const heavy = q.heavyT > 0 ? 1.4 : 1;
  let kb = ((hb.kb + growth) * kbMul) / q.c.weight / heavy;
  // hit-pause: both fighters hang for a moment, longer for a harder hit
  const pause = Math.min(0.17, 0.035 + dmg * 0.007);
  q.freeze = pause;
  if (att && kind === 'melee') att.freeze = pause;

  // an armoured move takes the damage but isn't launched
  const armored = q.move && q.move.def.armor && q.move.phase !== 'recovery';
  let koHit = false;
  if (armored) kb *= 0.2;
  else koHit = launch(q, hb, kb, dir);
  hitFeedback(att, q, kb, koHit, x, y);
  return true;
}

// A counter caught the attack: the defender strikes back harder.
function counter(att, q, hb, mul) {
  q.move.phase = 'recovery';
  q.move.t = 0;
  q.invuln = Math.max(q.invuln, 0.35);
  ring(q.x, q.y, q.R, q.R * 3, 0.3, '#9be88a', true);
  sfx.parry();
  q.face = sign(att.x - q.x);
  const strike = { dmg: Math.max(10, hb.dmg * mul * 1.3), kb: 340, kbg: 540, ang: 45 };
  hit(q, att, strike, q.face, 1, 1, 'proj');
}

// Into a shield: a perfect shield (raised just in time) takes nothing and leaves the attacker open; otherwise the
// shield soaks the damage, pushes back a little, and may break.
function blocked(att, q, dmg, dir, mul, kind, x, y) {
  const perfect = G.clock - q.shieldAt < 0.13;
  if (perfect) {
    ring(q.x, q.y, q.R, q.R * 2.8, 0.3, '#ffffff', true);
    sparks(x, y, '#ffffff', 10, 700);
    if (att && kind === 'melee') att.freeze = 0.32;
    q.freeze = 0.04;
    sfx.parry();
    popText(q.x, q.y - q.R * 1.9, 'PERFECT', '#c8f59a');
    return;
  }
  q.shieldHP -= dmg * 1.15 + (mul > 1.2 ? 12 : 0);
  q.kvx = dir * 180;
  q.freeze = 0.05;
  if (att && kind === 'melee') att.freeze = 0.05;
  q.lag = Math.min(0.3, 0.04 + dmg * 0.012);
  ring(q.x, q.y, q.R * 1.3, q.R * 2.2, 0.2, q.tag);
  sparks(x, y, q.tag, 4, 400);
  sfx.block();
  if (q.shieldHP <= 0) shieldBreak(q);
}

// Lets go of ledges and grabs, counts the combo, adds the damage and records match stats.
function takeDamage(att, q, dmg, kind) {
  releaseLedge(q);
  if (q.holding) release(q);
  if (q.heldBy && kind !== 'throw') release(q.heldBy);
  const chain = continuesCombo(att, q);
  q.combo = chain ? q.combo + 1 : 1;
  q.comboBy = att ? att.id : null;
  q.comboDmg = (chain ? q.comboDmg : 0) + dmg;
  q.squat = 0;
  q.pct = Math.min(999, q.pct + dmg);
  if (G.state === 'play' && q.inMatch) {
    q.stats.taken += dmg;
    if (att && att !== q && att.inMatch) {
      att.stats.dmg += dmg;
      att.stats.combo = Math.max(att.stats.combo, q.combo);
    }
  }
  q.lastHitBy = att ? att.id : null;
  q.lastHitT = G.clock;
  q.flashT = 0.18;
  q.hitAt = G.clock;
}

const HITSTUN_FRESH_HITS = 3; // the first hits of a combo stun in full
const HITSTUN_WEAR = 0.09; // each hit after that stuns this much less
const HITSTUN_FLOOR = 0.45;

// Sends q flying with knockback kb along the hitbox angle (bent a little by directional influence) and sets hitstun.
// Returns true when the launch will carry q past a blast zone, which earns the KO slow-motion and close-up.
function launch(q, hb, kb, dir) {
  // (lx, ly): the launch direction, one unit long
  let lx = Math.cos(hb.ang * DEG) * dir;
  let ly = -Math.sin(hb.ang * DEG);
  // directional influence: holding the stick sideways to the launch bends it by up to 22°
  const stick = q.in;
  const tilt = Math.hypot(stick.x, stick.y);
  if (tilt > AIM_DEADZONE && kb > 250) {
    const bend = clamp((lx * stick.y - ly * stick.x) / tilt, -1, 1) * 22 * DEG;
    const cos = Math.cos(bend);
    const sin = Math.sin(bend);
    [lx, ly] = [lx * cos - ly * sin, lx * sin + ly * cos];
  }
  q.kvx = lx * kb;
  q.kvy = ly * kb;
  q.vx = 0;
  q.vy = 0;
  if (q.grounded) {
    if (q.kvy > 0) q.kvy *= -0.8; // spiked on the ground: pop up
    // weak hits keep you on your feet
    if (q.kvy > -120) q.kvy = 0;
    else leaveGround(q);
  }

  if (hb.stunT != null) {
    q.hitstun = hb.stunT;
  } else if (hb.stun) {
    // a stunning move: full stun the first time, then a spell of immunity so it can't be chained
    q.hitstun = q.stunImm > 0 ? 0.12 : hb.stun;
    q.stunImm = 1.6;
  } else {
    // Long enough to follow the hit up. Deep into a combo the target recovers sooner, so every string runs out.
    const worn = clamp(1 - HITSTUN_WEAR * (q.combo - HITSTUN_FRESH_HITS), HITSTUN_FLOOR, 1);
    q.hitstun = Math.min(1.05, 0.14 + kb / 2100) * worn;
  }

  // a fresh launch gives back the double jump, air dodge and wall jumps, so there's always a way home
  q.airJumps = Math.max(q.airJumps, q.c.airJumps);
  q.airDodged = false;
  q.wallJumps = 2;
  q.move = null;
  q.dodgeT = 0;
  q.helpless = false;
  q.lag = 0;
  q.shielding = false;
  q.ff = false;
  q.sqV = -8;

  // where the launch would carry them if nothing got in the way
  const blast = G.stage.blast;
  const endX = q.x + q.kvx / LAUNCH_K;
  const endY = q.y + (q.kvy / LAUNCH_K) * 0.7;
  return kb > 600 && (endX < blast.l || endX > blast.r || endY < blast.t);
}

// Everything the room sees, hears and feels: impact star and comic word, sparks in the attacker's colours, shake,
// KO slow-motion and close-up, combo counter, sound, and the phone buzz.
function hitFeedback(att, q, kb, koHit, x, y) {
  const big = kb > 700;
  // a comic word for the hard ones, but never two on screen at once
  let word = null;
  if (kb > 640 && !impacts.some((im) => im.word && im.t < 0.35)) {
    word = WORDS[Math.floor(Math.random() * WORDS.length)];
  }
  const hold = Math.max(0.035, q.freeze || 0);
  const burstEnd = hold + (big ? 0.2 : 0.13);
  const ang = q.kvx || q.kvy ? Math.atan2(q.kvy, q.kvx) : null; // which way the hit sends the target
  impacts.push({
    x,
    y,
    t: 0,
    hold,
    burstEnd,
    life: Math.max(burstEnd, word ? 0.5 : 0),
    size: clamp(24 + kb * 0.045, 28, 95),
    rot: rand(TAU),
    color: att ? att.tag : '#ffffff',
    ang,
    word,
    wx: (Math.random() - 0.5) * 60,
    wy: -40 - Math.random() * 30,
    wr: (Math.random() - 0.5) * 0.5,
    wc: att ? att.tag : '#ffd84a',
  });
  sparks(x, y, '#ffffff', big ? 12 : 5, big ? 950 : 520);
  if (att) {
    sparks(x, y, att.light, big ? 8 : 3, 650);
    motif(x, y, att.ch, att.color, big ? 6 : 2, big ? 520 : 320);
  }
  if (kb > 420) ring(x, y, 16, big ? 118 : 72, big ? 0.24 : 0.18, '#ffffff', big, { ang, delay: hold });
  G.shake = Math.max(G.shake, Math.min(24, kb / 65));
  if (koHit) {
    G.slowT = 0.45;
    G.impact = { x, y, t: 0, color: att ? att.tag : '#ffffff' };
    cam.punch = 0.16;
    cam.px = x;
    cam.py = y;
    cam.focus = q;
    cam.focusT = 0.8;
    G.flash = Math.max(G.flash, 0.55);
    sfx.ping();
    dbg.kohit = G.clock;
  } else if (big) {
    G.flash = Math.max(G.flash, 0.22);
    if (cam.punch < 0.05) {
      cam.punch = 0.05;
      cam.px = x;
      cam.py = y;
    }
  }
  if (q.combo >= 3 || (q.combo === 2 && q.comboDmg >= 12)) {
    // the counter trails behind the way they're flying, and grows with the combo
    const behind = q.kvx >= 0 ? -1 : 1;
    const textX = q.x + behind * q.R * 2.2;
    const size = 1 + Math.min(0.8, q.combo * 0.1);
    popText(textX, q.y - q.R * 0.9, `${q.combo} HITS`, comboColor(q.combo), size, 'c' + q.id);
  }
  sfx.hit(kb, q.combo);
  dbg.hit = G.clock;
  if (big) dbg.bighit = G.clock;
  tellHud(q);
  tell(q, { t: 'buzz', k: big ? 'bighit' : 'hit' });
  G.hudDirty = true;
}

function comboColor(hits) {
  if (hits >= 5) return '#ff8fa3';
  if (hits >= 3) return '#ffd166';
  return '#8fe0ff';
}

// The shield gave out: the fighter pops up and is left dizzy and wide open.
function shieldBreak(q) {
  q.shielding = false;
  q.shieldHP = 55;
  q.dizzy = 2.3;
  q.vy = -520;
  leaveGround(q);
  ring(q.x, q.y, q.R, q.R * 4, 0.4, q.tag, true);
  sparks(q.x, q.y, q.tag, 16, 700);
  G.shake = Math.max(G.shake, 10);
  sfx.shatter();
  popText(q.x, q.y - q.R * 2, 'BREAK!', '#ff8fa3');
  tell(q, { t: 'buzz', k: 'bighit' });
}

// Grabs and throws

function catchGrab(p, q) {
  untangle(q);
  q.squat = 0;
  p.move = null;
  p.holding = q;
  p.holdT = 0;
  p.pummelT = 0;
  q.heldBy = p;
  q.move = null;
  q.shielding = false;
  q.dodgeT = 0;
  q.hitstun = 0;
  q.lag = 0;
  q.vx = q.vy = q.kvx = q.kvy = 0;
  q.escape = clamp(0.8 + q.pct * 0.006, 0.8, 2.2); // seconds held; longer the more damaged they are
  q.face = -p.face;
  sfx.grab();
  dbg.grab = G.clock;
  tell(q, { t: 'note', text: 'Grabbed! Mash buttons to escape' });
}

function release(holder) {
  const q = holder.holding;
  if (!q) return;
  holder.holding = null;
  if (q.heldBy === holder) q.heldBy = null;
}

// The held fighter wriggles out: both are pushed apart and the grabber is left lagging.
function breakFree(q) {
  const holder = q.heldBy;
  release(holder);
  const away = sign(q.x - holder.x);
  q.kvx = away * 420;
  q.kvy = -240;
  leaveGround(q);
  q.invuln = 0.2;
  holder.kvx = -away * 200;
  holder.lag = 0.3;
  puff((q.x + holder.x) / 2, q.y, '#ffffff', 8, 300);
  sfx.dodge();
}

// dir: 'f' forward, 'b' back, 'u' up or 'd' down.
function doThrow(p, dir) {
  const q = p.holding;
  release(p);
  if (dir === 'b') {
    // a back throw turns round and carries them to the other side first
    p.face = -p.face;
    q.x = p.x + p.face * (p.R + q.R) * 0.8;
  }
  if (dir === 'd') {
    dust(q.x, q.y + q.R, 1, 4);
    dust(q.x, q.y + q.R, -1, 4);
  }
  p.throwT = 0.25;
  p.lag = 0.12; // short enough to chase a throw
  hit(p, q, THROWS[dir], p.face, 1, p.c.dmg, 'throw', { x: q.x, y: q.y });
  dbg.throw = G.clock;
}

// A jab at whoever p is holding: a little damage, no knockback.
function pummel(p) {
  const q = p.holding;
  q.pct = Math.min(999, q.pct + 1.5 * DAMAGE_K);
  q.flashT = 0.12;
  q.hitAt = G.clock;
  p.throwT = 0.12;
  sparks(q.x, q.y, '#ffffff', 4, 300);
  sfx.hit(150);
  tellHud(q);
  G.hudDirty = true;
}

// Ledges

// Where a hanging fighter's body sits relative to the corner.
function hangAt(p, ledge) {
  p.x = ledge.x + ledge.side * p.R * 0.85;
  p.y = ledge.y + p.R * 0.62;
}

function releaseLedge(p) {
  if (!p.ledge) return;
  if (p.ledge.by === p) p.ledge.by = null;
  p.ledge = null;
}

// Catches a free ledge if the fighter is falling past one and is in a state to hold on.
function tryLedge(p) {
  if (p.grounded || p.hitstun > 0 || p.ledgeCd > 0 || p.dodgeT > 0 || p.holding || p.heldBy) return;
  if (p.move && !(p.move.def.helpless || p.move.phase === 'recovery')) return;
  if (!p.move && p.vy + p.kvy < -150) return; // still rising fast from a jump
  for (const ledge of G.stage.ledges) {
    if (ledge.by) continue;
    const outward = (p.x - ledge.x) * ledge.side;
    const below = p.y - ledge.y;
    // a generous reach: any hand near the corner catches it
    if (outward < -16 || outward > 115 || below < -40 || below > 160) continue;
    grabLedge(p, ledge);
    return;
  }
}

function grabLedge(p, ledge) {
  p.ledge = ledge;
  ledge.by = p;
  p.move = null;
  p.helpless = false;
  p.ff = false;
  p.vx = p.vy = p.kvx = p.kvy = 0;
  p.face = -ledge.side;
  p.hangT = 0;
  p.airJumps = p.c.airJumps;
  p.airDodged = false;
  p.wallJumps = 2;
  if (!p.ledgeInvUsed) {
    // safe for a moment, but only on the first grab of each trip off the stage
    p.invuln = Math.max(p.invuln, 0.6);
    p.ledgeInvUsed = true;
  }
  hangAt(p, ledge);
  sparks(ledge.x, ledge.y, '#ffffff', 4, 260);
  sfx.ledge();
  dbg.ledge = G.clock;
}

function climb(p) {
  const ledge = p.ledge;
  releaseLedge(p);
  p.x = ledge.x - ledge.side * (p.R + 4);
  p.y = ledge.y - p.R;
  p.grounded = true;
  p.plat = G.stage.main;
  p.vx = p.vy = 0;
  p.lag = 0.14;
  p.invuln = Math.max(p.invuln, 0.22);
  p.climbT = 0.2;
  p.face = -ledge.side;
  dust(p.x, ledge.y, -ledge.side, 3);
}

function ledgeJump(p) {
  const ledge = p.ledge;
  releaseLedge(p);
  p.bufJ = 0;
  p.vy = -p.c.jump * JUMP_K * 1.05;
  p.vx = -ledge.side * 150;
  p.x -= ledge.side * 6;
  p.ledgeCd = 0.4;
  p.sqV = 7;
  ring(p.x, p.y + p.R * 0.9, 10, 52, 0.24, '#ffffff', false, { kind: 'air' });
  sfx.jump();
}

function dropLedge(p) {
  const ledge = p.ledge;
  releaseLedge(p);
  p.ledgeCd = 0.5;
  p.vy = 120;
  p.x += ledge.side * 4;
}

// One tick of hanging from a ledge. From here: jump (jump button or up), a get-up attack (attack or special), a roll
// onto the stage (shield), a plain climb (push toward the stage), or let go (push away or down, or hang too long).
// pressed: the buttons that went down this tick.
function ledgeUpdate(p, inp, pressed, dt) {
  const ledge = p.ledge;
  p.hangT += dt;
  hangAt(p, ledge);
  p.vx = p.vy = p.kvx = p.kvy = 0;
  if (p.hangT < 0.12) return;

  // A stick still held from flying in must not act straight away: until the fighter has hung for a moment, a
  // direction only counts if it is a fresh push.
  const settled = p.hangT > 0.3;
  const toward = -inp.x * ledge.side;
  const wasToward = -p.lastX * ledge.side;
  const pushUp = inp.y < -0.65 && (settled || p.lastY > -0.4);
  const pushToward = toward > 0.6 && (settled || wasToward < 0.4);
  // letting go always takes a fresh push away or down, however long they've hung
  const pushAway = toward < -0.6 && -wasToward < 0.4;
  const pushDown = inp.y > 0.7 && p.lastY < 0.4;

  if (pressed & BTN.J || pushUp) {
    ledgeJump(p);
  } else if (pressed & (BTN.A | BTN.S)) {
    climb(p);
    p.lag = 0;
    startMove(p, GETUP, BTN.A);
  } else if (pressed & BTN.D) {
    climb(p);
    roll(p, -ledge.side);
  } else if (pushToward) {
    climb(p);
  } else if (pushAway || pushDown || p.hangT > 4) {
    dropLedge(p);
  }
}

// Dodges

function roll(p, dir) {
  p.shielding = false;
  p.bufD = 0;
  p.dodgeT = 0.34;
  p.spot = false;
  p.vx = dir * 640;
  p.face = -dir;
  dust(p.x, p.y + p.R, -dir, 4);
  sfx.dodge();
}

function spotDodge(p) {
  p.shielding = false;
  p.bufD = 0;
  p.dodgeT = 0.3;
  p.spot = true;
  p.vx = 0;
  sfx.dodge();
}

// Which edge of the blast zone a fighter went out through.
function blastSide(p, blast) {
  if (p.y > blast.b) return 'bottom';
  if (p.y < blast.t) return 'top';
  return 'side';
}

// A fighter has crossed the blast zone: the blast effect, the score, and either a respawn or out of the match.
function ko(p) {
  const blast = G.stage.blast;
  const recentlyHit = G.clock - p.lastHitT < KO_MEMORY;
  comboEnd(p);
  untangle(p);
  p.alive = false;
  p.move = null;
  if (G.state === 'play') {
    koLog.push({
      ch: p.ch,
      pct: Math.round(p.pct),
      t: Math.round(G.matchT),
      self: !recentlyHit,
      side: blastSide(p, blast),
    });
  }

  const edgeX = clamp(p.x, blast.l, blast.r);
  const edgeY = clamp(p.y, blast.t, blast.b);
  koFx.push({
    x: edgeX,
    y: edgeY,
    ang: Math.atan2(G.stage.y - 200 - edgeY, -edgeX), // the blast points back at the stage
    t: 0,
    color: p.color,
    // launched off the top: they sail off into the distance and twinkle out instead of the ray blast
    star: p.y < blast.t,
    ch: p.ch,
    dir: sign(p.vx + p.kvx),
  });
  G.shake = Math.max(G.shake, 26);
  G.flash = Math.max(G.flash, 0.45);
  sfx.ko();
  voice(p.ch, 'ow');
  dbg.ko = G.clock;
  if (p.y < blast.t) dbg.topko = G.clock;

  const killer = recentlyHit ? players.get(p.lastHitBy) : null;
  if (G.state === 'play' && p.inMatch) {
    scoreKo(p, killer);
  } else {
    // warming up in the lobby: nothing is at stake
    p.respawnT = 1;
    tell(p, { t: 'buzz', k: 'ko' });
  }
  p.pct = 0;
  tellHud(p);
  G.hudDirty = true;
}

// A KO during a match costs a life, credits whoever landed the last hit, and puts the fighter out on their last life.
function scoreKo(p, killer) {
  p.stocks--;
  p.stats.falls++;
  if (killer && killer !== p) {
    killer.kos++;
    killer.matchKos++;
    killer.stats.kos++;
    feed(`${nameTag(killer)} KO'd ${nameTag(p)}`);
  } else {
    feed(`${nameTag(p)} fell`);
  }
  if (p.stocks <= 0) {
    p.out = true;
    p.outAt = G.matchT;
    tell(p, { t: 'st', s: 'out' });
  } else {
    p.respawnT = 1.3;
    tell(p, { t: 'st', s: 'ko' });
  }
}

// Player records: create, remove, change fighter, bot skill, respawn, combat-state resets and per-match stats.

const newStats = () => ({ kos: 0, falls: 0, dmg: 0, taken: 0, combo: 0 });

// A bot's reaction delay (lower is sharper). Each bot rolls its temper u once when it joins; the Bot level setting only
// maps u into that level's range, so changing the level mid-match never draws from the seeded rng.
const SKILL = { easy: [1.2, 1.7], normal: [0.55, 1], hard: [0.32, 0.5] };
export function botSkill(u) {
  const [a, b] = SKILL[SETTINGS.bots] || SKILL.normal;
  return a + (b - a) * u;
}

export function setChar(p, ch) {
  p.ch = CHARS[ch] ? ch : 'mochi';
  p.c = CHARS[p.ch];
  p.size = p.c.size;
  p.R = 34 * p.c.size;
  // the first colour nobody else on this fighter is wearing (a random one if all are taken)
  const sameFighter = [...players.values()].filter((q) => q !== p && q.ch === p.ch);
  const used = new Set(sameFighter.map((q) => q.color));
  const alts = p.c.alts;
  p.color = alts.find((color) => !used.has(color)) || alts[Math.floor(rng() * alts.length)];
  p.light = mix(p.color, '#ffffff', 0.55);
  p.nextCh = null;
  G.hudDirty = true;
  tellYou(p);
}

// Two phones called "Mango" become "Mango" and "Mango 2", so name tags and the kill feed stay unambiguous.
function uniqueName(name, id) {
  const others = [...players.values()].filter((q) => q.id !== id);
  const taken = new Set(others.map((q) => q.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  let n = 2;
  while (taken.has(`${name} ${n}`.toLowerCase())) n++;
  return `${name} ${n}`;
}

export function addPlayer(id, name, ch, opts = {}) {
  name = uniqueName(name, id);
  let p = players.get(id);
  if (p) {
    p.name = name;
    if (ch && ch !== p.ch) changeChar(p, ch);
    tellYou(p);
    G.hudDirty = true;
    return p;
  }
  const usedTags = new Set([...players.values()].map((q) => q.ti));
  let ti = 0;
  while (usedTags.has(ti) && ti < PALETTE.length) ti++;
  // prettier-ignore
  p = {
    // who they are, and what lasts for the whole session
    id, name, ti, tag: PALETTE[ti % PALETTE.length],
    bot: opts.bot ? { t: 0, a: 0, s: 0, j: 0, d: 0, sx: 0, sy: 0, st: 0, u: 0, skill: 0 } : null,
    kb: !!opts.kb, tapJump: opts.tapJump ?? (!opts.bot && !opts.kb),
    wins: 0, kos: 0, ready: false,
    // input: the stick, the buttons held, and last tick's values for spotting presses and flicks
    in: { x: 0, y: 0, b: 0 }, prevB: 0, lastX: 0, lastY: 0,
    // flicks: how recently the stick was near the middle on each axis, and whether it is already far out
    midX: 0, midY: 0, outX: false, outY: false, aimT: 0,
    linkString: null, // the string a jump cut into, while the jump squat lasts
    upSpent: false, // the stick is still up from the push that last jumped
    // where they are standing
    x: 0, y: 0, face: 1, grounded: false, plat: null,
    // this match
    alive: false, inMatch: false, out: false, stocks: 0, respawnT: 0, matchKos: 0,
    stats: newStats(), outAt: null,
    // drawing that is not reset between lives
    trail: [], runPh: rand(TAU), sq: 0, sqV: 0, seed: rand(10), hitAt: -9,
    ...rested(1), // the fight itself; resetCombat fills this in again once the fighter is chosen
  };
  if (p.bot) {
    p.bot.u = rng();
    p.bot.skill = botSkill(p.bot.u);
  }
  players.set(id, p);
  setChar(p, ch);
  resetCombat(p);
  if (G.state === 'lobby' || G.state === 'result') {
    respawn(p, true);
  } else if (G.state === 'countdown') {
    // still in time for this match
    p.inMatch = true;
    p.stocks = G.matchStocks || stocksFor(players.size);
    respawn(p, true);
  } else {
    tell(p, { t: 'st', s: 'wait' });
  }
  if (G.state === 'lobby' && G.lobbyT !== null) G.lobbyT = Math.max(G.lobbyT, 6); // give newcomers a moment
  tellYou(p);
  sfx.join();
  G.hudDirty = true;
  return p;
}

// A computer fighter, on whichever fighter is least picked so far.
export function addBot(ch) {
  if (players.size >= 40) return null;
  const list = [...players.values()];
  const taken = new Set(list.map((p) => p.name));
  const counts = ORDER.map((c) => list.filter((p) => p.ch === c).length);
  const pick = ch || ORDER[counts.indexOf(Math.min(...counts))];
  const name = BOT_NAMES.find((n) => !taken.has(n)) || `Bot ${G.botSeq}`;
  return addPlayer(`bot-${G.botSeq++}`, name, pick, { bot: true });
}

export function changeChar(p, ch) {
  if (!CHARS[ch] || ch === p.ch) {
    p.nextCh = null;
    return;
  }
  if (G.state === 'lobby' || G.state === 'result' || !p.inMatch) {
    setChar(p, ch);
    puff(p.x, p.y, p.color, 12, 260);
  } else {
    p.nextCh = ch;
    tell(p, { t: 'note', text: `${CHARS[ch].name} next match` });
  }
}

export function removePlayer(id) {
  const p = players.get(id);
  if (!p) return;
  untangle(p);
  players.delete(id);
  if (G.lastWinner === p) G.lastWinner = null;
  if (G.state === 'lobby' && players.size < 2) G.lobbyT = null;
  G.hudDirty = true;
}

// Sets which buttons a fighter is holding. Presses are remembered until the next tick reads them: a quick tap whose
// press and release both land between two ticks (common when the network delivers packets in bunches) would
// otherwise never be seen.
export function setButtons(p, buttons) {
  p.in.tap |= buttons & ~p.in.b; // the buttons that just went down
  p.in.b = buttons;
}

// Lets go of ledges and grabs in both directions.
function untangle(p) {
  releaseLedge(p);
  if (p.holding) release(p);
  if (p.heldBy) release(p.heldBy);
}

// A fighter at rest: every field the fight reads, back to its starting value. This is the whole list.
// airJumps comes from the fighter that was picked.
function rested(airJumps) {
  // prettier-ignore
  return {
    // motion
    vx: 0, vy: 0, kvx: 0, kvy: 0,
    // the move in progress, and what's stopping the next one
    move: null, lag: 0, hitstun: 0, freeze: 0, dizzy: 0, helpless: false,
    // damage, and who dealt it
    pct: 0, lastHitBy: null, lastHitT: -99, combo: 0, comboBy: null, comboDmg: 0,
    // shield and dodges
    shielding: false, shieldHP: 100, shieldAt: -9, dodgeT: 0, spot: false, airDodged: false, airDodge: false,
    slideT: 0, techW: 0,
    // timers from items and hits
    invuln: 0, heavyT: 0, speedT: 0, flashT: 0, stunImm: 0, hover: 0,
    // buffered button presses
    bufA: 0, bufS: 0, bufJ: 0, bufD: 0,
    // jumping and falling
    airJumps, jumpT: 0, jumpSrc: 'b', shortOK: false, squat: 0, coyote: 0, ff: false,
    flickD: false, flickS: false, dropT: 0, dropPlat: null, crouch: false,
    // running
    dashT: 0, flipT: 0, skidT: 0, teeter: 0, teeterSide: 0, edgeT: 0, edgeReady: false,
    // walls and ledges
    wallT: 0, wallSide: 0, wallJumps: 2, wallSlideT: 0, ledge: null, ledgeCd: 0, ledgeInvUsed: false,
    hangT: 0, climbT: 0,
    // grabs and throws
    holding: null, heldBy: null, holdT: 0, escape: 0, pummelT: 0, throwT: 0,
    // jab chain
    jabNext: null, jabAt: -9,
    // drawing
    smokeT: 0, ghostT: 0,
  };
}

function resetCombat(p) {
  untangle(p);
  Object.assign(p, rested(p.c.airJumps));
  p.trail.length = 0;
}

function respawn(p, quick) {
  resetCombat(p);
  p.alive = true;
  p.x = rand(-G.stage.half * 0.5, G.stage.half * 0.5);
  p.y = G.stage.y - 430;
  p.grounded = false;
  p.plat = null;
  p.hover = quick ? 0.01 : 2.2;
  p.invuln = quick ? 0.5 : 2.6;
  p.face = p.x > 0 ? -1 : 1;
  tellHud(p);
  G.hudDirty = true;
}

// Match flow: countdown, stage rotation, start, end, rankings, awards and back to the lobby.

export function setState(state) {
  G.state = state;
  G.stT = 0;
  G.hudDirty = true;
  document.body.dataset.state = state;
}

// True when there are phone players and every one of them has tapped READY. Bots and keyboard/pad players
// never hold things up; with no phones at all the lobby simply runs its timer (or the host starts it).
function everyoneReady() {
  const phones = [...players.values()].filter((p) => !p.bot && !p.kb);
  return phones.length > 0 && phones.every((p) => p.ready);
}

// The next match's stage: the one the host just picked (T or the menu), else the first match stays put and later ones
// move on through the rotation. The lobby shows exactly this.
export function nextStage() {
  if (G.stageLock || !matchLog.length) return G.stageId;
  return STAGE_ORDER[(STAGE_ORDER.indexOf(G.stageId) + 1) % STAGE_ORDER.length];
}

export function startCountdown() {
  setState('countdown');
  G.lobbyT = null;
  G.matchT = 0;
  G.sudden = false;
  G.lastBeep = -1;
  projs.length = 0;
  items.length = 0;
  for (const p of players.values()) untangle(p);
  const prev = G.stageId;
  G.stageId = nextStage();
  G.stageLock = false; // the host's pick covers one match; then the rotation takes over again
  if (G.stageId !== prev) {
    tearAway();
    sfx.tear();
  }
  buildStage(players.size);
  const list = [...players.values()];
  const count = list.length;
  const stocks = stocksFor(count);
  G.matchStocks = stocks; // latecomers during the countdown get the same lives as everyone else
  list.forEach((p, i) => {
    if (p.nextCh) setChar(p, p.nextCh);
    resetCombat(p);
    p.alive = true;
    p.inMatch = true;
    p.out = false;
    p.stocks = stocks;
    p.matchKos = 0;
    p.stats = newStats();
    p.outAt = null;
    p.ready = false;
    // lined up across the island, facing the middle
    p.x = count === 1 ? 0 : lerp(-G.stage.half * 0.8, G.stage.half * 0.8, i / (count - 1));
    p.y = G.stage.y - p.R;
    p.grounded = true;
    p.plat = G.stage.main;
    p.face = p.x > 0 ? -1 : 1;
    tell(p, { t: 'st', s: 'ready' });
    tellHud(p);
  });
  hideResults();
}

function startMatch() {
  setState('play');
  G.nextItem = rand(7, 10);
  resetHazards();
  banner('GO!', '', 700);
  sfx.go();
  for (const p of players.values()) {
    tell(p, { t: 'st', s: 'play' });
    tellHud(p);
  }
}

export function endMatch(winner) {
  setState('result');
  if (dbg.result === undefined) dbg.result = G.clock; // the first result only
  matchLog.push({
    t: Math.round(G.matchT),
    n: [...players.values()].filter((p) => p.inMatch).length,
    w: winner ? winner.ch : '-',
  });
  document.documentElement.dataset.matches = matchLog.map((m) => m.t).join(','); // for the headless tests

  if (winner) {
    celebrate(winner);
  } else {
    G.lastWinner = null; // no stale winner from last match
    banner('Draw!', 'Nobody left standing', 3000);
    sfx.draw();
  }

  const ranked = rank(winner);
  const awards = giveAwards(ranked);
  for (const p of players.values()) p.place = 0; // only this match's fighters get a place (the HUD cards show it)
  ranked.forEach((p, i) => {
    p.place = i + 1;
    p.award = awards.get(p) || '';
    tell(p, {
      t: 'res',
      place: p.place,
      of: ranked.length,
      award: p.award,
      kos: p.stats.kos,
      falls: p.stats.falls,
      dmg: Math.round(p.stats.dmg),
      combo: p.stats.combo,
      wins: p.wins,
    });
  });
  showResults(ranked);

  for (const p of players.values()) {
    tell(p, { t: 'st', s: p === winner ? 'win' : 'over', who: winner ? winner.name : '' });
    p.inMatch = false;
    p.out = false;
    p.ready = false;
    if (!p.alive) p.respawnT = rand(0.6, 1.4);
    tellHud(p);
  }
}

// The win goes on the scoreboard, with a banner, confetti and a cheer.
function celebrate(winner) {
  winner.wins++;
  G.lastWinner = winner;
  const kos = `${winner.matchKos} KO${winner.matchKos === 1 ? '' : 's'}`;
  banner(`${esc(winner.name)} wins!`, `${winner.c.name} · ${kos}`, 3000, winner.tag, true);
  for (let i = 0; i < 120; i++) {
    const angle = rand(TAU);
    const speed = rand(150, 900);
    particles.push({
      x: winner.x,
      y: winner.y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 300,
      g: 900,
      life: rand(0.9, 2),
      max: 2,
      size: rand(4, 9),
      color: PALETTE[Math.floor(rng() * PALETTE.length)],
      drag: 1.2,
    });
  }
  sfx.win();
  voice(winner.ch, 'yay');
}

// Placings: the winner, then whoever lasted longest, then lives and damage.
function rank(winner) {
  const NEVER = 1e9; // still standing at the end
  const lasted = (p) => p.outAt ?? NEVER;
  const placeOrder = (a, b) => {
    if (a === winner) return -1;
    if (b === winner) return 1;
    return lasted(b) - lasted(a) || b.stocks - a.stocks || a.pct - b.pct;
  };
  return [...players.values()].filter((p) => p.inMatch).sort(placeOrder);
}

// Awards, best story first. Each goes to whoever scores highest among the players still without one, if they earned it.
const AWARDS = [
  { label: 'KO Machine', score: (p) => p.stats.kos, earned: (p) => p.stats.kos >= 2 },
  { label: 'Combo Artist', score: (p) => p.stats.combo, earned: (p) => p.stats.combo >= 4 },
  { label: 'Heavy Hitter', score: (p) => p.stats.dmg, earned: (p) => p.stats.dmg >= 40 },
  // took little, but did fight
  {
    label: 'Untouchable',
    score: (p) => -p.stats.taken,
    earned: (p) => p.stats.taken < 60 && p.stats.dmg >= 30,
  },
  {
    label: 'Glass Cannon',
    score: (p) => p.stats.dmg - p.stats.taken,
    earned: (p) => p.stats.dmg > 60 && p.stats.falls >= 2,
  },
  // whoever finished last
  { label: 'Never Gave Up', score: (p, ranked) => ranked.indexOf(p), earned: () => true },
];

// One award per player at most. Returns a Map of player to award label.
function giveAwards(ranked) {
  const given = new Map();
  if (ranked.length < 2) return given;
  for (const award of AWARDS) {
    const candidates = ranked.filter((p) => !given.has(p));
    if (!candidates.length) break;
    const best = candidates.reduce((a, b) => (award.score(b, ranked) > award.score(a, ranked) ? b : a));
    if (award.earned(best)) given.set(best, award.label);
  }
  return given;
}

export function backToLobby() {
  setState('lobby');
  G.lobbyT = null;
  hideResults();
  for (const p of players.values()) {
    tell(p, { t: 'st', s: 'lobby' });
    tellYou(p); // their READY, if they tapped it on the results screen, still stands
  }
  if (G.mode === 'keys') {
    // keyboard and pad players stay locked in, so the same fighters again is one Enter away
    for (const p of players.values()) if (p.kb) p.ready = true;
  }
}

// One simulation tick: lobby timer, countdown, match clock and sudden death, items, fighters, hits, projectiles, effects.

const ITEM_TYPES = ['heavy', 'speed', 'shock', 'heart'];
const ITEM_NAMES = { heavy: 'Heavy', speed: 'Speed', shock: 'Shockwave', heart: 'Heal' };
const ITEM_HALF = 22; // half an item's height: how far its centre rests above a platform
const SHOCK_RADIUS = 300;

function spawnItem() {
  items.push({
    x: rand(-G.stage.half * 0.85, G.stage.half * 0.85),
    y: G.stage.y - 560,
    vy: 0,
    type: ITEM_TYPES[Math.floor(rng() * ITEM_TYPES.length)],
    t: 0,
    landed: false,
  });
}

function collect(p, item) {
  const color = ITEMS[item.type];
  if (item.type === 'heavy') {
    p.heavyT = 9;
  } else if (item.type === 'speed') {
    p.speedT = 9;
  } else if (item.type === 'heart') {
    p.pct = Math.max(0, p.pct - 40);
    tellHud(p);
    G.hudDirty = true;
  } else {
    shockwave(p, color);
  }
  puff(item.x, item.y, color, 14, 380);
  ring(item.x, item.y, 16, 70, 0.25, color);
  if (item.type !== 'shock') sfx.pick();
  tell(p, { t: 'buzz', k: 'pick' });
  feed(`${nameTag(p)} got <b style="color:${color}">${ITEM_NAMES[item.type]}</b>`);
}

// The shock item: everyone near whoever picked it up gets knocked away.
function shockwave(p, color) {
  for (const q of players.values()) {
    if (q === p || !vulnerable(q)) continue;
    if (Math.hypot(q.x - p.x, q.y - p.y) < SHOCK_RADIUS) {
      hit(p, q, { dmg: 10, kb: 380, kbg: 420, ang: 50 }, sign(q.x - p.x), 1, 1, 'proj');
    }
  }
  ring(p.x, p.y, p.R, SHOCK_RADIUS, 0.45, color, true);
  G.shake = Math.max(G.shake, 14);
  sfx.shock();
}

// Is the point inside the island's rock body?
const inSolid = (x, y) => G.stage.solids.some((s) => x > s.x1 && x < s.x2 && y > s.y1 - 4 && y < s.y2);

// One fixed tick of the whole game, in order: match flow, fighters, hits, stage events, projectiles, items, the
// end-of-match check, effects, camera.
export function step(dt) {
  G.clock += dt;
  G.stT += dt;
  stepFlow(dt);

  // Decided after the state changes above, so nobody gets a free tick. Fighters hold still through the countdown, the
  // first seconds of the results (which belong to the winner) and behind the cards of the keyboard fighter select.
  const frozen =
    G.state === 'countdown' ||
    (G.state === 'result' && G.stT < 3) ||
    (G.mode === 'keys' && G.state === 'lobby');
  const list = [...players.values()];
  for (const p of list) updateFighter(p, dt, frozen);
  const alive = list.filter((p) => p.alive);
  pushApart(alive, dt);
  if (!frozen) {
    for (const p of alive) if (p.alive && p.freeze <= 0) moveHits(p, alive);
  }
  stepHazards(dt, alive); // also clears a leftover hazard once the match is over
  stepProjectiles(dt, alive);
  stepItems(dt, alive);
  checkMatchOver(list);
  stepEffects(dt);
  updateCamera(dt, alive);
}

// The lobby timer, the countdown beats, the match clock and sudden death, results, and the item timer.
function stepFlow(dt) {
  // keyboard play has no lobby timer: it starts when everyone has locked in and someone presses Enter
  if (G.state === 'lobby' && G.mode !== 'keys') stepLobbyTimer(dt);
  if (G.state === 'countdown') stepCountdown();
  if (G.state === 'play') stepMatchClock(dt);
  if (G.state === 'result' && G.stT > RESULT_T) backToLobby();
  if (G.state === 'play' || G.state === 'lobby') {
    G.nextItem -= dt;
    if (G.nextItem <= 0) {
      G.nextItem = rand(8, 13);
      if (SETTINGS.items && items.length < 2 && players.size > 0) spawnItem();
    }
  }
}

function stepLobbyTimer(dt) {
  if (players.size < 2) {
    G.lobbyT = null;
    return;
  }
  if (G.lobbyT === null) G.lobbyT = LOBBY_WAIT;
  if (everyoneReady()) G.lobbyT = Math.min(G.lobbyT, 3.5);
  G.lobbyT -= dt;
  if (G.lobbyT <= 0) startCountdown();
}

// 3, 2, 1: a banner and a beep on each beat, then the match starts.
function stepCountdown() {
  const beat = 3 - Math.floor(G.stT);
  if (beat !== G.lastBeep && beat >= 1) {
    G.lastBeep = beat;
    const caption = { 3: STAGES[G.stageId].name, 2: 'Get ready', 1: 'Set…' }[beat];
    banner(String(beat), caption, 800);
    sfx.beep();
  }
  if (G.stT >= 3) startMatch();
}

// When the time limit runs out everyone jumps to at least 150%, and damage keeps climbing until someone falls.
function stepMatchClock(dt) {
  G.matchT += dt;
  if (!G.sudden && SETTINGS.time && G.matchT >= SETTINGS.time) {
    G.sudden = true;
    dbg.sudden = G.clock;
    banner('SUDDEN DEATH', 'One hit could end it', 1800, '#ff8fa3');
    sfx.ko();
    for (const p of players.values()) {
      if (!p.inMatch || p.out) continue;
      p.pct = Math.max(p.pct, 150);
      tellHud(p);
    }
  }
  if (G.sudden) {
    for (const p of players.values()) if (p.alive) p.pct = Math.min(999, p.pct + 6 * dt);
    G.hudDirty = true;
  }
}

// Bodies gently push apart on the ground.
function pushApart(alive, dt) {
  for (let i = 0; i < alive.length; i++) {
    for (let j = i + 1; j < alive.length; j++) {
      const a = alive[i];
      const b = alive[j];
      if (!a.grounded || !b.grounded || a.plat !== b.plat) continue;
      if (a.dodgeT > 0 || b.dodgeT > 0 || a.holding === b || b.holding === a) continue;
      const dx = b.x - a.x;
      const min = (a.R + b.R) * 0.8;
      if (Math.abs(dx) < min) {
        const push = (min - Math.abs(dx)) * 6 * dt * sign(dx);
        a.x -= push;
        b.x += push;
      }
    }
  }
}

// Projectiles fly, fall, bounce on platforms, break on walls and hit the first foe they touch.
function stepProjectiles(dt, alive) {
  for (let i = projs.length - 1; i >= 0; i--) {
    const shot = projs[i];
    shot.t += dt;
    shot.life -= dt;
    if (shot.g) shot.vy += shot.g * dt;
    const prevY = shot.y;
    shot.x += shot.vx * dt;
    shot.y += shot.vy * dt;
    let dead = shot.life <= 0 || inSolid(shot.x, shot.y);
    if (shot.g && shot.vy > 0) {
      for (const plat of G.stage.plats) {
        const landed = prevY + shot.r <= plat.y + 2 && shot.y + shot.r >= plat.y;
        if (!landed || shot.x <= plat.x1 || shot.x >= plat.x2) continue;
        if (shot.bounce > 0) {
          shot.bounce--;
          shot.y = plat.y - shot.r;
          shot.vy = -Math.abs(shot.vy) * 0.75;
        } else {
          dead = true;
        }
      }
    }
    if (!dead) {
      for (const q of alive) {
        if (q === shot.owner || !vulnerable(q)) continue;
        if (Math.hypot(q.x - shot.x, q.y - shot.y) >= shot.r + q.R * 0.9) continue;
        // an owner who has left the game still hits, but takes no credit
        const owner = players.has(shot.owner.id) ? shot.owner : null;
        hit(owner, q, shot, sign(shot.vx), 1, shot.dmgMul, 'proj', { x: shot.x, y: shot.y });
        dead = true;
        break;
      }
    }
    if (dead) {
      puff(shot.x, shot.y, shot.color, 6, 200);
      projs.splice(i, 1);
    }
  }
}

// Items drop onto the stage, expire after a while, and are picked up by touch.
function stepItems(dt, alive) {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    item.t += dt;
    if (!item.landed) {
      const prevY = item.y;
      item.vy = Math.min(260, item.vy + 500 * dt);
      item.y += item.vy * dt;
      for (const plat of G.stage.plats) {
        const crossed = prevY + ITEM_HALF <= plat.y && item.y + ITEM_HALF >= plat.y;
        if (crossed && item.x > plat.x1 && item.x < plat.x2) {
          item.y = plat.y - ITEM_HALF;
          item.landed = true;
        }
      }
      if (item.y > G.stage.blast.b) {
        items.splice(i, 1);
        continue;
      }
    }
    if (item.t > 16) {
      puff(item.x, item.y, ITEMS[item.type], 6, 160);
      items.splice(i, 1);
      continue;
    }
    for (const p of alive) {
      if (!p.alive || p.hover > 0 || p.heldBy) continue;
      if (Math.hypot(p.x - item.x, p.y - item.y) < p.R + 24) {
        items.splice(i, 1);
        collect(p, item);
        break;
      }
    }
  }
}

// The match ends when one fighter is left standing; nobody left is a draw.
function checkMatchOver(list) {
  if (G.state !== 'play') return;
  const standing = list.filter((p) => players.has(p.id) && p.inMatch && !p.out);
  if (standing.length <= 1) endMatch(standing[0] || null);
}

// Particles, smoke, rings, bolts, afterimages, impact stars, KO blasts and pop-up text age and drift.
function stepEffects(dt) {
  // particles and smoke don't care about order, so a dead one is replaced by the last instead of shifting the rest
  for (let i = particles.length - 1; i >= 0; i--) {
    const particle = particles[i];
    particle.life -= dt;
    if (particle.life <= 0) {
      particles[i] = particles[particles.length - 1];
      particles.pop();
      continue;
    }
    if (particle.g) particle.vy += particle.g * dt;
    particle.x += particle.vx * dt;
    particle.y += particle.vy * dt;
    const slow = Math.exp(-(particle.drag || 2) * dt);
    particle.vx *= slow;
    particle.vy *= slow;
  }
  for (let i = smokes.length - 1; i >= 0; i--) {
    const smoke = smokes[i];
    smoke.life -= dt;
    if (smoke.life <= 0) {
      smokes[i] = smokes[smokes.length - 1];
      smokes.pop();
      continue;
    }
    smoke.x += smoke.vx * dt;
    smoke.y += smoke.vy * dt;
    smoke.vx *= Math.exp(-4 * dt);
    smoke.vy *= Math.exp(-4 * dt);
    smoke.r += smoke.grow * dt;
  }
  for (const list of [rings, bolts, ghosts]) {
    for (let i = list.length - 1; i >= 0; i--) {
      list[i].life -= dt;
      if (list[i].life <= 0) list.splice(i, 1);
    }
  }
  for (let i = impacts.length - 1; i >= 0; i--) {
    impacts[i].t += dt;
    if (impacts[i].t > impacts[i].life) impacts.splice(i, 1);
  }
  for (let i = koFx.length - 1; i >= 0; i--) {
    const blast = koFx[i];
    blast.t += dt;
    if (blast.star && !blast.pinged && blast.t > 0.8) {
      blast.pinged = true;
      sfx.twinkle();
    }
    if (blast.t > 1.3) koFx.splice(i, 1);
  }
  for (let i = popTexts.length - 1; i >= 0; i--) {
    const text = popTexts[i];
    text.t += dt;
    const lasts = text.size > 1.3 ? 1.3 : 0.8; // big ones stay up longer
    if (text.t > lasts) popTexts.splice(i, 1);
  }
}
