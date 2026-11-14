// The tests. They run the real big-screen game headless, with a stand-in browser and a fake clock.
//
//   node test.js                    everything: a syntax check, the replay check and every run in RUNS, side by side
//   node test.js 4 240 7 [flags]    one run: 4 CPUs, 240 seconds, seed 7
//
// A run prints match lengths, KO stats and a NaN check. The same seed plays the same matches, blow for blow, so the
// output doubles as a regression test: a change that should only affect looks must leave it byte for byte the same.
//
// Flags:
//   phone    a fake phone player joins and readies up; checks the lobby and the results sent back to the phone
//   sudden   60 s limit and 5 lives, so matches go to sudden death
//   keys     keyboard mode: the select must not start on its own, Enter locks P1 in and starts, and after the results
//            everyone is back on the select screen, still locked in
//   pad      (0 CPUs) a fake Xbox controller plays the whole game: title, fighter select, a match, the pause menu,
//            the results, back to the title, then the phone lobby. Every step is checked.
//   moves    (0 CPUs) a phone player works through the moves against an idle phone: every stick direction gives its
//            own attack on the ground and in the air, pushing up jumps, hits link into combos, aerials chain
//   stage=ID, hazards, set=KEY:VALUE,...  pick the stage, check the stage events, override settings
// KO_JSON=1 also prints every KO as [fighter, selfDestruct] (for balance checks across seeds).
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, 'public');
if (process.argv.length === 2) process.exit(await runAll());

const [bots = 4, secs = 300, seed = 1] = process.argv.slice(2, 5).map(Number);
const flags = process.argv.slice(5);
const phone = flags.includes('phone');
const hazards = flags.includes('hazards');
const sudden = flags.includes('sudden');
const keys = flags.includes('keys');
const padFlag = flags.includes('pad');
const movesFlag = flags.includes('moves');
const stageFlag = flags.find((f) => f.startsWith('stage='));

// set=KEY:VALUE,KEY:VALUE overrides host settings, e.g. set=items:false,bots:hard
function parseSetting(text) {
  if (text === 'true') return true;
  if (text === 'false') return false;
  return isNaN(text) ? text : Number(text);
}
const setFlag = flags.find((f) => f.startsWith('set=')) || 'set=';
const settings = {};
for (const pair of setFlag.slice(4).split(',').filter(Boolean)) {
  const [key, value] = pair.split(':');
  settings[key] = parseSetting(value);
}
// defaults for some runs, unless set= says otherwise
if (flags.includes('moves') && settings.items === undefined) settings.items = false; // nothing falls in the practice room
if (sudden && settings.time === undefined) settings.time = 60;
if (sudden && settings.stocks === undefined) settings.stocks = 5;

// The browser, as far as the game needs one

const noop = () => {};
// A value that tolerates any property access or call: stands in for canvas contexts and audio nodes.
const any = () =>
  new Proxy(function () {}, {
    get: (t, k) => (k === Symbol.toPrimitive ? () => '' : any()),
    apply: () => any(),
    set: () => true,
  });
const el = () => ({
  getContext: () => null,
  toDataURL: () => '',
  classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
  style: { setProperty: noop },
  dataset: {},
  appendChild: noop,
  append: noop,
  children: [],
  firstChild: null,
  remove: noop,
  querySelector: () => el(),
  querySelectorAll: () => [],
  addEventListener: noop,
  getBoundingClientRect: () => ({ width: 0 }),
  set innerHTML(v) {},
  set textContent(v) {},
  offsetWidth: 0,
  width: 0,
  height: 0,
});
let rafCb = null;
let now = 0;
const g = globalThis;
g.window = g;
g.innerWidth = 1440;
g.innerHeight = 900;
g.devicePixelRatio = 1;
let search = padFlag ? `?seed=${seed}` : `?bots=${bots}&go&seed=${seed}`;
if (stageFlag) search += '&' + stageFlag;
if (keys) search += '&mode=keys';
g.location = { search, protocol: 'http:', host: 'x' };
// canvases draw into the void
const canvasEl = () => Object.assign(el(), { getContext: () => any() });
const canvas = canvasEl();
g.document = {
  querySelector: (s) => (s === '#cv' ? canvas : el()),
  querySelectorAll: () => [],
  createElement: (tag) => (tag === 'canvas' ? canvasEl() : el()),
  documentElement: { dataset: {}, style: { setProperty: noop } },
  body: { dataset: {} },
  addEventListener: noop,
  fonts: { ready: Promise.resolve() },
};
g.addEventListener = noop;
// The sprite sheets count as loaded at once, so all the drawing code runs every frame. A frame the code asks for that
// isn't in sprites.json fails the test.
g.Image = class {
  complete = true;
  naturalWidth = 1;
};
const missingFrames = new Set();
Object.defineProperty(g, 'performance', { value: { now: () => now }, configurable: true });
g.requestAnimationFrame = (cb) => {
  rafCb = cb;
};
// the relay: everything the game sends is kept, and the test speaks for the phones
const sent = [];
let sock = null;
g.WebSocket = function () {
  sock = this;
  this.readyState = 1;
  this.send = (m) => sent.push(JSON.parse(m));
};
const store = new Map([['ko-settings', JSON.stringify(settings)]]);
Object.defineProperty(g, 'localStorage', {
  value: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) },
  configurable: true,
});
g.fetch = async (url) => {
  if (!String(url).endsWith('sprites.json')) throw new Error('offline');
  const atlas = JSON.parse(fs.readFileSync(url, 'utf8'));
  for (const [id, set] of Object.entries(atlas))
    set.frames = new Proxy(set.frames, {
      get: (frames, name) => frames[name] ?? (missingFrames.add(`${id}/${String(name)}`), undefined),
    });
  return { json: async () => atlas };
};
g.setTimeout = noop;
// One controller in the standard layout, with nothing pressed. The test presses its buttons and leans its stick.
let padUnplugged = false; // the test pulls the controller out and plugs it back in
const pad = {
  index: 0,
  id: 'Test controller (STANDARD GAMEPAD)',
  mapping: 'standard',
  connected: true,
  axes: [0, 0, 0, 0],
  buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
};
if (padFlag) {
  Object.defineProperty(g, 'navigator', {
    value: { getGamepads: () => [padUnplugged ? null : pad] },
    configurable: true,
  });
}
g.clearTimeout = noop;
g.setInterval = noop;

