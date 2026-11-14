// Boot and the frame loop: a fixed 120 Hz simulation, drawn at most 60 times a second.
// Debug URL flags: ?bots=N &go &seed=N &stage=ID &ff=SECONDS &until=EVENT &after=S &freeze &fixedres (see README).
import { STAGES } from './roster.js';
import {
  $,
  addBot,
  buildStage,
  dbg,
  G,
  hazard,
  items,
  koLog,
  matchLog,
  params,
  players,
  projs,
  setState,
  step,
} from './game.js';
import { draw, loadSprites, lowerQuality, resize } from './draw.js';
import { bindFront, drawFront, firstMode, frontKey, hud, refreshMenu, setMode } from './ui.js';
import { bindInput, connect, loadInfo, padUpdate } from './input.js';
import { updateMusic } from './sound.js';

const STEP = 1 / 120;
const MIN_GAP = 10; // ms between frames: a 120 Hz screen draws every other refresh
const freeze = params.has('freeze');
let last = performance.now();
let acc = 0;

// If the frame rate sits well under what the screen can show for two 2-second spells running, the canvas drops to a
// lower resolution. Not while the tab is hidden: browsers throttle frames there anyway.
let spellStart = 0; // 0: not timing a spell
let spellFrames = 0;
let shortestGap = 1e9; // ms: the quickest the screen has shown two frames this spell
let slowSpells = 0;

function startSpell(now) {
  spellStart = now;
  spellFrames = 0;
  shortestGap = 1e9;
}

function watchPace(now, gapMs) {
  if (params.has('fixedres')) return;
  if (document.hidden || G.paused) {
    startSpell(0);
    return;
  }
  if (!spellStart) {
    startSpell(now);
    return;
  }
  spellFrames++;
  shortestGap = Math.min(shortestGap, gapMs);
  if (now - spellStart < 2000) return;
  const fps = (spellFrames * 1000) / (now - spellStart);
  const screenFps = Math.min(60, 1000 / Math.max(shortestGap, 1000 / 240)); // a TV may only do 30
  startSpell(now);
  slowSpells = fps < screenFps * 0.8 ? slowSpells + 1 : 0;
  if (slowSpells >= 2 && lowerQuality()) slowSpells = 0;
}

// Frames between redraws. Behind the fighter select, the pause menu and the results sheet the scene is blurred, and on
// the title it's an empty stage: nobody can tell 20 fps from 60 there, and the blur is as dear as the drawing.
function redrawEvery() {
  if (G.paused || (G.mode === 'keys' && G.state === 'lobby')) return 3;
  if (!G.mode || (G.state === 'result' && G.stT > 3)) return 2;
  return 1;
}
let framesHeld = 0;

function frame(now) {
  requestAnimationFrame(frame);
  if (now - last < MIN_GAP) return;
  watchPace(now, now - last);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  padUpdate();
  refreshMenu();
  if (!freeze && !G.paused) {
    // slow motion on a KO hit
    const slow = G.slowT > 0;
    if (slow) G.slowT -= dt;
    G.shake *= Math.exp(-10 * dt);
    G.flash = Math.max(0, G.flash - dt * 1.8);
    if (G.impact) {
      G.impact.t += dt;
      if (G.impact.t > 0.8) G.impact = null;
    }
    acc += slow ? dt * 0.25 : dt;
    while (acc >= STEP) {
      step(STEP);
      acc -= STEP;
    }
  }
  framesHeld++;
  if (framesHeld >= redrawEvery()) {
    framesHeld = 0;
    draw(now / 1000);
  }
  hud(now);
  drawFront();
  updateMusic(heat());
}

// How tense the match is, 0..1: the counter-melody comes in as damage climbs or someone is on their last life.
function heat() {
  if (G.state !== 'play') return 0;
  if (G.sudden) return 1;
  let hottest = 0;
  for (const p of players.values()) {
    if (!p.inMatch || p.out) continue;
    const lastLife = p.stocks === 1 ? 0.7 : 0;
    hottest = Math.max(hottest, p.pct / 130, lastLife);
  }
  return Math.min(1, hottest);
}

function boot() {
  if (STAGES[params.get('stage')]) G.stageId = params.get('stage');
  buildStage(2);
  setState('lobby');
  setMode(firstMode());
  addEventListener('resize', resize);
  resize();
  bindInput();
  bindFront();
  connect();
  loadInfo();

  const bots = Math.min(30, Number(params.get('bots')) || 0);
  for (let i = 0; i < bots; i++) addBot();
  if (params.has('go') && players.size >= 2) G.lobbyT = 0.5;
  // ?ff=SECONDS fast-forwards; &until=EVENT (a dbg key: hit, ko, result, warn…) stops just after that event instead
  const until = params.get('until');
  const after = Number(params.get('after')) || 0.04;
  let seconds = Number(params.get('ff')) || 0;
  if (!seconds && until) seconds = 400;
  for (let i = 0; i < seconds * 120; i++) {
    step(STEP);
    if (until && dbg[until] != null && G.clock - dbg[until] >= after) break;
  }
  if (freeze) {
    G.shake = 0;
    G.flash *= 0.3;
    setTimeout(() => $('#banner').classList.remove('show'), 0);
  }
  requestAnimationFrame(frame);
}

loadSprites();
boot();

window.__ko = { players, matchLog, koLog, dbg, G, hazard, items, projs, frontKey }; // for the console and the tests
