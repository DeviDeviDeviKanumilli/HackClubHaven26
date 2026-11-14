// Everything on the big screen's canvas. The art is sprite sheets in assets/ (sprites.json says where each frame sits on
// its sheet); this file picks the frames, places them and composes the frame in draw(). Anything random in here is for
// looks only, so it uses Math.random or vrand and never touches the seeded fight.
import { CHARS } from './roster.js';
import {
  bolts,
  clamp,
  DISPLAY,
  easeOut,
  FONT,
  G,
  ghosts,
  hazard,
  impacts,
  ITEMS,
  items,
  koFx,
  lerp,
  params,
  particles,
  players,
  projs,
  rings,
  ROLL_R,
  shakeK,
  sign,
  smokes,
  TAU,
  vrand,
} from './game.js';

const INK = '#2b2340';
const CAST = 'rgba(43,35,64,0.26)'; // a cut-out's shadow on the paper behind it
const CREAM = '#fff8e6';

// The canvas

const cv = document.querySelector('#cv');
const ctx = cv.getContext('2d', { alpha: false }); // every frame paints the whole screen
let W = 1280;
let H = 720;
let DPR = 1;

// How sharp to draw. Past 1.5x only the fighters and text get any crisper, while every full-screen layer costs the
// square of the ratio to fill. ?dpr=N overrides the cap; lowerQuality() steps the canvas down if the machine can't
// keep up.
const QUALITY = [1, 0.8, 0.66];
let qualityStep = 0;

// Steps the canvas resolution down a notch. Returns false once it is as low as it goes.
export function lowerQuality() {
  if (qualityStep >= QUALITY.length - 1) return false;
  qualityStep++;
  resize();
  return true;
}

export function resize() {
  const maxDPR = Number(params.get('dpr')) || 1.5;
  DPR = Math.min(devicePixelRatio || 1, maxDPR) * QUALITY[qualityStep];
  W = innerWidth;
  H = innerHeight;
  cv.width = W * DPR;
  cv.height = H * DPR;
}

function newCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  const g = c.getContext('2d');
  return g ? [c, g] : [null, null];
}

// n wrapped into 0..size, for things that go round and round.
const wrap = (n, size) => ((n % size) + size) % size;

// Sprites

const ASSETS = new URL('assets/', import.meta.url);
let atlas = null;
const sheets = new Map();

// Reads sprites.json and starts every sheet loading. Until a sheet arrives, what's on it just isn't drawn.
export async function loadSprites() {
  const response = await fetch(new URL('sprites.json', ASSETS));
  atlas = await response.json();
  for (const set of Object.values(atlas))
    for (const name of set.pages) {
      const img = new Image();
      img.src = new URL(`${name}.webp`, ASSETS).href;
      sheets.set(name, img);
    }
}

// Recoloured frames are made once and kept. 'multiply' turns the white parts the colour and keeps the ink;
// 'source-in' paints the whole shape in it (shadows, ghosts, flashes).
const tints = new Map();

// A frame: where it sits on its sheet, its anchor (the point drawn at the origin) and its pixels per unit. alt picks a
// fighter's colour block. Null until its sheet has loaded.
function frame(set, name, alt = 0, tint = null, mode = 'multiply') {
  const sprites = atlas && atlas[set];
  const entry = sprites && sprites.frames[name];
  const img = entry && sheets.get(sprites.pages[entry[0]]);
  if (!img || !img.complete || !img.naturalWidth) return null;
  const fr = {
    img,
    sx: entry[1],
    sy: entry[2] + alt * (sprites.block || 0),
    w: entry[3],
    h: entry[4],
    ax: entry[5],
    ay: entry[6],
    k: entry[7],
  };
  if (!tint) return fr;
  const key = `${set} ${name} ${alt} ${tint} ${mode}`;
  if (!tints.has(key)) {
    if (tints.size > 800) tints.clear();
    tints.set(key, tintedCopy(fr, tint, mode));
  }
  const copy = tints.get(key);
  return copy && { ...fr, img: copy, sx: 0, sy: 0 };
}

// The frame recoloured on a canvas of its own (null if there is no canvas to be had).
function tintedCopy(fr, tint, mode) {
  const [canvas, g] = newCanvas(fr.w, fr.h);
  if (!g) return null;
  g.drawImage(fr.img, fr.sx, fr.sy, fr.w, fr.h, 0, 0, fr.w, fr.h);
  g.globalCompositeOperation = mode;
  g.fillStyle = tint;
  g.fillRect(0, 0, fr.w, fr.h);
  if (mode === 'multiply') {
    // multiply fills the clear pixels with the tint too: cut the shape back out
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(fr.img, fr.sx, fr.sy, fr.w, fr.h, 0, 0, fr.w, fr.h);
  }
  return canvas;
}

const fx = (name, tint, mode) => frame('fx', name, 0, tint, mode);

// Draws a frame with its anchor at (x, y), sx and sy units per unit of the art (negative mirrors it).
function put(fr, x = 0, y = 0, sx = 1, sy = sx) {
  if (!fr) return;
  if (sx < 0 || sy < 0) {
    // mirrored: flip the canvas round the anchor and draw it the right way round
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(sign(sx), sign(sy));
    put(fr, 0, 0, Math.abs(sx), Math.abs(sy));
    ctx.restore();
    return;
  }
  const kx = sx / fr.k;
  const ky = sy / fr.k;
  ctx.drawImage(fr.img, fr.sx, fr.sy, fr.w, fr.h, x - fr.ax * kx, y - fr.ay * ky, fr.w * kx, fr.h * ky);
}

// Moves to (x, y), turns by rot and scales. Draw at the origin, then ctx.restore().
function place(x, y, rot = 0, sx = 1, sy = sx) {
  ctx.save();
  ctx.translate(x, y);
  if (rot) ctx.rotate(rot);
  ctx.scale(sx, sy);
}