await import(pathToFileURL(path.join(ROOT, 'main.js')).href);

const K = window.__ko;
const fails = [];
const says = (id, m) => sock.onmessage({ data: JSON.stringify({ id, ...m }) });
const phoneSays = (m) => says('p-test', m);
const FPS = 60;
const at = (seconds) => seconds * FPS; // the frame that many seconds in

if (phone) {
  K.G.lobbyT = null; // undo ?go: the phone has to ready up
  phoneSays({ t: 'join', name: 'Tester', ch: 'mochi' });
}
if (keys && (K.G.mode !== 'keys' || !K.players.has('kb-wasd'))) {
  fails.push('keyboard mode did not open with P1 on the select screen');
}

// The checks each flag adds, run after every frame

let keysStarted = false;
let keysBack = false;
let p2Late = false;
function checkKeys(frame) {
  if (frame === at(39)) {
    // P2 joins on the arrows, locks in, unlocks and leaves again
    K.frontKey('ArrowLeft');
    if (!K.players.has('kb-arrows')) fails.push('an arrow key did not bring P2 in');
    K.frontKey('KeyK');
    if (!K.players.get('kb-arrows')?.ready) fails.push('K did not lock P2 in');
    K.frontKey('KeyL');
    K.frontKey('KeyL');
    if (K.players.has('kb-arrows')) fails.push('L twice did not take P2 out');
  }
  if (keysStarted && !p2Late && K.G.state === 'play' && K.G.stT > 5) {
    // a second player can still drop in mid-match
    p2Late = true;
    K.frontKey('ArrowRight');
    const p2 = K.players.get('kb-arrows');
    if (!p2) fails.push('P2 could not join mid-match');
    else if (p2.inMatch) fails.push('P2 joined a match already under way');
  }
  if (frame === at(40)) {
    // longer than the phone lobby's 30 s wait
    if (K.G.state !== 'lobby') {
      fails.push(`the keyboard select started a match on its own (state ${K.G.state})`);
    }
    K.frontKey('Enter'); // P1 locks in
    if (!K.players.get('kb-wasd').ready) fails.push('Enter did not lock P1 in');
    K.frontKey('Enter'); // and fights
    if (K.G.state !== 'countdown') fails.push(`Enter did not start the match (state ${K.G.state})`);
    else keysStarted = true;
  }
  if (keysStarted && !keysBack && K.matchLog.length && K.G.state === 'lobby') {
    keysBack = true;
    if (!K.players.get('kb-wasd').ready) fails.push('P1 was not still locked in after the results');
    if (K.players.get('kb-arrows')?.ready !== false) {
      fails.push('P2, who joined mid-match, did not get to pick a fighter');
    }
  }
}

// The controller walkthrough: a list of steps, taken one after another.
//   press: a button goes down for `frames` frames (2 unless given), then up
//   stick: the stick leans to [x, y] for `frames` frames, then centres
//   key: a keyboard key, for the second player
//   wait: frames go by until the condition holds (fails after `max` seconds)
//   check: the condition must hold now
// The first failure stops the walkthrough: everything after it would fail too.
const BUTTON = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, VIEW: 8, START: 9 };
const me = () => K.players.get('pad-0');
const p1 = () => K.players.get('kb-wasd');
const cpuCount = () => [...K.players.values()].filter((p) => p.bot).length;
const onSelect = () => K.G.mode === 'keys' && K.G.state === 'lobby' && !K.G.paused;
const settled = () => !!me() && freeToAttack(me());
// A button that closes the menu must stay out of the fight until it is let go.
let menuJustClosed = false;
let padLeaked = false;
function watchForLeaks() {
  const anyDown = pad.buttons.some((b) => b.pressed);
  if (K.G.paused) menuJustClosed = true;
  else if (!anyDown) menuJustClosed = false;
  else if (menuJustClosed && me() && me().in.b) padLeaked = true;
}
let fighterBefore = null;
let padGoneFor = 0;
let stageBefore = '';
let xBefore = 0;
const press = (name, frames) => ({ press: BUTTON[name], frames });
const lean = (x, y, frames) => ({ stick: [x, y], frames });
const check = (msg, ok) => ({ check: ok, msg });
const wait = (msg, ok, max = 20) => ({ wait: ok, msg, max });
const padPlan = [
  // title: the first press of A is also the press that starts controller play
  check('the game did not open on the title', () => K.G.mode === null),
  press('A'),
  check('A on the title did not open the fighter select', onSelect),
  check('the controller was not seated on the select', () => !!me() && !me().ready),
  check('the keyboard seat was not given up to the controller', () => !K.players.has('kb-wasd')),
  check('nobody to fight on the select', () => cpuCount() === 1),

  // CPUs in and out, the stage back and forth
  press('Y'),
  press('Y'),
  check('Y did not add CPUs', () => cpuCount() === 3),
  press('X'),
  check('X did not remove a CPU', () => cpuCount() === 2),
  { run: () => (stageBefore = K.G.stageId) },
  press('RB'),
  check('RB did not change the stage', () => K.G.stageId !== stageBefore),
  press('LB'),
  check('LB did not change the stage back', () => K.G.stageId === stageBefore),

  // choosing, locking in, backing out, coming back
  { run: () => (stageBefore = me().ch) },
  lean(1, 0),
  check('the stick did not move the cursor', () => me().ch !== stageBefore),
  { key: 'KeyD' },
  check('the keyboard could not join a controller', () => K.players.has('kb-wasd')),
  check('a second player joining took the chosen CPUs away', () => cpuCount() === 2),
  press('A'),
  check('A did not lock the fighter in', () => me().ready),
  press('B'),
  check('B did not unlock the fighter', () => !!me() && !me().ready),
  press('B'),
  check('B a second time did not take the controller out', () => !me()),
  press('B'),
  check('B brought the controller back in (only A, X, Y and Start should)', () => !me()),
  press('A'),
  check('A did not bring the controller back in', () => !!me()),
  { key: 'KeyG' },
  check('the keyboard player could not leave', () => !K.players.has('kb-wasd')),
  press('X'),
  press('X'),
  check('X did not remove the last CPUs', () => cpuCount() === 0),
  press('START'),
  check('a match started with one fighter', onSelect),

  // alone: B goes back to the title, and A comes straight back
  press('B'),
  check('B did not unlock after Start locked in', () => !!me() && !me().ready),
  press('B'),
  check('B from a lone controller did not go back to the title', () => K.G.mode === null && !K.players.size),
  press('A'),
  check('A on the title did not come back to the select', () => onSelect() && !!me() && cpuCount() === 1),

  // Lock in and fight. The opponent is the keyboard's P1, who stands still: a CPU would get its hits in and make the
  // button checks below a matter of luck.
  { key: 'KeyD' },
  check('the stand-in CPU did not step aside for a second player', () => p1() && cpuCount() === 0),
  press('A'),
  press('START'),
  check('Start did not lock the keyboard player in', () => p1().ready && onSelect()),
  press('START'),
  check('Start did not start the match', () => K.G.state === 'countdown'),
  wait('the match never got going', () => K.G.state === 'play' && settled()),
  { run: () => (xBefore = me().x) },
  lean(1, 0, 20),
  check('the stick did not move the fighter', () => me().x > xBefore + 30),
  wait('the fighter never settled', settled),
  press('A', 6),
  check('A did not jump', () => !me().grounded),
  wait('the fighter never landed', settled),
  press('RT', 3),
  check('the right trigger did not attack', () => !!me().move),
  wait('the attack never ended', settled),
  press('LT', 3),
  check('the left trigger did not do the special', () => !!me().move),
  wait('the special never ended', settled),
  press('RB', 8),
  check('the right bumper did not shield', () => me().shielding || me().shieldAt >= K.G.clock - 0.3),

  // the controller blinks out mid-match with the stick held: the fighter must wait, standing still, and carry on
  wait('the fighter never settled before the drop-out', settled),
  { run: () => ((pad.axes[0] = 1), (fighterBefore = me())) },
  { wait: () => true },
  { run: () => (padUnplugged = true) },
  wait('(five seconds without the controller)', () => (padGoneFor += 1) > 5 * FPS, 10),
  check(
    'a controller dropping out mid-match took its fighter out',
    () => me() === fighterBefore && me().inMatch,
  ),
  check('a fighter kept running after its controller dropped out', () => me().in.x === 0 && me().in.b === 0),
  { run: () => ((padUnplugged = false), (pad.axes[0] = 0), (xBefore = me().x)) },
  lean(-1, 0, 20),
  check(
    'the fighter did not carry on when its controller came back',
    () => me() === fighterBefore && me().x < xBefore - 30,
  ),

  // pause: A on Resume closes the menu and must not also jump
  wait('the fighter never settled before pausing', settled),
  press('START'),
  check('Start did not pause', () => K.G.paused),
  press('A', 12),
  check('A did not resume', () => !K.G.paused),
  check('the A that closed the menu also jumped', () => !padLeaked),
  press('START'),
  press('B', 12),
  check('B did not close the menu', () => !K.G.paused),
  check('the B that closed the menu also did a special', () => !padLeaked),
  press('START'),
  lean(0, 1),
  press('A'),
  check('the stick and A could not end the match from the menu', () => K.G.state === 'result'),

  // results, and the select screen again
  wait('the results never let go', () => K.G.stT > 2.6),
  press('A'),
  check('A did not leave the results', onSelect),
  check('the controller was not still locked in after the results', () => me().ready),
  { key: 'KeyG' },
  { key: 'KeyG' },
  check('the keyboard player could not leave after the match', () => !p1()),
  check('the CPU did not come back for a lone controller', () => cpuCount() === 1),
  press('B'),
  press('B'),
  check('B B did not go back to the title after a match', () => K.G.mode === null),

  // the phone lobby: stick left picks phones, any button joins, Start opens the menu
  lean(-1, 0),
  press('A'),
  check('stick left and A did not open the phone lobby', () => K.G.mode === 'phones'),
  press('X'),
  check('a button did not bring the controller into the phone lobby', () => !!me()),
  press('START'),
  check('Start did not open the menu in the phone lobby', () => K.G.paused),
  lean(0, 1), // Stage -> Add a CPU
  press('A'),
  check('the menu could not add a CPU', () => cpuCount() === 1),
  lean(0, -1), // -> Stage
  lean(0, -1), // -> Start the match
  press('A'),
  check('the menu could not start the match', () => K.G.state === 'countdown' && !K.G.paused),
  wait('the phone-lobby match never got going', () => K.G.state === 'play'),
  press('START'),
  lean(0, 1),
  press('A'),
  check('the menu could not end the phone-lobby match', () => K.G.state === 'result'),
  wait('the phone lobby never came back', () => K.G.state === 'lobby', 40),
  press('START'),
  lean(0, 1), // Start the match -> Stage
  lean(0, 1), // -> Add a CPU
  lean(0, 1), // -> Remove a CPU
  press('A'),
  check('the menu could not remove the CPU', () => cpuCount() === 0),
  lean(0, 1), // the Remove row has gone and Add a CPU is selected -> Take Pad 1 out
  press('A'),
  check('the menu could not take the controller out', () => !me()),
  press('B'),
  check('B did not close the menu', () => !K.G.paused),

  // in the lobby a controller that stays gone gives its seat up after a few seconds
  press('A'),
  check('a button did not bring the controller back into the phone lobby', () => !!me()),
  { run: () => ((padUnplugged = true), (padGoneFor = 0)) },
  wait('(a second without the controller)', () => (padGoneFor += 1) > FPS, 5),
  check('a lobby seat was given up the moment its controller blinked', () => !!me()),
  wait('a controller that stayed gone kept its lobby seat', () => !me(), 5),
  { run: () => (padUnplugged = false) },
  press('A'),
  check('the controller could not come back after dropping out of the lobby', () => !!me()),
];
let padAt = 0;
let padT = 0;
function checkPad() {
  watchForLeaks();
  const step = padPlan[padAt];
  if (!step) return;
  const next = () => {
    padAt++;
    padT = 0;
  };
  const fail = (msg) => {
    fails.push(`controller: ${msg} (step ${padAt + 1} of ${padPlan.length})`);
    padAt = padPlan.length;
  };
  padT++;
  const holdFor = step.frames || 2;
  if (step.press !== undefined) {
    const down = padT <= holdFor;
    pad.buttons[step.press] = { pressed: down, value: down ? 1 : 0 };
    if (padT >= holdFor + 2) next();
  } else if (step.stick) {
    pad.axes[0] = padT <= holdFor ? step.stick[0] : 0;
    pad.axes[1] = padT <= holdFor ? step.stick[1] : 0;
    if (padT >= holdFor + 2) next();
  } else if (step.key) {
    K.frontKey(step.key);
    next();
  } else if (step.run) {
    step.run();
    next();
  } else if (step.wait) {
    if (step.wait()) next();
    else if (padT > step.max * FPS) fail(step.msg);
  } else if (step.check()) next();
  else fail(step.msg);
}