// A soft round glow of radius r: added as light, or laid on like paint.
function glow(color, x, y, r, alpha = 1, mode = 'lighter') {
  if (r <= 0 || alpha <= 0) return;
  ctx.globalCompositeOperation = mode;
  ctx.globalAlpha = alpha;
  put(fx('glow', color, 'source-in'), x, y, r / 64);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

// A flat ink ellipse, for shadows on the ground.
function shadow(x, y, rx, ry, alpha) {
  ctx.globalAlpha = alpha;
  put(fx('disc', INK, 'source-in'), x, y, rx / 32, ry / 32);
  ctx.globalAlpha = 1;
}

// The view

// The camera, and the view actually drawn: cam plus the zoom punch toward a hit.
export const cam = { x: 0, y: -40, z: 0.9, off: 0, punch: 0, px: 0, py: 0, focus: null, focusT: 0 };
const V = { x: 0, y: -40, z: 0.9 };
const VY = 0.47; // how far down the screen the camera's centre sits (the player cards take the bottom)

// Frames every fighter (with a little lookahead), zooms out fast and in slowly, never shows past the blast zones, and
// cuts in close for KO hits and the winner. Fighters far off screen get an edge bubble instead of dragging the view.
export function updateCamera(dt, alive) {
  const blast = G.stage.blast;
  const half = G.stage.half;
  const panel = G.state === 'lobby' && W > 900 ? 300 : 0; // the lobby's join card, on the left
  const maxZ = Math.min(2.2, W / 640);
  const minZ = Math.max(0.3, (W - panel) / (blast.r - blast.l + 200));
  const ahead = (v) => clamp(v * 0.15, -220, 220); // where a fighter is about to be
  let x1 = Infinity;
  let x2 = -Infinity;
  let y1 = Infinity;
  let y2 = -Infinity;
  for (const p of alive) {
    if (p.heldBy) continue;
    const px = clamp(p.x + ahead(p.vx + p.kvx), -half - 360, half + 360);
    const py = clamp(p.y + ahead(p.vy + p.kvy), G.stage.y - 620, G.stage.y + 280);
    x1 = Math.min(x1, px - 150);
    x2 = Math.max(x2, px + 150);
    y1 = Math.min(y1, py - 170);
    y2 = Math.max(y2, py + 110);
  }
  // keep a rolling hazard in shot while it is on the stage, so nobody gets hit by something unseen
  const ev = hazard.ev;
  if (ev && ev.kind === 'roll' && x1 !== Infinity && ev.y < G.stage.y + 200) {
    let hx = clamp(ev.x, -half - 200, half + 200);
    if (ev.phase === 'warn') hx = ev.dir > 0 ? G.stage.main.x1 - 80 : G.stage.main.x2 + 80;
    x1 = Math.min(x1, hx - 120);
    x2 = Math.max(x2, hx + 120);
    y2 = Math.max(y2, G.stage.y + 60);
    y1 = Math.min(y1, G.stage.y - 200);
  }
  if (x1 === Infinity) {
    // nobody to frame: show the island
    x1 = -half;
    x2 = half;
    y1 = G.stage.y - 300;
    y2 = G.stage.y + 120;
  }
  // The lobby holds a wider shot drawn toward the middle, so the stage reads as a place; matches frame the action.
  const lobby = G.state === 'lobby';
  let cx = ((x1 + x2) / 2) * (lobby ? 0.4 : 0.92);
  let cy = (y1 + y2) / 2;
  const w = Math.max(x2 - x1, lobby ? 1100 : 660);
  const h = Math.max(y2 - y1, lobby ? 540 : 380);
  // the player cards cover the bottom of the screen: fit the action into the space above them
  const cardsH = G.cardsH || 0;
  const roomH = Math.min(H * 0.78, (H - cardsH) * 0.88);
  let targetZ = Math.min((W - panel) / w, roomH / h, maxZ);
  cy += Math.max(0, cardsH / 2 - H * (0.5 - VY)) / targetZ;
  let speed = 4.5;
  if (cam.focus && cam.focus.alive && cam.focusT > 0) {
    // in close on a KO hit
    cam.focusT -= dt;
    cx = lerp(cx, cam.focus.x, 0.6);
    cy = lerp(cy, cam.focus.y, 0.6);
    targetZ = Math.min(targetZ * 1.35, maxZ * 1.1);
    speed = 9;
  } else {
    cam.focus = null;
  }
  if (G.state === 'result' && G.lastWinner && G.lastWinner.alive && G.stT < 4) {
    cx = G.lastWinner.x;
    cy = G.lastWinner.y - 40;
    targetZ = Math.min(maxZ, 1.9);
    speed = 2.5;
  }
  targetZ = clamp(targetZ, minZ, maxZ * 1.1);
  // zoom out fast, in gently, in log space so it feels even at any zoom
  const zoomRate = targetZ < cam.z ? 6 : 1.8;
  const zoomEase = 1 - Math.exp(-zoomRate * dt);
  const logZ = Math.log(cam.z);
  cam.z = Math.exp(logZ + (Math.log(targetZ) - logZ) * zoomEase);
  const panEase = 1 - Math.exp(-speed * dt);
  cam.x += (cx - cam.x) * panEase;
  cam.y += (cy - cam.y) * panEase;
  cam.off += (panel / 2 - cam.off) * (1 - Math.exp(-3.5 * dt));
  // keep the view inside the blast zones, and don't show much below the island
  const viewHalfW = (W - panel) / 2 / cam.z;
  const left = blast.l + viewHalfW;
  const right = blast.r - viewHalfW;
  const top = blast.t + (H * VY) / cam.z;
  const bottom = G.stage.y + 520 - (H * (1 - VY)) / cam.z;
  cam.x = left < right ? clamp(cam.x, left, right) : (blast.l + blast.r) / 2;
  cam.y = top < bottom ? clamp(cam.y, top, bottom) : (top + bottom) / 2;
  cam.punch *= Math.exp(-5 * dt);
}

// This frame's view: a hit's zoom punch zooms in toward the point of impact.
function syncView() {
  V.z = cam.z * (1 + cam.punch * shakeK());
  const towardImpact = 1 - cam.z / V.z;
  V.x = cam.x + (cam.px - cam.x) * towardImpact;
  V.y = cam.y + (cam.py - cam.y) * towardImpact;
}

// World coordinates to screen pixels.
const sxOf = (x) => (x - V.x) * V.z + W / 2 + cam.off;
const syOf = (y) => (y - V.y) * V.z + H * VY;

// The frame

// Floating combat text. A text with a key replaces the one already showing under that key instead of stacking up.
export const popTexts = [];
export function popText(x, y, text, color, size = 1, key = null) {
  const showing = key != null && popTexts.find((pt) => pt.key === key);
  if (showing) Object.assign(showing, { x, y, text, color, size, t: 0 });
  else popTexts.push({ x, y, text, color, t: 0, size, key });
}

export function draw(t) {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  drawBackground(t);
  syncView();
  // where the world's origin lands on screen, jittered by screen shake
  const shake = G.shake * shakeK();
  const z = V.z;
  const ox = W / 2 + cam.off - V.x * z + (shake ? vrand(-1, 1) * shake : 0);
  const oy = H * VY - V.y * z + (shake ? vrand(-1, 1) * shake : 0);

  // world space
  ctx.setTransform(DPR * z, 0, 0, DPR * z, DPR * ox, DPR * oy);
  drawStage();
  drawHitLight();
  drawSpotlight(z, ox, oy);
  const fighters = [...players.values()].filter((p) => p.alive);
  for (const p of fighters) drawGroundShadow(p);
  for (const it of items) drawItem(it, t);
  drawHazard(t);
  drawSmoke();
  for (const g of ghosts) drawGhost(g);
  for (const p of fighters) drawPlayer(p, t);
  drawProjectiles(t);
  drawRings();
  drawBolts();
  drawParticles();
  drawImpacts();
  drawKoRays();

  // screen space
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  drawForeground();
  drawMotes(onTwos(t));
  drawNameTags(fighters, z);
  drawBubbles(fighters, t);
  drawPopTexts(z);
  drawHitWords(z);
  drawStarKOs();
  drawKoStickers();
  drawFocusLines(z, ox, oy);
  drawPaperFinish();
  if (G.flash > 0 && shakeK()) {
    ctx.fillStyle = `rgba(255,250,235,${G.flash * 0.4 * shakeK()})`;
    ctx.fillRect(0, 0, W, H);
  }
  drawTear(t);
}

// The backdrop: sky, hanging set pieces, ambient life and three cut-out layers, baked for a 1920 x 1080 screen

// The backdrop animates "on twos" (12 drawings a second) like stop-motion paper; the fighters stay smooth.
const onTwos = (t) => Math.floor(t * 12) / 12;
// backdrop pixels to screen pixels, covering the screen
const fit = () => Math.max(W / 1920, H / 1080);

// The camera's travel and zoom, measured at the fighting plane. Something at a depth of 0.5 (0 is the sky, 1 the fight)
// slides half as far and swells half as much when the camera pushes in. The resting zoom drifts after the camera, so
// it's the pushes and pulls that read.
const parallax = { restZ: 0, last: 0 };
function cameraTravel(t) {
  const dt = clamp(t - parallax.last, 0, 0.1);
  parallax.last = t;
  if (!parallax.restZ) parallax.restZ = V.z;
  parallax.restZ += (V.z - parallax.restZ) * (1 - Math.exp(-0.35 * dt));
  return { x: V.x * V.z, y: (V.y - (G.stage.y - 160)) * V.z, zoom: clamp(V.z / parallax.restZ, 0.8, 1.7) };
}

function drawBackground(t) {
  const sky = frame(G.stageId, 'sky');
  if (!sky) {
    ctx.fillStyle = '#b2ddf1';
    ctx.fillRect(0, 0, W, H);
    return;
  }
  const scenery = atlas[G.stageId];
  put(sky, (W - 1920 * fit()) / 2, 0, fit());
  const travel = cameraTravel(t);
  drawHangers(scenery, onTwos(t), travel);
  scenery.layers.forEach(([depth, fullH], i) => {
    if (i === 1) drawLife(onTwos(t)); // flyers pass between the far and middle cut-outs
    drawLayer(frame(G.stageId, `layer${i}`), fullH, depth, travel);
  });
}

// One full-height layer, scaled about the screen's centre of view and kept covering the bottom of the screen.
function drawLayer(fr, fullH, depth, travel) {
  if (!fr) return;
  const base = fit();
  const swell = Math.max(1, 1 + (travel.zoom - 1) * depth * 1.5);
  const centreY = H * VY;
  const slack = Math.max(0, (fr.w * base * swell - W) / 2);
  const slideX = clamp(-travel.x * depth, -slack, slack);
  const slideY = clamp(-travel.y * depth * 0.6, H - centreY - (fullH * base - centreY) * swell, H * 0.08);
  put(fr, W / 2 + slideX, centreY + slideY - centreY * swell, base * swell);
}

// Set pieces hanging on strings from the top of the box, swaying a little.
function drawHangers(scenery, t, travel) {
  const scale = fit();
  ctx.strokeStyle = 'rgba(43,35,64,.55)';
  ctx.lineWidth = 1.5;
  ctx.fillStyle = 'rgba(255,248,220,.75)';
  scenery.hangers.forEach(([across, drop, depth, phase], i) => {
    const x = across * W * 1.3 - W * 0.15 + clamp(-travel.x * depth, -W * 0.15, W * 0.15);
    const y = drop * scale + clamp(-travel.y * depth * 0.5, -30, 50);
    place(x, -6, Math.sin(t * 0.7 + phase) * 0.045);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, y + 6);
    ctx.stroke();
    ctx.fillRect(-9, 0, 18, 12); // the tape holding the string
    put(frame(G.stageId, `hang${i}`), 0, y + 4, scale);
    ctx.restore();
  });
}

// Ambient life: birds over the meadow, cranes over the peaks, a buzzard and tumbleweeds on the mesa.
const life = { id: null, list: [], next: 0, last: 0 };

// A flock crosses now and then. Meadow birds and peak cranes share this.
function spawnFlock(critters, t) {
  life.next = t + vrand(9, 16);
  const dir = Math.random() < 0.5 ? 1 : -1;
  const y0 = H * vrand(0.1, 0.3);
  const count = 2 + Math.floor(Math.random() * 4);
  const speed = vrand(70, 110);
  for (let i = 0; i < count; i++) {
    const gap = i * vrand(30, 60);
    critters.push({
      kind: 'bird',
      x: dir > 0 ? -60 - gap : W + 60 + gap,
      y: y0 + vrand(-30, 30) + i * 10,
      vx: speed * dir * vrand(0.92, 1.08),
      ph: vrand(0, TAU),
      size: vrand(0.95, 1.35),
      tint: Math.random() < 0.25,
    });
  }
}

// A tumbleweed rolls in from one side.
function spawnWeed(critters, t) {
  life.next = t + vrand(10, 18);
  const dir = Math.random() < 0.5 ? 1 : -1;
  critters.push({
    kind: 'weed',
    x: dir > 0 ? -50 : W + 50,
    y: H * 0.66,
    vx: dir * vrand(90, 140),
    size: vrand(0.55, 0.8),
    ph: 0,
    hop: 0,
    vy: 0,
  });
}

// One bird or crane, flapping as it crosses. null once it has left the screen.
function stepBird(critter, dt, shift, t) {
  critter.x += critter.vx * dt;
  if (critter.x < -200 || critter.x > W + 200) return null;
  const wingsUp = Math.sin(t * 11 + critter.ph) > 0;
  return {
    name: (critter.tint ? 'tint' : 'crit') + (wingsUp ? 0 : 1),
    x: critter.x + shift,
    y: critter.y + Math.sin(t * 2 + critter.ph) * 8,
    rot: 0,
    flip: critter.vx > 0 ? 1 : -1,
  };
}