// The moves, played by a phone. Written as a script that yields once per frame.
const { N } = await import(pathToFileURL(path.join(ROOT, 'game.js')).href);
const ATTACK = 1;
const JUMP = 4;
const tester = () => K.players.get('p-test');
const dummy = () => K.players.get('p-dummy');
const stick = (x, y, buttons = 0) => phoneSays({ t: 'i', x, y, b: buttons });
const nameOf = (def) => (def && def.name) || 'none';
const doing = () => nameOf(tester().move && tester().move.def);
function* frames(count) {
  for (let i = 0; i < count; i++) yield;
}
// Waits until the condition holds; says so and gives up after `max` frames.
function* until(ok, max, msg) {
  for (let i = 0; i < max; i++) {
    if (ok()) return true;
    yield;
  }
  fails.push(`moves: ${msg}`);
  return false;
}
// Stands both fighters on the main platform, fresh: the tester `gap` to the left of the dummy, facing it.
function place(gap, pct = 0) {
  const main = K.G.stage.main;
  const fresh = {
    vx: 0,
    vy: 0,
    kvx: 0,
    kvy: 0,
    hitstun: 0,
    freeze: 0,
    lag: 0,
    move: null,
    grounded: true,
    plat: main,
    combo: 0,
    comboDmg: 0,
    invuln: 0,
    hover: 0,
    face: 1,
    dodgeT: 0,
    dashT: 0,
    squat: 0,
    helpless: false,
    shielding: false,
    ledge: null,
    stunImm: 0,
    bufA: 0,
    bufS: 0,
    bufJ: 0,
    pct,
  };
  for (const [p, x] of [
    [tester(), -gap],
    [dummy(), 0],
  ]) {
    Object.assign(p, fresh, { x, y: main.y - p.R, airJumps: p.c.airJumps });
  }
  stick(0, 0);
}
const FAR = 420; // too far apart to hit: for checking which move comes out
function* tap(x, y, buttons, hold = 2) {
  stick(x, y, buttons);
  yield* frames(hold);
  stick(x, y, 0);
}
// One move check: stand apart, do `input` (a script), and the named move must come out.
function* expectMove(name, input, what) {
  place(FAR);
  yield* frames(2);
  yield* input();
  yield* until(() => doing() === name, 12, `${what} gave ${doing()}, not ${name}`);
  stick(0, 0);
  yield* frames(50);
}
function* jumpThen(x, y) {
  yield* tap(0, 0, JUMP, 12);
  stick(x, y, 0);
  yield;
  yield* tap(x, y, ATTACK);
}
// The highest the tester gets in the next second, in pixels above where it stood.
function* peakHeight() {
  const floor = tester().y;
  let top = floor;
  for (let i = 0; i < 60; i++) {
    top = Math.min(top, tester().y);
    yield;
  }
  return floor - top;
}

function* movesScript() {
  phoneSays({ t: 'join', name: 'Tester', ch: 'mochi' });
  says('p-dummy', { t: 'join', name: 'Dummy', ch: 'mochi' });
  yield* until(
    () => freeToAttack(tester()) && freeToAttack(dummy()),
    300,
    'the two phones never got to stand in the lobby',
  );

  // every direction has its own attack, on the ground and in the air
  yield* expectMove('jab1', () => tap(0, 0, ATTACK), 'Attack with the stick at rest');
  yield* expectMove('gu', () => tap(0, -1, ATTACK), 'Attack with the stick up');
  if (!tester().grounded && !fails.length)
    fails.push('moves: Attack with the stick up jumped instead of attacking');
  yield* expectMove('gd', () => tap(0, 1, ATTACK), 'Attack with the stick down');
  yield* expectMove(
    'gs',
    function* () {
      stick(1, 0);
      yield* frames(24);
      yield* tap(1, 0, ATTACK);
    },
    'Attack while running',
  );
  yield* expectMove('da', () => tap(1, 0, ATTACK), 'Attack on a flick of the stick');
  // a thumb takes a few frames to cross the glass: that still has to count as a flick
  yield* expectMove(
    'da',
    function* () {
      stick(0.3, 0);
      yield;
      stick(0.6, 0);
      yield;
      yield* tap(1, 0, ATTACK);
    },
    'Attack on a slower flick',
  );
  yield* expectMove('an', () => jumpThen(0, 0), 'Attack in the air');
  yield* expectMove('as', () => jumpThen(1, 0), 'Attack in the air with the stick sideways');
  yield* expectMove('ad', () => jumpThen(0, 1), 'Attack in the air with the stick down');
  yield* expectMove('au', () => jumpThen(0, -1), 'Attack in the air with the stick up');

  // aiming up in the air must not spend the air jump, even when the stick gets there a moment before the button
  place(FAR);
  yield* tap(0, 0, JUMP, 12);
  yield* frames(4);
  stick(0, -1);
  yield* frames(2);
  yield* tap(0, -1, ATTACK);
  yield* until(() => doing() === 'au', 12, `stick up then Attack in the air gave ${doing()}, not au`);
  yield* frames(12);
  if (tester().airJumps !== tester().c.airJumps)
    fails.push('moves: aiming an up attack in the air spent the air jump');
  stick(0, 0);
  yield* frames(50);

  // pushing the stick up jumps: a part push that is mostly up counts, a quick flick is a full jump, and a second
  // push in the air is the air jump
  place(FAR);
  yield* frames(2);
  stick(0.2, -0.5);
  yield* until(() => !tester().grounded, 10, 'a part push of the stick, mostly up, did not jump');
  stick(0, 0);
  yield* frames(60);
  place(FAR);
  yield* frames(2);
  stick(0, 0, JUMP);
  const held = yield* peakHeight();
  stick(0, 0);
  yield* frames(20);
  place(FAR);
  yield* frames(2);
  stick(0, -1);
  yield* frames(3);
  stick(0, 0);
  const flicked = yield* peakHeight();
  if (flicked < held * 0.95) {
    fails.push(
      `moves: a flick up on the phone jumped ${flicked.toFixed(0)} px, a held Jump ${held.toFixed(0)} px`,
    );
  }
  yield* frames(20);
  place(FAR);
  yield* frames(2);
  stick(0, -1);
  yield* frames(14);
  stick(0, 0);
  yield* frames(3);
  stick(0, -1);
  yield* until(() => tester().airJumps === 0, 12, 'a second push up in the air was not the air jump');
  stick(0, 0);
  yield* frames(70);

  // a missed aerial goes into a different aerial well before its own recovery is over
  place(FAR);
  yield* tap(0, 0, JUMP, 12);
  yield* tap(0, 0, ATTACK);
  yield* until(() => doing() === 'an', 6, 'the first aerial of a pair did not start');
  const started = K.G.clock;
  yield* frames(6);
  yield* until(
    () => {
      stick(1, 0, tester().move && tester().move.phase === 'recovery' ? ATTACK : 0);
      return doing() === 'as';
    },
    40,
    'a second aerial never followed the first',
  );
  const whole = N.an.st + N.an.ac + N.an.rc;
  if (K.G.clock - started > whole - N.an.rc * 0.4) {
    fails.push(
      `moves: the second aerial waited ${(K.G.clock - started).toFixed(2)} s, the first one's whole ${whole} s`,
    );
  }
  stick(0, 0);
  yield* frames(60);

  // hits link: jab, jab, up attack, jump, an air attack, each pressed as the one before lands; then an air jump and a
  // side air, which reaches if the opponent hasn't been sent too far. (A fresh opponent barely leaves the ground, so
  // the first air hit is the all-round one; a hurt one flies higher.)
  for (const [pct, hitsWanted] of [
    [0, 4],
    [40, 5],
    [80, 4],
  ]) {
    place(70, pct);
    yield* frames(2);
    let best = 0;
    const watch = () => (best = Math.max(best, dummy().combo));
    const landed = (name) => () => (watch(), doing() === name && tester().move.landed);
    // steering toward the dummy all the while, as a player would
    const toward = () => (tester().x < dummy().x ? 1 : -1);
    const string = [
      ['jab1', () => tap(0, 0, ATTACK)],
      ['jab2', () => tap(0, 0, ATTACK)],
      ['gu', () => tap(0, -1, ATTACK)],
      [null, () => tap(toward() * 0.6, -0.8, JUMP, 6)],
      pct ? ['au', () => tap(toward() * 0.6, -0.8, ATTACK)] : ['an', () => tap(toward() * 0.3, 0, ATTACK)],
      [null, () => tap(toward() * 0.6, -0.8, JUMP, 6)],
      ['as', () => tap(toward(), 0, ATTACK)],
    ];
    for (const [name, input] of string) {
      yield* input();
      if (!name) continue;
      for (let i = 0; i < 30 && !landed(name)(); i++) yield;
      if (!landed(name)()) break;
    }
    for (let i = 0; i < 20; i++) {
      watch();
      yield;
    }
    if (best < hitsWanted) {
      fails.push(
        `moves: at ${pct}%, the string counted ${best} hits (got as far as ${doing()}), not ${hitsWanted}`,
      );
    }
    stick(0, 0);
    yield* frames(90);
  }

  // the same move again does not link: mashing one button is not a combo
  place(70);
  yield* frames(2);
  yield* tap(0, -1, ATTACK);
  yield* until(() => doing() === 'gu' && tester().move.landed, 30, 'the up attack did not land');
  const first = tester().move;
  yield* tap(0, -1, ATTACK);
  yield* frames(4);
  if (tester().move !== first && doing() === 'gu') fails.push('moves: the same attack linked into itself');
  // a shielded hit gives no link
  yield* frames(60);
  place(70);
  says('p-dummy', { t: 'i', x: 0, y: 0, b: 8 });
  yield* frames(20);
  yield* tap(0, 0, ATTACK);
  yield* frames(5);
  if (tester().move && tester().move.landed) fails.push('moves: a shielded hit counted as landed');
  says('p-dummy', { t: 'i', x: 0, y: 0, b: 0 });
  movesDone = true;
}
let movesDone = false;
const movesRun = movesFlag ? movesScript() : null;
function checkMoves() {
  K.G.lobbyT = null; // stay in the lobby: it is the practice room
  if (!movesDone && movesRun.next().done && !movesDone) fails.push('moves: the script stopped early');
}