// The buzzard circles, mostly gliding, with the odd flap.
function stepBuzzard(critter, shift, t) {
  const a = t * 0.18 + critter.ph;
  const flip = -Math.sin(a) > 0 ? 1 : -1;
  const flapping = Math.sin(t * 9) > 0.6 && Math.sin(t * 0.7 + critter.ph) > 0.5;
  return {
    name: flapping ? 'crit1' : 'crit0',
    x: critter.cx + Math.cos(a) * W * 0.22 + shift,
    y: critter.cy + Math.sin(a) * H * 0.05,
    rot: Math.cos(a) * 0.12 * flip,
    flip,
  };
}

// A tumbleweed bouncing along. null once it has left the screen.
function stepWeed(critter, dt, shift) {
  critter.x += critter.vx * dt;
  if (critter.x < -200 || critter.x > W + 200) return null;
  critter.vy += 900 * dt;
  critter.hop += critter.vy * dt;
  if (critter.hop > 0) {
    critter.hop = 0;
    critter.vy = -vrand(120, 260);
  }
  critter.ph += (critter.vx / (16 * critter.size)) * dt;
  return {
    name: 'weed',
    x: critter.x + shift * 1.4,
    y: critter.y + critter.hop,
    rot: critter.ph,
    flip: 1,
  };
}

function drawLife(t) {
  if (life.id !== G.stageId) Object.assign(life, { id: G.stageId, list: [], next: t + 2, last: t });
  const dt = Math.min(0.1, t - life.last);
  life.last = t;
  const critters = life.list;
  const shift = clamp(-cam.x * 0.12, -W * 0.08, W * 0.08); // a little parallax
  const mesa = atlas[G.stageId].critters === 'mesa';
  if (!mesa && t > life.next) spawnFlock(critters, t);
  if (mesa) {
    if (!critters.some((c) => c.kind === 'buzzard')) {
      critters.push({ kind: 'buzzard', cx: W * vrand(0.3, 0.7), cy: H * 0.17, ph: vrand(0, TAU), size: 1.3 });
    }
    if (t > life.next) spawnWeed(critters, t);
  }
  for (let i = critters.length - 1; i >= 0; i--) {
    const critter = critters[i];
    let spot = null;
    if (critter.kind === 'buzzard') spot = stepBuzzard(critter, shift, t);
    else if (critter.kind === 'bird') spot = stepBird(critter, dt, shift, t);
    else spot = stepWeed(critter, dt, shift);
    if (!spot) {
      critters.splice(i, 1);
      continue;
    }
    place(spot.x, spot.y, spot.rot, spot.flip * critter.size, critter.size);
    put(frame(G.stageId, spot.name));
    ctx.restore();
  }
}

// The island and platforms, in world space. The island is baked at a few widths; the nearest is stretched to fit.
function drawStage() {
  const scenery = atlas && atlas[G.stageId];
  if (!scenery) return;
  const half = G.stage.half;
  let near = scenery.islands[0];
  for (const baked of scenery.islands) if (Math.abs(baked - half) < Math.abs(near - half)) near = baked;
  put(frame(G.stageId, `island${near}`), 0, G.stage.y, (half + 50) / (near + 50), 1);
  const plat = frame(G.stageId, 'plat');
  for (const pl of G.stage.plats.slice(1)) put(plat, (pl.x1 + pl.x2) / 2, pl.y); // plats[0] is the island
}

// The foreground lip of the diorama box, nearer than the fight: it slides faster and swells more than the stage.
function drawForeground() {
  const fr = frame(G.stageId, 'fg');
  if (!fr) return;
  const zoom = clamp(V.z / (parallax.restZ || V.z), 0.8, 1.7);
  const scale = Math.max(1, 1 + (zoom - 1) * 0.9) * fit();
  const slack = Math.max(0, (fr.w * scale - W) / 2);
  const x = W / 2 - (fr.w / 2) * scale + clamp(-V.x * V.z * 1.3, -slack, slack);
  const y = H - fr.h * 0.8 * scale + clamp((V.y - (G.stage.y - 160)) * V.z * 0.12, -10, 40);
  put(fr, x, y, scale);
}

// Specks drifting in the air: pollen and dust, or snow on the peaks. The big ones are close to the lens.
const MOTE = { meadow: '#ffffff', mesa: '#fff4d6', peaks: '#ffffff' };
const motes = Array.from({ length: 40 }, (_, i) => ({
  x: Math.random(),
  y: Math.random(),
  size: 1.4 + Math.random() * 1.8,
  speed: 0.008 + Math.random() * 0.017,
  ph: Math.random() * Math.PI * 2,
  big: i < 5,
}));
function drawMotes(t) {
  const color = MOTE[G.stageId];
  const snow = G.stageId === 'peaks';
  const span = W * 1.2;
  for (const m of motes) {
    const drift = m.x * span - cam.x * cam.z * (m.big ? 1.5 : 0.7) + Math.sin(t * 0.5 + m.ph) * 24;
    const fall = snow ? t * m.speed * 2.2 : -t * m.speed; // snow falls, pollen drifts up
    const x = wrap(drift, span) - W * 0.1;
    const y = wrap(m.y + fall, 1) * H * 1.1 - H * 0.05;
    if (snow) {
      ctx.globalAlpha = m.big ? 0.5 : 0.9;
      put(fx('disc'), x, y, (m.size * (m.big ? 2.6 : 1.3)) / 32);
    } else if (m.big) {
      glow(color, x, y, m.size * 9, 0.22 + 0.08 * Math.sin(t * 0.9 + m.ph)); // an out-of-focus disc
    } else {
      // a paper fleck tumbling in the air
      const a = t * 1.5 + m.ph;
      ctx.globalAlpha = 0.8;
      place(x, y, a, m.size / 5, (m.size * Math.cos(a * 1.3)) / 5);
      put(fx('fleck', color));
      ctx.restore();
    }
  }
  ctx.globalAlpha = 1;
}