// Standing still on the ground with nothing going on: an attack pressed now is certain to come out.
function freeToAttack(p) {
  const busy = p.hover > 0 || p.move || p.freeze > 0 || p.hitstun > 0 || p.ledge || p.heldBy || p.shielding;
  return p.alive && p.grounded && !busy;
}

let readyAt = null;
let tapAt = null;
let tapDone = false;
let pushAt = null;
let pushDone = false;
function checkPhone(frame) {
  // a quick tap whose press and release arrive between two ticks must still attack (the press is latched)
  if (!tapDone && tapAt !== null && frame === tapAt + 1) {
    tapDone = true;
    if (!K.players.get('p-test').move) fails.push('a tap pressed and released between two ticks was lost');
  }
  if (tapAt === null && frame > 90 && K.G.state === 'lobby') {
    const tester = K.players.get('p-test');
    if (tester && freeToAttack(tester)) {
      phoneSays({ t: 'i', x: 0, y: 0, b: 1 });
      phoneSays({ t: 'i', x: 0, y: 0, b: 0 });
      tapAt = frame;
    }
  }
  // easing the stick up, nowhere near a flick, must still jump: phones have no Up key to press
  if (pushAt === null && frame >= at(3) && K.G.state === 'lobby') {
    const tester = K.players.get('p-test');
    if (tester && tester.grounded && freeToAttack(tester)) pushAt = frame;
  }
  if (pushAt !== null && !pushDone) {
    const step = frame - pushAt;
    if (step < 5) phoneSays({ t: 'i', x: 0, y: -0.2 * (step + 1), b: 0 });
    if (step === 14) {
      pushDone = true;
      if (K.players.get('p-test').grounded) fails.push('easing the phone stick up did not jump');
      phoneSays({ t: 'i', x: 0, y: 0, b: 0 });
    }
  }
  if (frame === at(5)) {
    if (!tapDone) fails.push('the quick-tap check never ran');
    if (!pushDone) fails.push('the push-up-to-jump check never ran');
    if (K.G.state !== 'lobby') fails.push(`lobby did not wait for the phone (state ${K.G.state})`);
    phoneSays({ t: 'ready', on: true });
    readyAt = frame;
  }
  if (readyAt !== null && K.G.state === 'countdown') {
    // 3.5 s of game time; a warm-up KO's slow-motion can stretch that a little, but never toward the 30 s wait
    if ((frame - readyAt) / FPS > 6) fails.push('ready-up did not shorten the lobby');
    readyAt = null;
  }
}

// How long each combo in a match ran: a fighter's hit count is read every frame and written down when it ends.
const comboLengths = [];
const comboNow = new Map();
function countCombos() {
  for (const p of K.players.values()) {
    const before = comboNow.get(p.id) || 0;
    if (p.combo < before && K.G.state === 'play') comboLengths.push(before);
    comboNow.set(p.id, p.combo);
  }
}

// Run

for (let frame = 0; frame < secs * FPS; frame++) {
  now += 1000 / FPS;
  const cb = rafCb;
  rafCb = null;
  cb(now);
  countCombos();
  if (keys) checkKeys(frame);
  if (phone) checkPhone(frame);
  if (padFlag) checkPad();
  if (movesFlag) checkMoves();
}

// Report

const average = (list, value) => (list.reduce((sum, x) => sum + value(x), 0) / (list.length || 1)).toFixed(0);
const tally = (list, key) => {
  const counts = {};
  for (const x of list) counts[key(x)] = (counts[key(x)] || 0) + 1;
  return counts;
};
const everyone = [...K.players.values()];
const matches = K.matchLog;
const kos = K.koLog;
const lost = everyone.filter((p) => ![p.x, p.y, p.vx, p.vy, p.pct].every(Number.isFinite)).length;

console.log(
  `${bots} bots: ${matches.length} matches, lengths=${matches.map((m) => m.t).join(' ')}` +
    ` avg=${average(matches, (m) => m.t)} wins=${JSON.stringify(tally(matches, (m) => m.w))} NaN=${lost}`,
);
console.log(
  `   KOs=${kos.length} avgPct=${average(kos, (ko) => ko.pct)} self=${kos.filter((ko) => ko.self).length}` +
    ` bySide=${JSON.stringify(tally(kos, (ko) => ko.side))} events=${Object.keys(K.dbg).join(',')}` +
    ` rolls=${K.dbg.rolls || 0} rollHits=${K.dbg.rollHits || 0}`,
);
const combosOf = (hits) => comboLengths.filter((n) => n >= hits).length;
console.log(
  `   combos: ${combosOf(2)} of 2+ hits, ${combosOf(3)} of 3+, ${combosOf(4)} of 4+, ${combosOf(5)} of 5+,` +
    ` longest ${Math.max(0, ...comboLengths)}, from ${comboLengths.length} openings`,
);
if (process.env.KO_JSON) console.log('KOJSON ' + JSON.stringify(kos.map((ko) => [ko.ch, ko.self ? 1 : 0])));