// Paper grain over everything and the shadowed edges of the box, put together once per screen size and multiplied
// over the frame. The slow-motion KO closes the edges in further; sudden death makes them pulse red.
let finish = null;
function drawPaperFinish() {
  if (!finish || finish.width !== Math.ceil(W) || finish.height !== Math.ceil(H)) finish = makeFinish();
  if (finish) {
    ctx.globalCompositeOperation = 'multiply';
    ctx.drawImage(finish, 0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over';
  }
  if (G.slowT > 0) tintEdges(INK, 0.25);
  if (G.sudden && G.state === 'play') {
    const wave = Math.sin((performance.now() / 1000) * 2.4 * Math.PI);
    const beat = Math.pow(Math.max(0, wave), 6); // a sharp throb, 1.2 times a second
    tintEdges('#e62850', 0.42 + beat * 0.3);
  }
}

function tintEdges(color, alpha) {
  const fr = fx('vignette', color, 'source-in');
  if (!fr) return;
  ctx.globalAlpha = alpha;
  ctx.drawImage(fr.img, fr.sx, fr.sy, fr.w, fr.h, 0, 0, W, H);
  ctx.globalAlpha = 1;
}

function makeFinish() {
  const grain = fx('grain');
  const edge = fx('vignette', 'rgb(209,206,220)', 'source-in');
  const [canvas, g] = newCanvas(W, H);
  const [tile, tileG] = newCanvas(256, 256);
  if (!grain || !edge || !g || !tileG) return null;
  tileG.drawImage(grain.img, grain.sx, grain.sy, grain.w, grain.h, 0, 0, 256, 256);
  g.fillStyle = g.createPattern(tile, 'repeat');
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.globalCompositeOperation = 'multiply';
  g.drawImage(edge.img, 0, 0, edge.w, edge.h, 0, 0, canvas.width, canvas.height);
  return canvas;
}

// Stage change: the old scene is torn away like a page, revealing the new one.
let tear = null;
export function tearAway() {
  if (!cv.width) return;
  const [img, g] = newCanvas(cv.width, cv.height);
  if (!g) return;
  g.drawImage(cv, 0, 0);
  tear = { img, t0: null, jag: Array.from({ length: 34 }, () => vrand(-1, 1)) };
}

function drawTear(t) {
  if (!tear) return;
  if (tear.t0 === null) tear.t0 = t;
  const f = (t - tear.t0) / 0.9;
  if (f >= 1) {
    tear = null;
    return;
  }
  const eased = f * f * (3 - 2 * f);
  const slant = H * 0.32;
  const edgeX = lerp(W + slant + 60, -slant - 60, eased);
  // the torn edge, a slanted ragged line from top to bottom; the old page is everything left of it
  const edge = tear.jag.map((jag, i) => {
    const down = i / (tear.jag.length - 1);
    return [edgeX + slant * (0.5 - down) + jag * 14 + Math.sin(down * 9) * 10, down * H];
  });
  const page = (dx) => {
    ctx.beginPath();
    ctx.moveTo(edge[0][0] + dx, -10);
    for (const [x, y] of edge) ctx.lineTo(x + dx, y);
    ctx.lineTo(edge[edge.length - 1][0] + dx, H + 10);
    ctx.lineTo(-20, H + 10);
    ctx.lineTo(-20, -10);
    ctx.closePath();
  };
  page(16);
  ctx.fillStyle = 'rgba(43,35,64,.28)'; // its shadow on the new scene
  ctx.fill();
  page(7);
  ctx.fillStyle = '#fbf4e6'; // the white fibres of the tear
  ctx.fill();
  ctx.save();
  page(0);
  ctx.clip();
  ctx.drawImage(tear.img, 0, 0, W, H);
  ctx.restore();
}

// Fighters

// A fighter's colour is one of its four alts, and each alt is a block of the fighter's sheet.
const altOf = (ch, color) => Math.max(0, CHARS[ch].alts.indexOf(color));

// Draws fighter frame `name` centred at (x, y), body radius R, facing `face` (the turn squeeze included).
// o: alt, sx/sy (squash from the feet), rot, alpha, flash (0..1 whiten), tint (a flat silhouette in that colour) and
// shadow (false: no cast shadow).
function drawBody(ch, name, x, y, face, R, o = {}) {
  const sprites = atlas && atlas[ch];
  if (!sprites) return;
  // only pounds have a landing frame: anything else landing mid-move keeps its swing
  if (!(name in sprites.frames)) name = name.replace(/-l$/, '-a');
  if (!(name in sprites.frames)) name = 'ready';
  const scale = R / (34 * CHARS[ch].size);
  const sx = o.sx ?? 1;
  const sy = o.sy ?? 1;
  const drawAt = (dx, dy, fr) => {
    if (!fr) return;
    ctx.save();
    ctx.translate(x + dx, y + dy);
    ctx.scale(face, 1);
    if (o.rot) ctx.rotate(o.rot);
    if (sx !== 1 || sy !== 1) {
      ctx.translate(0, R * 0.92);
      ctx.scale(sx, sy);
      ctx.translate(0, -R * 0.92);
    }
    put(fr, 0, 0, scale);
    ctx.restore();
  };
  const art = (tint, mode) => frame(ch, name, o.alt || 0, tint, mode);
  const alpha = o.alpha ?? 1;
  const baseAlpha = ctx.globalAlpha;
  ctx.globalAlpha = baseAlpha * alpha;
  if (o.tint) {
    drawAt(0, 0, art(o.tint, 'source-in'));
  } else {
    if (o.shadow !== false) drawAt(R * 0.1, R * 0.16, art(CAST, 'source-in'));
    drawAt(0, 0, art());
    if (o.flash > 0) {
      ctx.globalAlpha = baseAlpha * alpha * Math.min(1, o.flash);
      drawAt(0, 0, art('#ffffff', 'source-in'));
    }
  }
  ctx.globalAlpha = baseAlpha;
}

const RUN_FRAMES = 6;

// How far through its swing a move is: head and tail along the arc (0..1) and fade.
function swing(m) {
  if (m.phase === 'startup' || m.phase === 'charge') return { head: 0, tail: 0, alpha: 0 };
  if (m.phase === 'active' || m.phase === 'land') {
    const sweepTime = Math.max(0.05, (m.def.ac || 0.1) * 0.75);
    const head = easeOut(clamp(m.t / sweepTime, 0, 1));
    return { head, tail: Math.max(0, head - 0.8), alpha: 1 };
  }
  // recovery: the tail catches up and it fades
  const f = clamp(m.t / 0.12, 0, 1);
  return { head: 1, tail: lerp(0.2, 1, f), alpha: 1 - f };
}

// Which frame a fighter shows and how it is squashed, spun, faded and shaken. Built up the way the fight reads: how
// they stand or move, their footwork, the move they're throwing, what they're holding on to, what's being done to
// them, and the winner's hop. Each layer overrides the last.
function poseOf(p, t) {
  const pose = {
    name: 'ready',
    sx: 1,
    sy: 1,
    rot: 0,
    alpha: 1,
    flash: p.flashT > 0 ? 0.85 : 0,
    dx: 0,
    dy: 0,
  };
  if (!p.grounded) {
    const up = p.vy < 0;
    pose.name = up ? 'rise' : 'fall';
    pose.sx = up ? 0.94 : 1.03;
    pose.sy = up ? 1.08 : 0.97;
  } else if (Math.abs(p.vx) > 40) {
    const stride = Math.abs(Math.cos(p.runPh));
    const step = Math.floor((p.runPh / TAU) * RUN_FRAMES);
    pose.name = 'run' + wrap(step, RUN_FRAMES);
    pose.rot = Math.abs(p.vx) > p.c.speed * 0.7 ? 0.05 : 0.02;
    pose.sx = 1 - stride * 0.03;
    pose.sy = 1 + stride * 0.04;
  } else {
    const breath = Math.sin(t * 3 + p.seed) * 0.03;
    pose.name = G.state === 'play' ? 'ready' : 'idle';
    pose.sx = 1 - breath;
    pose.sy = 1 + breath;
  }

  // footwork: sprinting, skidding, teetering on an edge, crouching, sliding down a wall, flipping, the landing squash
  if (p.grounded && Math.abs(p.vx) > p.c.speed * 1.05) pose.rot = 0.1;
  if (p.skidT > 0) {
    pose.name = 'skid';
    pose.rot = -0.18;
  }
  if (p.teeter > 0 && p.grounded && !p.move) {
    const wobble = Math.sin(t * 22);
    pose.name = wobble < 0 ? 'teeter0' : 'teeter1';
    pose.rot = -(p.teeterSide || 1) * p.face * (0.12 + 0.06 * wobble);
  }
  if (p.crouch || p.squat > 0) {
    pose.sy *= 0.8;
    pose.sx *= 1.12;
  }
  if (p.wallSlideT > 0) pose.name = 'wall';
  if (p.flipT > 0) pose.rot = (1 - p.flipT / 0.3) * TAU;
  pose.sx *= 1 - p.sq;
  pose.sy *= 1 + p.sq;

  // the move: w while winding up, a mid-swing, b at the end of it, l for a pound landing
  const m = p.move;
  if (m) {
    let part = 'a';
    if (m.phase === 'startup' || m.phase === 'charge') part = 'w';
    else if (m.phase === 'land') part = 'l';
    else if (m.phase === 'recovery' || (m.def.arc && swing(m).head > 0.75)) part = 'b';
    const key = m.def.name;
    if (key) pose.name = `${key}-${part}`;
    if (m.phase === 'charge') {
      pose.flash = 0.2 + 0.25 * Math.sin(t * 40) + m.charge * 0.3;
      pose.dx = Math.sin(t * 70) * p.R * 0.04;
      pose.sx *= 1.05;
      pose.sy *= 0.95;
    }
    if (m.def.spin && m.phase === 'active') pose.rot = m.t * 26;
    if (m.def.type === 'pound' && m.phase === 'active') {
      pose.sy *= 1.15;
      pose.sx *= 0.9;
    }
  }

  // holding someone, being held, hanging from a ledge, climbing up from one
  if (p.holding) pose.name = p.throwT > 0 ? 'throw' : 'hold';
  if (p.heldBy) {
    pose.name = 'held';
    pose.rot = Math.sin(t * 30) * 0.12;
  }
  if (p.ledge) {
    pose.name = 'ledge';
    pose.sx = 0.95;
    pose.sy = 1.06;
  }
  if (p.climbT > 0) {
    pose.sy *= 0.85;
    pose.sx *= 1.1;
  }

  // reeling from a hit, dizzy, shielding, falling helpless after a recovery move, dodging
  if (p.hitstun > 0) {
    pose.name = 'hurt';
    if (Math.hypot(p.kvx, p.kvy) > 380) pose.rot = G.clock * 13 * sign(p.kvx * p.face); // tumbling
  }
  if (p.freeze > 0 && p.flashT > 0) pose.dx += Math.sin(t * 110) * p.R * 0.12; // shaking in the hit-pause
  if (p.dizzy > 0) {
    pose.name = 'dizzy';
    pose.rot = Math.sin(t * 6) * 0.25;
  }
  if (p.shielding) pose.name = 'shield';
  if (p.helpless) {
    if (pose.name === 'rise' || pose.name === 'fall') pose.name = 'helpless';
    pose.alpha = 0.8;
  }
  if (p.dodgeT > 0) {
    pose.alpha = 0.45;
    if (p.spot) {
      pose.sx *= 0.9;
      pose.sy *= 0.9;
    }
  }
  if (p.invuln > 0 && !p.ledge && Math.sin(t * 30) > 0) pose.alpha = Math.min(pose.alpha, 0.5);
  if ((pose.name === 'ready' || pose.name === 'idle') && (t * 0.6 + p.seed) % 3.6 < 0.1) pose.name = 'blink';

  // the winner hops on the spot, arms up
  if (G.state === 'result' && p === G.lastWinner && G.stT < 3.2 && p.grounded) {
    const hop = Math.abs(Math.sin(t * 5.5));
    pose.name = 'win';
    pose.dy -= hop * p.R * 0.45;
    pose.sy = 1 + hop * 0.06;
    pose.sx = 1 - hop * 0.04;
  }
  if (p.ch === 'pinwheel') pose.dy += Math.sin(t * 2.6 + 1) * 0.05 * p.R; // Gale floats, bobbing gently
  return pose;
}

// Turning round, a paper puppet swings through edge-on like a card on a stick: the drawing squeezes to a sliver and
// opens out facing the other way. Drawing state only, never read by the fight.
const turns = new WeakMap();
function turnScale(p, t) {
  let turn = turns.get(p);
  if (!turn) {
    turn = { v: p.face, last: t };
    turns.set(p, turn);
  }
  const dt = clamp(t - turn.last, 0, 0.1);
  turn.last = t;
  // v runs from -1 (facing left) to 1 (facing right); a full turn takes ~0.18 s, and lingers a moment edge-on
  if (p.face > 0) turn.v = Math.min(1, turn.v + dt / 0.09);
  else turn.v = Math.max(-1, turn.v - dt / 0.09);
  const width = Math.max(0.07, Math.sin((Math.abs(turn.v) * Math.PI) / 2));
  return turn.v >= 0 ? width : -width;
}

// How far through being lowered in a respawning fighter is, 0..1.
const lowered = (p) => clamp((2.2 - p.hover) / 0.45, 0, 1);

// How far above its real position a respawning fighter is drawn while it is lowered in (0 once it has landed).
function dropOffset(p) {
  if (!(p.hover > 0)) return 0;
  const k = lowered(p);
  const eased = 1 + 2.2 * Math.pow(k - 1, 3) + 1.2 * Math.pow(k - 1, 2); // ease out with a little bounce
  return -(1 - eased) * 760;
}

// Respawns are a puppet show: the fighter is lowered on two strings, standing on a hanging card.
function drawPlayer(p, t) {
  if (!(p.hover > 0)) {
    drawFighterNow(p, t);
    return;
  }
  const drop = dropOffset(p);
  const cardY = p.y + p.R + 2 + drop;
  place(p.x, cardY, Math.sin(t * 2.2 + p.seed) * 0.035 * (1 - lowered(p) * 0.6));
  ctx.strokeStyle = 'rgba(43,35,64,.6)';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  for (const stringX of [-50, 50]) {
    ctx.moveTo(stringX, 0);
    ctx.lineTo(stringX * 0.6, p.y - 2600 - cardY);
  }
  ctx.stroke();
  put(fx('card'));
  put(fx('card.stripe', p.tag));
  ctx.translate(-p.x, drop - cardY); // back to world space, swaying with the card
  drawFighterNow(p, t);
  ctx.restore();
}

function drawFighterNow(p, t) {
  const m = p.move;
  const pose = poseOf(p, t);
  const face = turnScale(p, t);
  const alt = altOf(p.ch, p.color);
  const x = p.x + pose.dx;
  const y = p.y + pose.dy;
  drawAuras(p, m, t);
  if (m && m.def.armor && m.phase !== 'recovery') {
    // super armour: a gold die-cut plate the shape of the fighter, just proud of them
    const gold = Math.sin(t * 18) > 0.6 ? '#fff3c4' : '#ffc94a';
    drawBody(p.ch, pose.name, x, y + p.R * 0.06, face, p.R * 1.13, { ...pose, alt, alpha: 1, tint: gold });
  }
  drawBody(p.ch, pose.name, x, y, face, p.R, { ...pose, alt });
  if (m) drawSmear(p, m);
  drawOverlays(p, m, t);
}

// Behind the body: the item buff's glow, the charge streaks and Thorn's vine.
function drawAuras(p, m, t) {
  if (p.heavyT > 0 || p.speedT > 0) {
    const color = p.speedT > 0 ? ITEMS.speed : ITEMS.heavy;
    // it blinks as it runs out
    const timeLeft = Math.max(p.heavyT, p.speedT);
    if (timeLeft > 1.5 || Math.sin(t * 20) > 0) glow(color, p.x, p.y, p.R * 2, 0.55, 'source-over');
  }
  if (m && m.phase === 'charge') drawCharge(p, m, t);
  if (m && m.def.vine && m.phase === 'active')
    put(fx('vine'), p.x, p.y, (p.face * m.def.vine * p.size) / 220.5, 1);
}

// Gathering power for a smash: short paper streaks drawn in toward the fighter from all round, each starting somewhere
// new every time it comes back, faster and in the fighter's colour as the charge builds.
function drawCharge(p, m, t) {
  const R = p.R;
  const charge = clamp(m.charge, 0, 1);
  const period = lerp(0.42, 0.2, charge);
  const streak = fx('streak', charge > 0.6 ? p.light : null);
  for (let i = 0; i < 9; i++) {
    const cycle = t / period + i * 0.381;
    const lap = Math.floor(cycle);
    const phase = cycle - lap;
    const angle = i * (TAU / 9) + lap * 2.4;
    const from = R * lerp(2.4, 1.15, phase * phase);
    const len = R * (0.65 - phase * 0.35);
    const width = (2.5 + charge * 3.5) * Math.sin(phase * Math.PI);
    if (width < 0.4) continue;
    place(p.x, p.y, angle);
    put(streak, from + len / 2, 0, len / 40, (width + 3) / 8);
    ctx.restore();
  }
}

// The swing smear: a paper crescent along the move's arc, a thrust toward a poke's tip, or a glow on each hitbox.
function drawSmear(p, m) {
  const def = m.def;
  const scale = p.size * (def.normal ? p.c.reach : 1);
  const progress = swing(m);
  let color = p.light;
  if (def.fire) color = '#ffb86b';
  else if (def.bolt) color = '#fff3a0';
  if (def.spin) {
    if (m.phase !== 'active') return;
    const head = m.t * 1500 * (Math.PI / 180);
    const r = (def.ar || 50) * scale;
    for (let i = 0; i < 3; i++) swoosh(p, p.face, r, head - i * 1.75, 1, color, 0.9 - i * 0.2);
    return;
  }
  if (def.arc) {
    const dir = sign(def.arc[1] - def.arc[0]);
    const angle = lerp(def.arc[0], def.arc[1], progress.head) * (Math.PI / 180);
    const alpha = progress.alpha * Math.min(1, progress.head * 4) * (1 - progress.tail);
    const r = (def.ar || 55) * scale * (1 + m.charge * 0.15);
    swoosh(p, p.face, r, angle, dir, color, alpha);
    if (def.mirror) swoosh(p, -p.face, r, angle, dir, color, alpha);
    return;
  }
  if (def.poke && def.hb) {
    if (progress.alpha <= 0) return;
    const box = def.hb[0];
    const base = p.R * 0.4;
    const len = lerp(base, (box.x + box.r * 0.8) * scale, easeOut(progress.head)) - base;
    const halfW = box.r * scale * (0.55 + m.charge * 0.3);
    if (len < 1) return;
    ctx.globalAlpha = progress.alpha;
    place(p.x + p.face * base, p.y + box.y * scale, 0, (p.face * len) / 100, halfW / 25);
    put(fx('poke', color));
    put(fx('poke.core'));
    ctx.restore();
    ctx.globalAlpha = 1;
    return;
  }
  if ((m.phase === 'active' || m.phase === 'land') && !def.ring) {
    const boxes = (m.phase === 'land' ? def.land : def.hb) || [];
    for (const box of boxes) {
      const x = p.x + p.face * box.x * scale;
      const y = p.y + box.y * scale;
      glow(color, x, y, box.r * scale * 1.05, 0.9, 'source-over');
      glow('#ffffff', x, y, box.r * scale * 0.5, 0.9, 'source-over');
    }
  }
}

// One crescent of the smear, its leading edge at `angle`, trailing back the way the swing came (dir).
function swoosh(p, face, r, angle, dir, color, alpha) {
  if (alpha <= 0.01) return;
  ctx.globalAlpha = alpha;
  place(p.x, p.y);
  ctx.scale(face, 1);
  ctx.rotate(angle);
  ctx.scale(r / 100, (dir < 0 ? -r : r) / 100);
  put(fx('swoosh.rim'));
  put(fx('swoosh', color));
  put(fx('swoosh.core'));
  ctx.restore();
  ctx.globalAlpha = 1;
}

// In front of the body: the counter guard, the full-charge glint, the shield bubble and dizzy stars.
function drawOverlays(p, m, t) {
  const R = p.R;
  if (m && m.def.type === 'counter' && m.phase === 'active') {
    // three mint guard crescents circling, ready to turn a hit back
    for (let i = 0; i < 3; i++) {
      place(p.x, p.y, t * 5 + i * (TAU / 3), (R * 1.45) / 50);
      put(fx('band'));
      ctx.restore();
    }
  }
  if (m && m.phase === 'charge' && m.charge >= 0.98) {
    // full power: a glint pops on the body three times a second
    const beat = (t * 3) % 1;
    const size = R * 0.55 * Math.sin(Math.min(1, beat / 0.35) * Math.PI);
    if (size > 1) put(fx('glint'), p.x - p.face * R * 0.35, p.y - R * 0.55, size / 20);
  }
  if (p.shielding) {
    const r = R * (0.95 + (0.8 * p.shieldHP) / 100);
    put(fx('shield', p.tag, 'source-in'), p.x, p.y, r / 50);
    put(fx('shield.ink'), p.x, p.y, r / 50);
  }
  if (p.dizzy > 0) {
    for (let i = 0; i < 3; i++) {
      const a = t * 5 + (i * TAU) / 3;
      put(fx('disc', '#ffe66d'), p.x + Math.cos(a) * R * 0.8, p.y - R * 1.5 + Math.sin(a) * R * 0.2, 6 / 32);
    }
  }
}

// Ground shadow on whatever surface is under a fighter, so you can read their height in the air.
function drawGroundShadow(p) {
  let floor = null; // the highest platform under their feet
  for (const pl of G.stage.plats) {
    const below = pl.y >= p.y + p.R - 4 && p.x > pl.x1 - 6 && p.x < pl.x2 + 6;
    if (below && (!floor || pl.y < floor.y)) floor = pl;
  }
  if (!floor) return;
  const k = clamp(1 - (floor.y - (p.y + p.R)) / 500, 0.25, 1); // smaller and fainter the higher they are
  shadow(p.x + 4, floor.y + 2, p.R * 0.95 * k, p.R * 0.2 * k, 0.3 * k);
}

// An afterimage left behind by a dash or a sliding attack, fading out.
function drawGhost(g) {
  drawBody(g.ch, 'ready', g.x, g.y, g.face, g.s, { tint: g.col, alpha: (g.life / g.max) * 0.45 });
}

// Items: paper badges that bob where they land and blink before they vanish.
function drawItem(it, t) {
  if (it.t > 13 && Math.sin(t * 18) > 0) return;
  const y = it.y + (it.landed ? Math.sin(t * 3 + it.x) * 4 : 0);
  const r = 21 * Math.min(1, it.t * 5);
  if (r <= 0) return;
  glow(ITEMS[it.type], it.x, y, r * 2.6, 0.35);
  place(it.x, y, Math.sin(t * 2 + it.x) * 0.15, r / 21);
  put(fx('item-' + it.type));
  ctx.restore();
}

// Stage events: a roller trembling past the edge during the warning, then tumbling across; or a gust.
function drawHazard(t) {
  const ev = hazard.ev;
  if (!ev) return;
  const island = G.stage.main;
  if (ev.kind === 'gust') {
    drawWind(ev, island, t);
    return;
  }
  const r = ROLL_R;
  const warn = ev.phase === 'warn';
  let x = ev.x;
  let y = ev.y;
  if (warn) {
    const edge = ev.dir > 0 ? island.x1 - r * 1.2 : island.x2 + r * 1.2;
    x = edge + Math.sin(ev.t * 30) * 4;
    y = island.y - r;
  }
  if (!warn && ev.y <= island.y) shadow(x, island.y + 2, r * 0.9, r * 0.18, 0.22);
  ctx.globalAlpha = warn ? 0.55 + 0.45 * Math.abs(Math.sin(ev.t * 8)) : 1;
  place(x, y, ev.spin);
  put(frame(G.stageId, 'haz'));
  ctx.restore();
  ctx.globalAlpha = 1;
  if (warn) return;
  // speed lines behind it
  ctx.strokeStyle = 'rgba(43,35,64,.35)';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (const dy of [-0.5, 0, 0.5]) {
    ctx.moveTo(x - ev.dir * r * 1.2, y + dy * r);
    ctx.lineTo(x - ev.dir * r * (1.9 + Math.abs(dy)), y + dy * r);
  }
  ctx.stroke();
}

// A gust: paper streamers ripple through, ink wind lines rush past faster, and leaves (or snowflakes on the peaks)
// tumble along slowest. It swells in and dies away; the warning is just a few wind lines.
const WIND = Array.from({ length: 26 }, (_, i) => ({
  lane: (i * 0.618034) % 1, // height in the band, 0..1
  speed: 0.8 + ((i * 0.37) % 0.45),
  len: 200 + ((i * 97) % 240),
  width: 8 + (i % 4) * 2.5,
  phase: i * 2.1,
  color: i % 4,
}));
const RIBBON = {
  meadow: ['#fff8e6', '#ffd6de', '#d9f2c4', '#fff1a8'],
  peaks: ['#ffffff', '#e4f1ff', '#ffffff', '#f2f8ff'],
};
const LEAF = ['#7cc476', '#a8d98f', '#ffb3c1', '#f2c94c'];
const LEAF_BACK = ['#6da76c', '#92b881', '#d999aa', '#ceab4a']; // the same, 18% of the way to INK

function drawWind(ev, island, t) {
  const strength = ev.phase === 'warn' ? 0 : Math.sin(Math.min(1, ev.t / 4) * Math.PI);
  const dir = ev.dir;
  const span = island.x2 - island.x1 + 1400;
  const x0 = island.x1 - 700;
  const top = island.y - 640;
  const band = 620;
  const xAt = (i, speed) => x0 + wrap(t * speed * dir + i * 331, span);
  const colors = RIBBON[G.stageId] || RIBBON.meadow;
  // streamers, narrowing to an edge wherever they twist over (two are baked: 220 x 10 and a long one, 300 x 13)
  for (let i = 0; i < Math.round(16 * strength); i++) {
    const strip = WIND[i];
    const long = strip.len > 300;
    const twist = Math.max(0.14, Math.abs(Math.cos(t * 7 * strip.speed + strip.phase)));
    const x = xAt(i, 1350 * strip.speed);
    const y = top + strip.lane * band + Math.sin(t * 8 * strip.speed + strip.phase) * 6;
    const ribbon = fx(long ? 'ribbon1' : 'ribbon0', colors[strip.color]);
    put(ribbon, x, y, (dir * strip.len) / (long ? 300 : 220), (twist * strip.width) / (long ? 13 : 10));
  }
  // wind lines: each grows in, rushes across ending in a curl, and shrinks away
  const lines = ev.phase === 'warn' ? 3 : 4 + Math.round(8 * strength);
  for (let i = 0; i < lines; i++) {
    const travelled = t * 2300 * (0.85 + (i % 3) * 0.12) + i * 523;
    const across = wrap(travelled, span) / span;
    const grow = Math.sin(across * Math.PI);
    if (grow < 0.05) continue;
    const len = (220 + ((i * 71) % 180)) * grow;
    const x = x0 + (dir > 0 ? across : 1 - across) * span;
    const y = top + ((i * 0.381966 + 0.1) % 1) * band;
    put(fx('windline'), x, y, (dir * len) / 300, grow);
  }
  // tumbling leaves or snowflakes, flipping over as they go
  const peaks = G.stageId === 'peaks';
  for (let i = 0; i < Math.round(20 * strength); i++) {
    const strip = WIND[i];
    const flip = Math.cos(t * 7 * strip.speed + strip.phase);
    const y = top + ((strip.lane + 0.37) % 1) * band + Math.sin(t * 3 + strip.phase) * 30;
    const spin = t * 5 * strip.speed * dir + strip.phase;
    place(xAt(i + 40, 950 * strip.speed), y, spin, 1, Math.max(0.15, Math.abs(flip)));
    if (peaks) put(fx('flake'));
    else put(fx('motif-leaf', flip >= 0 ? LEAF[i % 4] : LEAF_BACK[i % 4]), 0, 0, 0.9);
    ctx.restore();
  }
}

// Effects

// Dust and launch smoke: cut-paper puffs, each its own shape, size and tilt, that billow out, turn and shrink away.
function drawSmoke() {
  for (const s of smokes) {
    if (s.v === undefined) {
      // first sight of this puff: pick its look
      s.v = Math.floor(Math.random() * 4);
      s.k = vrand(0.7, 1.35);
      s.rot = vrand(0, TAU);
      s.spin = vrand(-2.5, 2.5);
    }
    const f = s.life / s.max;
    const age = 1 - f;
    const grow = age < 0.15 ? lerp(0.55, 1.1, age / 0.15) : lerp(1.1, 0.25, ((age - 0.15) / 0.85) ** 1.4);
    ctx.globalAlpha = f < 0.2 ? f / 0.2 : 1;
    place(s.x, s.y - age * 10, s.rot + age * s.spin, (s.r * s.k * grow * 2.9) / 96);
    put(fx('puff' + s.v));
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

// Projectiles: paper needles, zigzag sparks, wind curls, bubbles and shots, each glowing in its own colour.
const PROJ_GLOW = { fire: '#ff9a3c', zap: '#ffe066', needle: '#b8f27a', bubble: '#9fdcff', gust: '#d9c8ff' };

function drawProjectiles(t) {
  const flicker = 0.9 + 0.1 * Math.sin(t * 40);
  for (const pr of projs) {
    glow(PROJ_GLOW[pr.kind] || pr.color, pr.x, pr.y, pr.r * 3.2 * flicker, 0.45);
    if (pr.kind === 'needle') {
      place(pr.x, pr.y, Math.atan2(pr.vy, pr.vx));
      put(fx('proj-needle'));
    } else if (pr.kind === 'zap') {
      place(pr.x, pr.y, 0, pr.dir, 1);
      put(fx('proj-zap'));
    } else if (pr.kind === 'gust') {
      // it opens up from a tight curl as it leaves the hand and winds back in as it dies
      const age = clamp(pr.t / Math.max(0.05, pr.t + pr.life), 0, 1);
      let open = 1;
      if (age < 0.15) open = easeOut(age / 0.15);
      else if (age > 0.8) open = 1 - ((age - 0.8) / 0.2) * 0.6;
      const s = (pr.r * (0.55 + 0.45 * open)) / 24;
      place(pr.x, pr.y, 0, pr.vx < 0 ? -s : s, s);
      put(fx('proj-gust.tail'), 0, Math.sin(pr.t * 22) * 3);
      ctx.rotate(pr.t * 15);
      put(fx('proj-gust'));
    } else if (pr.kind === 'bubble') {
      place(pr.x, pr.y, 0, pr.r / 30);
      put(fx('proj-bubble'));
    } else {
      place(pr.x, pr.y, 0, (pr.r * flicker) / 16);
      if (pr.kind === 'fire') put(fx('proj-fire'));
      else {
        put(fx('proj.rim'));
        put(fx('proj', pr.color));
        put(fx('proj.shine'));
      }
    }
    ctx.restore();
  }
}

// Shockwaves: a paper hoop that bursts out fast and is pared thinner until nothing is left. A flat hoop is one seen
// lying down: under a mid-air jump (sinking away), along the floor, or against a wall. A hit's hoop is squashed along
// the way the target flies and travels with it.
function drawRings() {
  for (const ring of rings) {
    if (ring.life > ring.max) continue; // still held back by its delay
    const f = 1 - ring.life / ring.max;
    const eased = 1 - (1 - f) ** 3;
    const radius = lerp(ring.r, ring.maxR, eased);
    const width = (ring.thick ? 15 : 9) * (1 - f) ** 1.7;
    if (width < 1.2 || radius <= 0) continue;
    let sx = 1;
    let sy = 1;
    let rot = 0;
    let cx = ring.x;
    let cy = ring.y;
    if (ring.kind === 'air') {
      sy = 0.3;
      cy += eased * 16;
    } else if (ring.kind === 'ground') sy = 0.24;
    else if (ring.kind === 'wall') sx = 0.3;
    else if (ring.ang != null) {
      rot = ring.ang;
      sx = 0.6;
      cx += Math.cos(ring.ang) * radius * 0.35;
      cy += Math.sin(ring.ang) * radius * 0.35;
    }
    // the hoops are baked with bands 40%, 20%, 10% and 5% of their radius wide: use the nearest
    const band = width / radius;
    let hoop = 3;
    if (band > 0.28) hoop = 0;
    else if (band > 0.14) hoop = 1;
    else if (band > 0.07) hoop = 2;
    place(cx, cy, rot, (sx * radius) / 100, (sy * radius) / 100);
    put(fx('hoop' + hoop, ring.color));
    ctx.restore();
  }
}

// Lightning: a zigzag stretched from one point to the other.
function drawBolts() {
  for (const bolt of bolts) {
    const dx = bolt.x2 - bolt.x1;
    const dy = bolt.y2 - bolt.y1;
    const name = bolt.thick ? 'bolt-thick' : 'bolt';
    ctx.globalAlpha = bolt.life / bolt.max;
    place(bolt.x1, bolt.y1, Math.atan2(dy, dx), Math.hypot(dx, dy) / 200, 1);
    put(fx(name + '.rim'));
    put(fx(name, bolt.color));
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

// Particles: sparks streaking along their path, a fighter's motif confetti, and plain paper flecks that thin as they
// turn edge-on.
function drawParticles() {
  for (const bit of particles) {
    ctx.globalAlpha = clamp((bit.life / bit.max) * 1.5, 0, 1);
    if (bit.streak) {
      const len = Math.hypot(bit.vx, bit.vy) * 0.04;
      place(bit.x, bit.y, Math.atan2(bit.vy, bit.vx));
      put(fx('streak', bit.color), -len / 2, 0, len / 40, (bit.size + 2.5) / 8);
    } else {
      if (bit.rot0 === undefined) {
        bit.rot0 = Math.random() * TAU;
        bit.spin = vrand(-14, 14);
      }
      const a = bit.rot0 + (bit.max - bit.life) * bit.spin;
      if (bit.shape) {
        place(bit.x, bit.y, a, bit.size / 10, (bit.size / 10) * (Math.abs(Math.cos(a * 1.3)) * 0.6 + 0.4));
        put(fx('motif-' + bit.shape, bit.color));
      } else {
        place(bit.x, bit.y, a, (bit.size * 1.6) / 10, (bit.size * Math.abs(Math.cos(a * 1.7)) + 0.6) / 6);
        put(fx('fleck', bit.color));
      }
    }
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

// Hits light up their surroundings: a quick additive bloom on the stage behind the fighters, in the hitter's colour.
function drawHitLight() {
  for (const im of impacts)
    if (im.size >= 45) glow(im.color, im.x, im.y, im.size * 4.5, (1 - im.t / im.life) * 0.4);
}

// A KO hit drops the house lights: the scenery and stage go dark around a pool of light on the hit, under the fighters,
// for the length of the slow motion. A dim, not a strobe, so it stays on with "Shake & flashes" turned down.
function drawSpotlight(z, ox, oy) {
  const im = G.impact;
  if (!im || im.t > 0.7) return;
  const shade = 'rgb(24,18,44)';
  // the lights go down fast and come back up slowly
  const fade = im.t < 0.06 ? im.t / 0.06 : Math.max(0, 1 - (im.t - 0.06) / 0.64) ** 1.5;
  const dim = fade * (0.4 + 0.25 * shakeK());
  const spot = fx('spot', shade, 'source-in');
  if (dim <= 0.01 || !spot) return;
  const x = im.x * z + ox;
  const y = im.y * z + oy;
  const r = Math.hypot(W, H) * 0.7;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.globalAlpha = dim;
  put(spot, x, y, r / 256);
  // everything outside the pool's square is in full shade
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, W, y - r);
  ctx.fillRect(0, y + r, W, H - y - r);
  ctx.fillRect(0, y - r, x - r, r * 2);
  ctx.fillRect(x + r, y - r, W - x - r, r * 2);
  ctx.globalAlpha = 1;
  ctx.setTransform(DPR * z, 0, 0, DPR * z, DPR * ox, DPR * oy);
}

// Manga focus lines: ink streaks rushing in from the screen edges toward a KO hit, for the first beat of the slow-mo.
// The hole in the middle closes in, and the lines are redrawn on twos like hand-inked frames.
function drawFocusLines(z, ox, oy) {
  const im = G.impact;
  const strength = shakeK();
  if (!im || im.t > 0.5 || !strength) return;
  const x = im.x * z + ox;
  const y = im.y * z + oy;
  const corner = Math.hypot(Math.max(x, W - x), Math.max(y, H - y)); // to the farthest corner
  const closing = 1 - 0.25 * Math.min(1, im.t * 5);
  const fade = im.t < 0.04 ? 1 : Math.max(0, 1 - (im.t - 0.04) / 0.46);
  ctx.globalAlpha = fade * (0.35 + 0.4 * strength);
  place(x, y, Math.floor(im.t * 24) * 0.7, Math.max(corner / 750, (140 * z) / 180) * closing);
  put(fx('focus'));
  ctx.restore();
  ctx.globalAlpha = 1;
}

// Hit impacts, timed to the hit-pause. The burst lands full size (a hit has no wind-up) with a little overshoot and
// holds while both fighters are frozen, flickering between paper white and the hitter's colour. When the pause ends
// it's flung the way the target flies: it slides that way, stretches thin and is pared away, with ink slash lines
// peeling off behind.
function drawImpacts() {
  for (const im of impacts) {
    if (im.v === undefined) {
      im.v = Math.floor(Math.random() * 3); // which of the three bursts
      im.dir = im.ang ?? im.rot;
    }
    const hold = im.hold || 0.035;
    const end = im.burstEnd || im.life;
    const t = im.t;
    if (t >= end) continue; // the comic word can outlive the burst
    const held = t < hold;
    const flung = held ? 0 : (t - hold) / Math.max(0.01, end - hold); // 0..1 once the pause ends
    let pop = 1;
    if (t < 0.034) pop = lerp(1.18, 1.05, t / 0.034);
    else if (held) pop = 1.05 - 0.05 * Math.min(1, (t - 0.034) / 0.05);
    const s = im.size * pop * (1 - flung * flung);
    if (s < 1) continue;
    const stretch = 1 + flung * 1.1;
    const flick = held && Math.floor(t * 30) % 2 === 1;
    const slide = flung * im.size * 0.6;
    place(im.x + Math.cos(im.dir) * slide, im.y + Math.sin(im.dir) * slide, im.dir);
    ctx.save(); // the burst, stretched along the way it flies
    ctx.scale((s / 100) * stretch, s / 100 / Math.sqrt(stretch));
    put(fx(`burst${im.v}.rim`));
    put(fx(`burst${im.v}`, flick ? CREAM : im.color));
    put(fx(`burst${im.v}.core`, flick ? im.color : CREAM));
    ctx.restore();
    if (im.size > 40 && !held && flung < 0.75) {
      // slash lines peeling off behind the launch
      ctx.lineCap = 'round';
      ctx.strokeStyle = INK;
      ctx.lineWidth = 3;
      ctx.beginPath();
      const x0 = -im.size * (0.5 + flung * 1.2);
      for (let i = -1; i <= 1; i++) {
        const y0 = i * im.size * 0.3;
        ctx.moveTo(x0, y0);
        ctx.lineTo(x0 - im.size * (0.9 - Math.abs(i) * 0.3) * (1 - flung), y0 * 1.15);
      }
      ctx.stroke();
    }
    ctx.restore();
  }
}

// KO blasts: big paper rays fanning out from where the fighter left.
function drawKoRays() {
  for (const ko of koFx) {
    if (ko.star) continue;
    const len = 1500 * Math.min(1, ko.t * 5);
    if (len <= 0) continue;
    // full strength for the first instant, then a quick fade so the rays never hide the fight for long
    const fade = ko.t < 0.1 ? 0.9 : 0.9 * (1 - ko.t / 1.3) ** 3;
    ctx.globalAlpha = fade * Math.max(0.35, shakeK());
    place(ko.x, ko.y, ko.ang, len / 400);
    put(fx('rays', ko.color));
    put(fx('rays.mid'));
    put(fx('rays.in', ko.color));
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

// Labels, in screen pixels

// Text is set once into a little canvas and stamped from there: outlined text is among the slowest things a canvas
// draws, and the same few words (names, BOOF!, TECH, KO!) are on screen frame after frame. The cache is held to a
// count and a pixel budget, and cleared once the web fonts arrive.
const texts = new Map();
let textPixels = 0;
if (document.fonts) document.fonts.addEventListener?.('loadingdone', () => texts.clear());

// A text sprite: `text` set in `font` (`size` px) with `pad` px round it by paint(g, x, y), its baseline at (x, y).
function textSprite(key, text, font, size, pad, paint) {
  const hit = texts.get(key);
  if (hit) return hit;
  if (texts.size > 160 || textPixels > 8e6) {
    texts.clear();
    textPixels = 0;
  }
  ctx.font = font;
  const tw = ctx.measureText(text).width;
  const sprite = { image: null, tw, w: tw + pad * 2, h: size * 2 + pad * 2, x: pad + tw / 2, y: pad + size };
  const [canvas, g] = tw > 0 ? newCanvas(sprite.w * DPR, sprite.h * DPR) : [];
  if (g) {
    g.scale(DPR, DPR);
    g.font = font;
    g.textAlign = 'center';
    g.lineJoin = 'round';
    paint(g, sprite.x, sprite.y);
    sprite.image = canvas;
    textPixels += canvas.width * canvas.height;
  }
  texts.set(key, sprite);
  return sprite;
}

// Stamps a text sprite k times its size with its baseline centred on (x, y).
function stamp(sprite, x, y, k) {
  if (sprite.image)
    ctx.drawImage(sprite.image, x - sprite.x * k, y - sprite.y * k, sprite.w * k, sprite.h * k);
}

// Sticker text: cast shadow, white die-cut border, ink line, colour fill and, for the big words, a misregistered
// second ink like a cheap two-colour print. Stamped on the origin (its middle there if `middle`). `settled` is the
// size it comes to rest at while `size` pops, so one sprite serves the whole pop.
const TWO_INKS = { second: '#3fd0c9' };
const KO_INKS = { second: '#3fd0c9', border: 0.2, middle: true };
function stickerText(text, size, fill, style = {}, settled = size) {
  const printed = Math.ceil(settled / 6) * 6;
  const border = style.border || 0.26;
  const key = `${text}|${printed}|${fill}|${style.second}|${border}|${DPR}`;
  const pad = printed * (border / 2 + 0.1) + 2;
  const sprite = textSprite(key, text, `${printed}px ${DISPLAY}`, printed, pad, (g, x, y) => {
    g.miterLimit = 2;
    g.lineWidth = printed * border;
    g.strokeStyle = 'rgba(43,35,64,.3)';
    g.strokeText(text, x + printed * 0.05, y + printed * 0.08);
    g.strokeStyle = '#ffffff';
    g.strokeText(text, x, y);
    g.lineWidth = Math.max(2, printed * 0.07);
    g.strokeStyle = INK;
    g.strokeText(text, x, y);
    if (style.second) {
      g.fillStyle = style.second;
      g.fillText(text, x - printed * 0.035, y + printed * 0.03);
    }
    g.fillStyle = fill;
    g.fillText(text, x, y);
  });
  stamp(sprite, 0, style.middle ? size * 0.35 : 0, size / printed);
}

// How big a sticker is as it slaps on, `t` seconds in: it grows from `from`, overshoots to 125% at `peak` seconds and
// has settled by `settle`.
function slapOn(t, from, peak, settle) {
  if (t < peak) return lerp(from, 1.25, t / peak);
  if (t < settle) return lerp(1.25, 1, (t - peak) / (settle - peak));
  return 1;
}

// Nameplates: each fighter's name in ink on a paper halo with a little pointer in their colour, stacked so a scrum
// stays readable, with the winner's crown. They fade back while a comic word is popping right next to them.
const TAG_PX = 19;
const TAG_HEIGHT = { pinwheel: 2.25, ember: 1.95, thorn: 1.8, volt: 1.8 }; // in body radii; hats and hair need more

function nameSprite(name) {
  const pad = Math.ceil(TAG_PX * 0.2);
  return textSprite(`${name}|tag|${DPR}`, name, `700 ${TAG_PX}px ${FONT}`, TAG_PX, pad, (g, x, y) => {
    g.lineWidth = TAG_PX * 0.36;
    g.strokeStyle = 'rgba(255,250,240,.95)';
    g.strokeText(name, x, y);
    g.fillStyle = INK;
    g.fillText(name, x, y);
  });
}

// True when a fighter is wholly outside the view.
function offView(p) {
  const x = sxOf(p.x);
  const y = syOf(p.y);
  const margin = p.R * V.z;
  return !(x > -margin && x < W + margin && y > -margin && y < H + margin);
}

// Where a pop text is on screen: it peels upward after 0.3 s.
const popTextY = (pt) => syOf(pt.y) - Math.max(0, pt.t - 0.3) * 40;

function drawNameTags(fighters, z) {
  const fontPx = clamp((15 * z) / 0.8, 12, 19);
  const scale = fontPx / TAG_PX;
  const tagH = fontPx * 1.35;
  const tags = [];
  for (const p of fighters) {
    if (p.heldBy || offView(p)) continue; // off-screen fighters get an edge bubble instead
    const headTop = p.y + dropOffset(p) - p.R * (TAG_HEIGHT[p.ch] || 1.35);
    const sprite = nameSprite(p.name);
    tags.push({ p, sprite, x: sxOf(p.x), y: syOf(headTop) - 14, w: sprite.tw * scale + fontPx * 0.5 });
  }
  // stack tags that would overlap, lowest first
  const rowH = tagH + 3;
  tags.sort((a, b) => b.y - a.y);
  for (let i = 0; i < tags.length; i++)
    for (let j = 0; j < i; j++) {
      const a = tags[i];
      const b = tags[j];
      if (Math.abs(a.x - b.x) < (a.w + b.w) / 2 + 2 && Math.abs(a.y - b.y) < rowH) a.y = b.y - rowH;
    }
  for (const tag of tags) tag.x = clamp(tag.x, tag.w / 2 + 6, W - tag.w / 2 - 6);
  // where comic words and pop texts are showing
  const words = impacts.filter((im) => im.word).map((im) => [sxOf(im.x) + im.wx, syOf(im.y) + im.wy]);
  for (const pt of popTexts) if (pt.t < 0.8) words.push([sxOf(pt.x), popTextY(pt)]);
  for (const { p, sprite, x, y } of tags) {
    const nearWord = words.some(([wx, wy]) => Math.abs(wx - x) < 110 && Math.abs(wy - y) < 50);
    ctx.globalAlpha = nearWord ? 0.35 : 1;
    put(fx('pointer', p.tag), x, y + tagH * 0.3);
    stamp(sprite, x, y, scale);
    if (p === G.lastWinner) put(fx('crown'), x, y - tagH * 0.8, fontPx * 0.05);
  }
  ctx.globalAlpha = 1;
}

// Floating combat text (TECH, combos, item names): a little tilted sticker that slaps on, holds, then peels upward.
function drawPopTexts(z) {
  for (const pt of popTexts) {
    if (pt.tilt === undefined || pt.t === 0) pt.tilt = vrand(-0.14, 0.14);
    const settled = clamp(22 * z, 15, 32) * (pt.size || 1);
    const end = pt.size > 1.3 ? 1.3 : 0.8; // big ones stay a little longer
    ctx.globalAlpha = pt.t > end - 0.25 ? 1 - (pt.t - end + 0.25) / 0.25 : 1;
    place(sxOf(pt.x), popTextY(pt), pt.tilt);
    const inks = pt.size >= 1.2 ? TWO_INKS : {};
    stickerText(pt.text, settled * slapOn(pt.t, 0.4, 0.08, 0.16), pt.color, inks, settled);
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

// Comic sound effects on the big hits.
function drawHitWords(z) {
  const settled = clamp(34 * z, 26, 54);
  for (const im of impacts) {
    if (!im.word) continue;
    const f = im.t / im.life;
    const grow = f < 0.25 ? lerp(0.4, 1.15, f / 0.25) : 1;
    ctx.globalAlpha = f > 0.7 ? 1 - (f - 0.7) / 0.3 : 1;
    place(sxOf(im.x) + im.wx, syOf(im.y) + im.wy, im.wr);
    stickerText(im.word, settled * grow, im.wc, TWO_INKS, settled);
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

// Star KOs: a tiny fighter tumbling away into the backdrop sky, then a four-point twinkle where it vanished.
function drawStarKOs() {
  for (const ko of koFx) {
    if (!ko.star) continue;
    const x0 = clamp(sxOf(ko.x), 80, W - 80);
    const x1 = clamp(x0 + ko.dir * W * 0.14, 60, W - 60);
    const f = Math.min(1, ko.t / 0.8);
    if (f < 1) {
      const o = { alt: altOf(ko.ch, ko.color), rot: ko.t * 14, shadow: false };
      drawBody(ko.ch, 'hurt', lerp(x0, x1, f), lerp(H * 0.16, H * 0.11, f), ko.dir, 30 * (1 - f) + 2, o);
    } else {
      const twinkle = Math.min(1, (ko.t - 0.8) / 0.5);
      put(fx('glint', CREAM), x1, H * 0.11, (42 / 20) * Math.sin(twinkle * Math.PI));
    }
  }
}

// The KO! sticker.
function drawKoStickers() {
  for (const ko of koFx) {
    // a star KO keeps the sky clear for the twinkle
    const settled = Math.min(W, H) * (ko.star ? 0.13 : 0.2);
    const size = settled * slapOn(ko.t, 0.3, 0.18, 0.3);
    const x = clamp(sxOf(ko.x), size * 1.1, W - size * 1.1);
    const y = ko.star ? H * 0.34 : clamp(syOf(ko.y), size * 0.8, H - size * 1.4);
    ctx.globalAlpha = ko.t > 0.9 ? 1 - (ko.t - 0.9) / 0.4 : 1;
    place(x, y, Math.sin(ko.x) * 0.15);
    stickerText('KO!', size, ko.color, KO_INKS, settled);
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

// Where the QR card sits, to keep bubbles clear of it. Reading an element's position makes the browser lay the page
// out, so it's only asked when a bubble is on screen, and then at most twice a second.
const joinEl = document.querySelector('#join');
const joinBox = { r: null, t: -1 };
function joinRect(t) {
  if (t - joinBox.t > 0.5 || t < joinBox.t) {
    joinBox.t = t;
    joinBox.r = joinEl ? joinEl.getBoundingClientRect() : null;
  }
  return joinBox.r;
}

// Fighters outside the view show up in a bubble on the nearest edge, with an arrow pointing at them.
function drawBubbles(fighters, t) {
  const top = 70;
  const bottom = H - 130;
  const side = 60;
  const bubbles = [];
  for (const p of fighters) {
    if (p.heldBy || !offView(p)) continue;
    const x = sxOf(p.x);
    const y = syOf(p.y);
    const card = joinRect(t);
    let bx = clamp(x, side, W - side);
    let by = clamp(y, top, bottom);
    if (card && card.width && bx < card.right + 50 && by < card.bottom + 50) {
      if (x < 0) by = Math.max(by, card.bottom + 52);
      else bx = Math.max(bx, card.right + 52);
    }
    const r = clamp(48 - Math.hypot(x - bx, y - by) * 0.03, 32, 48); // smaller the farther off they are
    bubbles.push({ p, x, y, bx, by, r, onSide: x < 0 || x > W });
  }
  // spread out bubbles that land on top of each other, sliding them along their edge
  for (let pass = 0; pass < 6; pass++)
    for (let i = 0; i < bubbles.length; i++)
      for (let j = i + 1; j < bubbles.length; j++) {
        const a = bubbles[i];
        const b = bubbles[j];
        const need = a.r + b.r + 8;
        if (Math.hypot(a.bx - b.bx, a.by - b.by) >= need) continue;
        if (a.onSide && b.onSide) {
          const push = (need - Math.abs(a.by - b.by)) / 2;
          const away = a.by <= b.by ? -1 : 1;
          a.by = clamp(a.by + away * push, top, bottom);
          b.by = clamp(b.by - away * push, top, bottom);
        } else {
          const push = (need - Math.abs(a.bx - b.bx)) / 2;
          const away = a.bx <= b.bx ? -1 : 1;
          a.bx = clamp(a.bx + away * push, side, W - side);
          b.bx = clamp(b.bx - away * push, side, W - side);
        }
      }
  for (const { p, x, y, bx, by, r } of bubbles) {
    const scale = r / 48;
    // the arrow pointing at them, then the paper disc with the fighter clipped inside
    place(bx, by, Math.atan2(y - by, x - bx), scale);
    put(fx('bubble.arrow', p.tag));
    ctx.restore();
    ctx.globalAlpha = 0.88;
    put(fx('disc'), bx, by, r / 32);
    ctx.globalAlpha = 1;
    ctx.save();
    ctx.beginPath();
    ctx.arc(bx, by, r, 0, TAU);
    ctx.clip();
    const pose = p.hitstun > 0 ? 'hurt' : 'ready';
    drawBody(p.ch, pose, bx, by + r * 0.1, p.face, r * 0.52, { alt: altOf(p.ch, p.color) });
    ctx.restore();
    put(fx('bubble.ring', p.tag), bx, by, scale);
    put(fx('bubble.ink'), bx, by, scale);
  }
}