if (phone) {
  const cards = sent.filter((m) => m.t === 'to' && m.id === 'p-test' && m.m.t === 'res').map((m) => m.m);
  if (!cards.length && matches.length) fails.push('phone got no results card');
  for (const card of cards) {
    const numbers = [card.place, card.of, card.kos, card.falls, card.dmg, card.combo];
    if (!numbers.every(Number.isFinite) || card.place < 1 || card.place > card.of) {
      fails.push(`bad results card ${JSON.stringify(card)}`);
    }
  }
  if (cards.length) {
    console.log(`   phone: ${cards.length} results cards, last ${JSON.stringify(cards.at(-1))}`);
  }
}
if (hazards) {
  // stage events must fire, roll, and actually hit someone over a few minutes on a rolling stage
  if (!K.dbg.rolls) fails.push('no rolling hazard ever started');
  else if (!K.dbg.rollHits) fails.push('rolling hazards never hit anyone');
  if (K.hazard && K.hazard.ev && K.G.state !== 'play') fails.push('a hazard outlived its match');
}
if (keys && !keysBack) fails.push('the keyboard match never came back to the select screen');
if (padFlag) {
  if (padAt < padPlan.length) fails.push(`controller: the walkthrough stopped at step ${padAt + 1}`);
  else if (!fails.length) console.log(`   controller: all ${padPlan.length} steps passed`);
}
if (movesFlag) {
  if (!movesDone) fails.push('moves: the script did not finish in time');
  else if (!fails.length)
    console.log('   moves: every direction, the phone jump, links and aerial strings all pass');
}
// 60 s limit with 5 lives: every match should reach it
if (sudden && !K.dbg.sudden) fails.push('sudden death never started');
const brokenStats = everyone.filter((p) => !Object.values(p.stats).every(Number.isFinite)).length;
if (brokenStats) fails.push(`${brokenStats} players with broken stats`);
if (lost) fails.push('NaN positions');
if (missingFrames.size) fails.push(`frames missing from sprites.json: ${[...missingFrames].join(' ')}`);
else if (secs >= 120 && !matches.length && !movesFlag) fails.push('no matches finished');

if (fails.length) {
  console.error('FAIL: ' + fails.join('; '));
  process.exit(1);
}

// Everything at once

// Each run is a separate process: the game keeps its state in module globals.
async function runAll() {
  // prettier-ignore
  const RUNS = [
    '4 240 7', '2 240 3 phone', '8 200 5', '3 150 2 stage=peaks', '4 300 9 stage=mesa hazards', '6 200 4 sudden',
    '1 200 6 keys', '0 120 5 pad', '0 70 1 moves',
  ];
  const REPLAY = '5 150 21 stage=peaks'; // run twice: it must play out exactly the same both times
  const me = fileURLToPath(import.meta.url);
  const run = (args) =>
    new Promise((done) =>
      execFile(process.execPath, [me, ...args.split(' ')], (error, out, err) =>
        done({ ok: !error, text: out + err }),
      ),
    );

  let failed = 0;
  // the phone and the server aren't loaded by the runs, so at least check they parse
  for (const file of ['server.js', 'public/phone.js']) {
    try {
      execFileSync(process.execPath, ['--check', path.join(HERE, file)], { stdio: 'pipe' });
    } catch (e) {
      failed++;
      console.error(`syntax error in ${file}\n${e.stderr}`);
    }
  }
  const [first, second, ...results] = await Promise.all([run(REPLAY), run(REPLAY), ...RUNS.map(run)]);
  if (first.text === second.text) console.log('replay ok: same seed, same matches');
  else {
    failed++;
    console.error(`FAIL: same seed, different matches\n--- first\n${first.text}--- second\n${second.text}`);
  }
  for (const r of results) {
    process.stdout.write(r.text);
    if (!r.ok) failed++;
  }
  return failed ? 1 : 0;
}
