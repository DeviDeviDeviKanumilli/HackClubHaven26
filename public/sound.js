// Sound effects, the soundtrack and controller rumble. Everything is synthesised (there are no audio files) and goes
// through a small mixing desk: music and effects buses, a reverb send, ducking and a master compressor. Audio starts
// on the first key or click.
import { G, SETTINGS, shakeK } from './game.js';

export let ac = null;
const bus = {}; // master, music, duck, fx, verb
let noiseBuf = null;
let lastHit = 0;
let lastStep = 0;

// Builds the mixing desk once the browser lets us make sound.
function build() {
  const comp = ac.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.knee.value = 10;
  comp.ratio.value = 4;
  comp.attack.value = 0.004;
  comp.release.value = 0.2;
  bus.master = ac.createGain();
  bus.master.gain.value = 0.9;
  bus.master.connect(comp).connect(ac.destination);
  // the music goes through `duck`, which dips it under big moments
  bus.duck = ac.createGain();
  bus.duck.connect(bus.master);
  bus.music = ac.createGain();
  bus.music.connect(bus.duck);
  bus.fx = ac.createGain();
  bus.fx.connect(bus.master);
  // a small, warm room: a generated impulse response (decaying stereo noise, darker as it fades)
  bus.verb = ac.createConvolver();
  const length = Math.floor(ac.sampleRate * 2.2);
  const impulse = ac.createBuffer(2, length, ac.sampleRate);
  for (let channel = 0; channel < 2; channel++) {
    const samples = impulse.getChannelData(channel);
    let smoothed = 0;
    for (let i = 0; i < length; i++) {
      const progress = i / length;
      smoothed += (Math.random() * 2 - 1 - smoothed) * (0.6 - progress * 0.5);
      samples[i] = smoothed * Math.pow(1 - progress, 3.2);
    }
  }
  bus.verb.buffer = impulse;
  const reverbLevel = ac.createGain();
  reverbLevel.gain.value = 0.32;
  bus.verb.connect(reverbLevel).connect(bus.master);

  // one second of white noise, the raw material for every hiss, thump and crackle
  noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
  const white = noiseBuf.getChannelData(0);
  for (let i = 0; i < white.length; i++) white[i] = Math.random() * 2 - 1;
  setVolumes();
}

// Starts (or resumes) sound. Browsers only allow this from a key press or click.
export function wake() {
  if (G.moved) return; // another tab is the big screen
  if (!ac) {
    try {
      ac = new (window.AudioContext || window.webkitAudioContext)();
      build();
    } catch {
      ac = null;
      return;
    }
  }
  if (ac.state === 'suspended') ac.resume();
}

export const live = () => !!ac && ac.state === 'running';

export function setVolumes() {
  if (!ac) return;
  const t = ac.currentTime;
  const mute = G.muted ? 0 : 1;
  bus.music.gain.setTargetAtTime(SETTINGS.music * 0.9 * mute, t, 0.05);
  bus.fx.gain.setTargetAtTime(SETTINGS.sfx * mute, t, 0.05);
}

// Pull the music down for a moment (KOs, the winner fanfare).
function duck(amount, hold, release) {
  if (!ac) return;
  const level = bus.duck.gain;
  const t = ac.currentTime;
  level.cancelScheduledValues(t);
  level.setValueAtTime(level.value, t);
  level.linearRampToValueAtTime(amount, t + 0.05);
  level.setValueAtTime(amount, t + hold);
  level.linearRampToValueAtTime(1, t + hold + release);
}

// Building blocks, shared with the music

// A gain node shaped as attack, then exponential decay, connected to `out`.
function env(t, out, peak, attack, decay) {
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  g.connect(out);
  return g;
}

// A single enveloped tone, optionally gliding from frequency f to f2.
function osc(t, type, f, f2, dur, out, peak, attack = 0.005, glide = dur) {
  const o = ac.createOscillator();
  const g = env(t, out, peak, attack, dur);
  o.type = type;
  o.frequency.setValueAtTime(f, t);
  if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + glide);
  o.connect(g);
  o.start(t);
  o.stop(t + attack + dur + 0.05);
}

// A burst of filtered noise, optionally sweeping the filter from freq to freq2.
function noise(t, dur, out, peak, type, freq, q = 1, freq2) {
  const src = ac.createBufferSource();
  const filter = ac.createBiquadFilter();
  const g = env(t, out, peak, 0.002, dur);
  src.buffer = noiseBuf;
  src.playbackRate.value = 0.8 + Math.random() * 0.4;
  filter.type = type;
  filter.frequency.setValueAtTime(freq, t);
  filter.Q.value = q;
  if (freq2) filter.frequency.exponentialRampToValueAtTime(freq2, t + dur);
  src.loop = dur > 0.4; // the buffer is one second long
  src.connect(filter).connect(g);
  src.start(t, Math.random() * 0.5);
  src.stop(t + dur + 0.05);
}

// An input that plays into `out` and also sends `amount` of itself to the reverb.
function wet(out, amount) {
  const dry = ac.createGain();
  dry.connect(out);
  const send = ac.createGain();
  send.gain.value = amount;
  dry.connect(send).connect(bus.verb);
  return dry;
}

// Sound effects

// Wraps a sound so it only plays once audio is running. The sound is handed the current audio time first.
function fx(sound) {
  return (...args) => {
    if (live()) sound(ac.currentTime, ...args);
  };
}

// a rising pentatonic run, one note per hit of a combo
const COMBO_NOTES = [523, 587, 659, 784, 880, 1047, 1175, 1319];
// the menu blips: back, confirm, move
const UI_NOTES = [440, 660, 560];

export const sfx = {
  // a meaty thump plus a crack of paper: heavier hits are lower, longer and get a ringing tail. Each hit of a combo
  // also rings one note higher than the last.
  hit: fx((t, knockback, combo = 1) => {
    if (t - lastHit < 0.03) return;
    lastHit = t;
    if (combo >= 2) {
      const note = COMBO_NOTES[Math.min(combo - 2, COMBO_NOTES.length - 1)];
      osc(t, 'triangle', note, null, 0.14, bus.fx, 0.07);
    }
    const power = Math.min(1, Math.max(0.1, knockback / 1200));
    const out = wet(bus.fx, 0.15 + power * 0.2);
    osc(t, 'sine', 190 - power * 80, 40, 0.12 + power * 0.22, out, 0.5 + power * 0.4);
    noise(t, 0.05 + power * 0.1, out, 0.5 + power * 0.4, 'bandpass', 2600 - power * 1400, 0.8, 600);
    noise(t, 0.03, out, 0.3, 'highpass', 5000);
    if (power > 0.55) {
      osc(t, 'triangle', 1250, 300, 0.12, out, 0.08);
      osc(t + 0.01, 'square', 90, 50, 0.25, out, 0.07);
    }
  }),
  ping: fx((t) => {
    const out = wet(bus.fx, 0.6);
    osc(t, 'sine', 2093, null, 0.7, out, 0.2);
    osc(t + 0.02, 'sine', 3136, null, 0.5, out, 0.08);
    noise(t, 0.5, out, 0.5, 'lowpass', 700, 0.7);
    duck(0.4, 0.3, 0.8);
  }),
  // a whoosh: a charged swing is longer, louder and sweeps higher
  swing: fx((t, charge = 0) => {
    const len = 0.12 + charge * 0.1;
    noise(t, len, bus.fx, 0.16 + charge * 0.08, 'bandpass', 900 + charge * 600, 1.6, 3200 + charge * 1500);
  }),
  special: fx((t) => {
    const out = wet(bus.fx, 0.3);
    osc(t, 'triangle', 380, 880, 0.16, out, 0.12);
    osc(t, 'sine', 760, 1760, 0.12, out, 0.05);
  }),
  zap: fx((t) => {
    osc(t, 'square', 1300, 260, 0.12, bus.fx, 0.06);
    noise(t, 0.08, bus.fx, 0.15, 'highpass', 4000);
  }),
  jump: fx((t) => {
    osc(t, 'sine', 300, 620, 0.1, bus.fx, 0.12);
    noise(t, 0.07, bus.fx, 0.08, 'bandpass', 1400, 1.2, 3000);
  }),
  // paper feet: a dry tap per footstep (throttled when a crowd is running) and a soft pat on landing, deeper for heavies
  step: fx((t, weight = 1) => {
    if (t - lastStep < 0.03) return;
    lastStep = t;
    noise(t, 0.035, bus.fx, 0.03 * weight, 'bandpass', 2300 / weight, 1.4);
    if (weight > 1.15) osc(t, 'sine', 110, 70, 0.06, bus.fx, 0.05);
  }),
  // impact: 0 (a soft drop) to 1 (a hard fall)
  land: fx((t, impact = 0.5, weight = 1) => {
    noise(t, 0.07 + impact * 0.06, bus.fx, 0.05 + impact * 0.1, 'lowpass', 1500 / weight, 0.8, 400);
    osc(t, 'sine', 150 / weight, 60, 0.1 + impact * 0.08, bus.fx, (0.04 + impact * 0.1) * weight);
  }),
  twinkle: fx((t) => {
    const out = wet(bus.fx, 0.7);
    osc(t, 'sine', 2637, null, 0.25, out, 0.07);
    osc(t + 0.07, 'sine', 3520, null, 0.35, out, 0.06);
  }),
  jump2: fx((t) => {
    osc(t, 'sine', 460, 980, 0.12, bus.fx, 0.1);
    noise(t, 0.12, bus.fx, 0.1, 'bandpass', 2000, 2, 5000);
  }),
  dash: fx((t) => noise(t, 0.1, bus.fx, 0.14, 'bandpass', 1200, 1.4, 4200)),
  walljump: fx((t) => {
    osc(t, 'square', 240, 520, 0.08, bus.fx, 0.05);
    noise(t, 0.08, bus.fx, 0.18, 'bandpass', 1300, 1.2);
  }),
  // a quick rising arpeggio: one note for each hit after the first, up to four
  combo: fx((t, hits) => {
    const out = wet(bus.fx, 0.35);
    [784, 988, 1175, 1568].slice(0, hits - 1).forEach((f, i) => {
      osc(t + i * 0.055, 'triangle', f, null, 0.16, out, 0.12);
      osc(t + i * 0.055, 'sine', f * 2, null, 0.1, out, 0.04);
    });
  }),
  dodge: fx((t) => noise(t, 0.14, bus.fx, 0.1, 'bandpass', 2500, 2, 6000)),
  block: fx((t) => {
    osc(t, 'square', 880, 640, 0.06, bus.fx, 0.05);
    noise(t, 0.05, bus.fx, 0.2, 'highpass', 3500);
  }),
  parry: fx((t) => {
    const out = wet(bus.fx, 0.5);
    osc(t, 'triangle', 1320, 1980, 0.18, out, 0.16);
    osc(t + 0.05, 'sine', 1980, null, 0.3, out, 0.08);
  }),
  grab: fx((t) => {
    noise(t, 0.07, bus.fx, 0.3, 'bandpass', 800, 1);
    osc(t, 'sine', 220, 150, 0.09, bus.fx, 0.15);
  }),
  ledge: fx((t) => {
    noise(t, 0.05, bus.fx, 0.2, 'bandpass', 1600, 1.5);
    osc(t, 'sine', 500, 400, 0.05, bus.fx, 0.05);
  }),
  tech: fx((t) => {
    const out = wet(bus.fx, 0.3);
    osc(t, 'triangle', 900, 1500, 0.12, out, 0.12);
  }),
  shatter: fx((t) => {
    const out = wet(bus.fx, 0.4);
    osc(t, 'sawtooth', 1500, 110, 0.4, out, 0.08);
    noise(t, 0.45, out, 0.4, 'highpass', 2500);
  }),
  thud: fx((t) => {
    osc(t, 'sine', 120, 42, 0.22, bus.fx, 0.35);
    noise(t, 0.12, bus.fx, 0.3, 'lowpass', 400, 0.8);
  }),
  // KO: a big low boom, a rising whoosh and the paper crowd cheering
  ko: fx((t) => {
    const out = wet(bus.fx, 0.5);
    osc(t, 'sine', 120, 32, 0.7, out, 0.55);
    osc(t, 'sawtooth', 340, 50, 0.5, out, 0.08);
    noise(t, 0.7, out, 0.5, 'lowpass', 900, 0.6, 120);
    noise(t + 0.05, 0.4, out, 0.12, 'bandpass', 600, 2, 5000);
    cheer(t + 0.12, 1.4, 0.16);
    duck(0.35, 0.5, 1.2);
  }),
  pick: fx((t) => {
    const out = wet(bus.fx, 0.3);
    osc(t, 'sine', 660, null, 0.1, out, 0.12);
    osc(t + 0.08, 'sine', 990, null, 0.18, out, 0.12);
  }),
  shock: fx((t) => {
    const out = wet(bus.fx, 0.4);
    osc(t, 'sine', 140, 40, 0.5, out, 0.4);
    osc(t, 'triangle', 900, 200, 0.3, out, 0.06);
    noise(t, 0.3, out, 0.2, 'bandpass', 500, 1, 3000);
  }),
  beep: fx((t) => {
    const out = wet(bus.fx, 0.3);
    osc(t, 'triangle', 523, null, 0.16, out, 0.18);
    osc(t, 'sine', 1046, null, 0.12, out, 0.06);
  }),
  go: fx((t) => {
    const out = wet(bus.fx, 0.4);
    osc(t, 'triangle', 784, null, 0.4, out, 0.12);
    osc(t, 'triangle', 1046, null, 0.4, out, 0.12);
    osc(t + 0.03, 'triangle', 1568, null, 0.4, out, 0.12);
    noise(t, 0.4, out, 0.1, 'highpass', 6000);
    cheer(t + 0.05, 1, 0.12);
  }),
  join: fx((t) => {
    const out = wet(bus.fx, 0.3);
    osc(t, 'sine', 523, null, 0.09, out, 0.1);
    osc(t + 0.07, 'sine', 784, null, 0.14, out, 0.1);
  }),
  ready: fx((t) => {
    const out = wet(bus.fx, 0.35);
    osc(t, 'triangle', 880, null, 0.1, out, 0.1);
    osc(t + 0.06, 'triangle', 1320, null, 0.16, out, 0.1);
  }),
  // stage events: a two-note slide whistle as the warning, a wind that swells and dies, a long rolling rumble
  warn: fx((t) => {
    const out = wet(bus.fx, 0.45);
    osc(t, 'triangle', 700, 1050, 0.16, out, 0.12, 0.01, 0.12);
    osc(t + 0.22, 'triangle', 700, 1050, 0.22, out, 0.12, 0.01, 0.15);
  }),
  gust: fx((t, dur = 4) => {
    const src = ac.createBufferSource();
    const filter = ac.createBiquadFilter();
    const g = ac.createGain();
    src.buffer = noiseBuf;
    src.loop = true;
    filter.type = 'bandpass';
    filter.Q.value = 0.9;
    filter.frequency.setValueAtTime(400, t);
    filter.frequency.linearRampToValueAtTime(1300, t + dur * 0.5);
    filter.frequency.linearRampToValueAtTime(500, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.22, t + dur * 0.4);
    g.gain.linearRampToValueAtTime(0.0001, t + dur);
    src.connect(filter).connect(g).connect(wet(bus.fx, 0.5));
    src.start(t);
    src.stop(t + dur + 0.1);
  }),
  rumble: fx((t) => {
    noise(t, 3.2, wet(bus.fx, 0.3), 0.28, 'lowpass', 260, 0.7, 140);
    osc(t, 'sine', 58, 46, 3, bus.fx, 0.12, 0.3);
  }),
  ui: fx((t, kind = 0) => osc(t, 'triangle', UI_NOTES[kind], null, 0.06, bus.fx, 0.08)),
  win: fx((t) => {
    const out = wet(bus.fx, 0.45);
    // [frequency, start, length]
    [
      [523, 0, 0.14],
      [659, 0.12, 0.14],
      [784, 0.24, 0.14],
      [1046, 0.36, 0.5],
      [988, 0.62, 0.12],
      [1046, 0.74, 0.7],
    ].forEach(([f, start, len]) => {
      osc(t + start, 'square', f, null, len, out, 0.05);
      osc(t + start, 'triangle', f, null, len + 0.1, out, 0.12);
    });
    cheer(t, 2.4, 0.2);
    duck(0.15, 1.6, 1.5);
  }),
  // a sheet of paper ripping: a run of tiny crackles that speeds up and brightens
  tear: fx((t) => {
    const out = wet(bus.fx, 0.2);
    let at = t;
    for (let i = 0; i < 30; i++) {
      at += 0.03 - i * 0.0006 + Math.random() * 0.012;
      const peak = 0.12 + Math.random() * 0.14;
      const freq = 1500 + i * 90 + Math.random() * 900;
      noise(at, 0.035, out, peak, 'bandpass', freq, 1.3);
    }
    noise(t, 0.75, out, 0.06, 'highpass', 3000);
  }),
  // a sad trombone, falling a semitone at a time
  draw: fx((t) => {
    const out = wet(bus.fx, 0.4);
    osc(t, 'triangle', 523, null, 0.22, out, 0.1);
    osc(t + 0.18, 'triangle', 494, null, 0.22, out, 0.1);
    osc(t + 0.36, 'triangle', 466, null, 0.22, out, 0.1);
    osc(t + 0.54, 'triangle', 440, null, 0.22, out, 0.1);
  }),
};

// Fighter voices: tiny formant-synth grunts, pitched per character as [pitch Hz, formant scale].
const VOICE = {
  mochi: [520, 1],
  ember: [640, 1.1],
  boulder: [200, 0.82],
  volt: [740, 1.15],
  bubbles: [480, 1.06],
  thorn: [360, 0.94],
  pinwheel: [600, 1.08],
};
const VOWEL = { a: [800, 1250], o: [480, 860], e: [420, 2000], u: [350, 700] };
let lastVoice = 0;

// A sawtooth at `pitch` (bending by `bend` over the syllable) through two band-pass filters at the vowel's formants.
function syllable(t, pitch, formant, vowel, dur, bend, vol) {
  const src = ac.createOscillator();
  const out = wet(bus.fx, 0.25);
  const g = env(t, out, vol, 0.015, dur);
  src.type = 'sawtooth';
  src.frequency.setValueAtTime(pitch, t);
  src.frequency.exponentialRampToValueAtTime(pitch * bend, t + dur);
  VOWEL[vowel].forEach((freq, i) => {
    const band = ac.createBiquadFilter();
    const level = ac.createGain();
    band.type = 'bandpass';
    band.frequency.value = freq * formant;
    band.Q.value = 5 + i * 3;
    level.gain.value = i === 0 ? 1.2 : 0.7;
    src.connect(band).connect(level).connect(g);
  });
  src.start(t);
  src.stop(t + dur + 0.08);
}

// kind: 'hup' (a big swing or special), 'ow' (launched off the stage), 'yay' (won the match)
export function voice(ch, kind) {
  if (!live()) return;
  const t = ac.currentTime;
  if (kind === 'hup' && t - lastVoice < 0.25) return;
  lastVoice = t;
  const [pitch, formant] = VOICE[ch] || VOICE.mochi;
  const wobble = 0.94 + Math.random() * 0.12; // never quite the same pitch twice
  if (kind === 'hup') {
    noise(t, 0.04, bus.fx, 0.05, 'bandpass', 2400 * formant, 1);
    syllable(t + 0.02, pitch * wobble, formant, Math.random() < 0.5 ? 'a' : 'u', 0.13, 1.18, 0.5);
  } else if (kind === 'ow') {
    syllable(t, pitch * 1.15 * wobble, formant, 'a', 0.22, 1.1, 0.55);
    syllable(t + 0.2, pitch * 1.25 * wobble, formant, 'o', 0.5, 0.45, 0.5);
  } else if (kind === 'yay') {
    syllable(t + 0.05, pitch * wobble, formant, 'e', 0.12, 1.1, 0.5);
    syllable(t + 0.19, pitch * 1.2 * wobble, formant, 'a', 0.42, 1.35, 0.55);
  }
}

// A crowd of paper people: band-passed noise with a ragged swell.
function cheer(t, dur, vol) {
  for (let i = 0; i < 3; i++) {
    const src = ac.createBufferSource();
    const filter = ac.createBiquadFilter();
    const g = ac.createGain();
    const trem = ac.createOscillator();
    const tremDepth = ac.createGain();
    src.buffer = noiseBuf;
    src.loop = true;
    filter.type = 'bandpass';
    filter.frequency.value = 900 + i * 700;
    filter.Q.value = 0.9;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol / (i + 1), t + 0.15);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    trem.frequency.value = 7 + i * 3.3;
    tremDepth.gain.value = (vol * 0.3) / (i + 1);
    trem.connect(tremDepth).connect(g.gain);
    src.connect(filter).connect(g).connect(bus.fx);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.1);
    trem.start(t);
    trem.stop(t + dur + 0.1);
  }
}

// Controller rumble: the same moments that buzz a phone (a hit, a KO, a stage warning) shake a gamepad.

// How long each kind of buzz lasts (ms) and how hard the two motors turn (0..1): the heavy one, then the light one.
const EFFECTS = {
  pick: [40, 0, 0.3],
  hit: [90, 0.25, 0.5],
  bighit: [180, 0.7, 0.8],
  ko: [380, 1, 1],
  warn: [140, 0.2, 0.5],
};

// `id` is the player's id, 'pad-0' for the first gamepad. Does nothing for controllers and browsers without rumble,
// or with "Shake & flashes" switched off.
export function rumble(id, kind) {
  const effect = EFFECTS[kind];
  const strength = Math.min(1, shakeK());
  if (!effect || !strength || typeof navigator === 'undefined' || !navigator.getGamepads) return;
  const pad = navigator.getGamepads()[Number(id.slice(4))];
  const motor = pad?.vibrationActuator;
  if (!motor || !motor.playEffect) return;
  const [duration, strong, weak] = effect;
  const magnitudes = { duration, strongMagnitude: strong * strength, weakMagnitude: weak * strength };
  try {
    // a controller that has just gone to sleep rejects the effect: nothing to do about it
    motor.playEffect('dual-rumble', magnitudes).catch(() => {});
  } catch {
    // this browser knows the controller but not this kind of effect (or gives no promise back)
  }
}

// The soundtrack: original, procedurally played tunes on a lookahead scheduler (16th-note steps).
// Each stage has its own battle theme; the lobby and the results screen have calmer ones. Layers fade in with
// the action (drums at "play", the counter-melody once fighters are near the edge), and sudden death speeds up.

// Note names to MIDI numbers: 'C4' = 60, 'F#4' = 66, 'Bb3' = 58.
const NOTE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const SHARP_FLAT = { '#': 1, b: -1 };
function midi(name) {
  const octave = Number(name.at(-1));
  return 12 * (octave + 1) + NOTE[name[0]] + (SHARP_FLAT[name[1]] || 0);
}
const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
// Melodies and patterns are written one 16th step per word: a note, '.' (rest) or '-' (hold the note before).
const seq = (s) => s.trim().split(/\s+/);

// Chords as [root, third, fifth, seventh] in MIDI; one per bar.
const ch = (s) => s.split(' ').map((c) => c.split(',').map(midi));

// The tracks. Exported for the harmony check (node test.js 0 0 1 music).
export const TRACKS = {
  // lobby: a lazy, swung paper-toy shuffle
  lobby: {
    bpm: 96,
    swing: 0.18,
    bars: 4,
    chords: ch('F3,A3,C4,E4 D3,F3,A3,C4 G3,Bb3,D4,F4 C3,E3,G3,Bb3'),
    lead: {
      wave: 'triangle',
      vol: 0.09,
      oct: 0,
      notes: seq(`
      A4 - C5 - A4 G4 F4 - . . C4 - F4 - A4 -   . . D5 - C5 A4 F4 - D4 - - - . . . .
      Bb4 - D5 - Bb4 A4 G4 - . . D4 - G4 - Bb4 -  Bb4 - G4 - E4 - C4 - . . G4 - - - . .`),
    },
    bass: 'r . . . 5 . . . r . 5 . r . . .',
    drums: {
      k: 'x . . . . . . . x . . . . . . .',
      s: '. . . . x . . . . . . . x . . .',
      h: 'x . x . x . x . x . x . x . x x',
    },
    keys: 'stab',
    pad: 0.03,
  },
  // Meadow Hollow: bright, bouncy, major
  meadow: {
    bpm: 132,
    swing: 0.08,
    bars: 8,
    chords: ch(
      'C3,E3,G3,B3 A2,C3,E3,G3 F2,A2,C3,E3 G2,B2,D3,F3 C3,E3,G3,B3 E2,G#2,B2,D3 A2,C3,E3,G3 G2,B2,D3,F3',
    ),
    lead: {
      wave: 'square',
      vol: 0.05,
      oct: 0,
      notes: seq(`
      E5 - G5 - C6 - B5 A5 G5 - E5 - . . D5 E5   C5 - E5 - A5 - G5 E5 C5 - - - . . . .
      F5 - A5 - C6 - A5 - G5 F5 E5 - D5 - C5 -    B4 - D5 - G5 - F5 E5 D5 - - - . . G4 -
      E5 - G5 - C6 - B5 A5 G5 - E5 - . . D5 E5   E5 - G#5 - B5 - G#5 E5 D5 - B4 - . . . .
      C5 - E5 - A5 - G5 F5 E5 D5 C5 B4 A4 - G4 -  B4 - D5 - G5 - - - F5 - D5 - B4 - G4 -`),
    },
    counter: {
      wave: 'triangle',
      vol: 0.06,
      oct: 2,
      rhythm: 'x . . . x . . . x . . . x . x .',
      degs: [3, 2, 1, 2, 3, 1],
    },
    bass: 'r . r . 5 . r . r . r . 5 . 8 .',
    drums: {
      k: 'x . . . x . . . x . . . x . . x',
      s: '. . . . x . . . . . . . x . . .',
      h: '. . x . . . x . . . x . . . x x',
    },
    keys: 'arp',
    pad: 0.025,
  },
  // Sunset Mesa: dusty desert stomp, mixolydian
  mesa: {
    bpm: 140,
    swing: 0.05,
    bars: 8,
    chords: ch(
      'D3,F#3,A3,C4 D3,F#3,A3,C4 C3,E3,G3,Bb3 G2,B2,D3,F3 D3,F#3,A3,C4 D3,F#3,A3,C4 Bb2,D3,F3,A3 A2,C#3,E3,G3',
    ),
    lead: {
      wave: 'sawtooth',
      vol: 0.035,
      oct: 0,
      notes: seq(`
      D5 - - - A4 - D5 E5 F#5 - E5 D5 C5 - A4 -   D5 - - - . . A4 C5 D5 - - - . . . .
      E5 - - - C5 - E5 G5 G5 - F5 E5 D5 - C5 -    B4 - D5 - G5 - F5 - D5 - B4 - G4 - - -
      A5 - - - F#5 - D5 - F#5 - A5 G5 F#5 - C5 -   D5 - E5 - F#5 - A5 - D6 - - - . . . .
      F5 - - - D5 - F5 A5 G5 - F5 D5 Bb4 - - -    A4 - C#5 - E5 - G5 - A5 - - - E5 - C#5 -`),
    },
    counter: {
      wave: 'triangle',
      vol: 0.06,
      oct: 2,
      rhythm: 'x . x . . . x . x . . . x . x .',
      degs: [2, 2, 1, 2, 3, 1],
    },
    bass: 'r . r r . . 5 . r . r r . . 7 .',
    drums: {
      k: 'x . . x . . x . x . . x . . x .',
      s: '. . . . x . . . . . . . x . x .',
      h: 'x x x x x x x x x x x x x x x x',
    },
    keys: 'stab',
    pad: 0.02,
  },
  // Snowfold Peaks: a music-box waltz-feel in E minor, glassy and light
  peaks: {
    bpm: 124,
    swing: 0.1,
    bars: 8,
    chords: ch(
      'E3,G3,B3,D4 C3,E3,G3,B3 G2,B2,D3,F#3 D3,F#3,A3,C4 E3,G3,B3,D4 A2,C3,E3,G3 C3,E3,G3,B3 B2,D#3,F#3,A3',
    ),
    lead: {
      wave: 'triangle',
      vol: 0.1,
      oct: 0,
      notes: seq(`
      E5 - G5 - B5 - - A5 G5 - F#5 - E5 - D5 -    E5 - - - G5 - E5 - C5 - - - B4 - C5 -
      D5 - B4 - G4 - B4 - D5 - - - F#5 - G5 -    A5 - - - F#5 - D5 - A4 - - - . . . .
      E5 - G5 - B5 - - A5 G5 - F#5 - E5 - G5 -   A5 - - - E5 - C5 - E5 - - - A4 - C5 -
      B4 - C5 - E5 - G5 - - - E5 - C5 - B4 -     D#5 - - - F#5 - B5 - A5 - - - F#5 - D#5 -`),
    },
    counter: {
      wave: 'sine',
      vol: 0.07,
      oct: 3,
      rhythm: 'x . . x . . x . . x . . x . . .',
      degs: [1, 2, 3, 2],
    },
    bass: 'r . . . 5 . . . r . . . 5 . 3 .',
    drums: {
      k: 'x . . . . . . . x . . . . . . .',
      s: '. . . . x . . . . . . . x . . .',
      h: '. . x . . . x . . . x . . . x .',
    },
    keys: 'arp',
    pad: 0.03,
  },
  // results: a short, bright fanfare loop
  results: {
    bpm: 108,
    swing: 0.1,
    bars: 4,
    chords: ch('C3,E3,G3,B3 F3,A3,C4,E4 D3,F3,A3,C4 G2,B2,D3,F3'),
    lead: {
      wave: 'triangle',
      vol: 0.09,
      oct: 0,
      notes: seq(`
      G4 - C5 - E5 - G5 - - - E5 - G5 - A5 -   A5 - G5 - F5 - E5 - - - C5 - . . . .
      F5 - - - D5 - A4 - - - C5 - D5 - F5 -   D5 - - - . . B4 - - - G4 - - - . .`),
    },
    bass: 'r . . . 5 . . . r . . . 5 . 8 .',
    drums: {
      k: 'x . . . . . . . x . . . . . . .',
      s: '. . . . x . . . . . . . x . . .',
      h: 'x . x . x . x . x . x . x . x .',
    },
    keys: 'arp',
    pad: 0.035,
  },
};

// The player. `song` is the tune playing now: which step it is on, how many times it has looped and when the next
// step is due.
const LOOKAHEAD = 0.12; // seconds of music scheduled ahead
const song = {
  track: null,
  name: '',
  step: 0,
  loop: 0,
  next: 0,
  layers: { drums: 0, counter: 0 }, // how loud the drums and the counter-melody play, 0 to 1
  rate: 1,
  gain: null, // this tune's own fader, so the next one can fade in over it
};
const steps = (track) => track.bars * 16;

// Which tune fits the game right now.
function tuneForNow() {
  if (G.state === 'result') return 'results';
  if (G.state === 'play' || G.state === 'countdown') return G.stageId;
  return 'lobby';
}

export function updateMusic(heat) {
  if (!live()) return;
  const name = tuneForNow();
  if (name !== song.name) switchTo(name);
  song.layers.drums = G.state === 'countdown' ? 0.25 : 1; // the drums drop back for the countdown
  song.layers.counter = G.state === 'play' ? Math.min(1, heat) : 0;
  song.rate = G.sudden ? 1.12 : 1;
  const t = ac.currentTime;
  if (G.paused) {
    song.next = Math.max(song.next, t + 0.05);
    return;
  }
  ambience(t);
  while (song.next < t + LOOKAHEAD) {
    play(song.track, song.step, song.next);
    song.next += stepLen(song.track, song.step);
    song.step = (song.step + 1) % steps(song.track);
    if (song.step === 0) song.loop++;
  }
}

// Fades the old tune out and starts `name` from the top.
function switchTo(name) {
  const t = ac.currentTime;
  if (song.gain) {
    const old = song.gain;
    old.gain.setTargetAtTime(0.0001, t, 0.25);
    setTimeout(() => old.disconnect(), 2000);
  }
  song.gain = ac.createGain();
  song.gain.gain.setValueAtTime(0.0001, t);
  song.gain.gain.setTargetAtTime(1, t + 0.05, 0.3);
  song.gain.connect(bus.music);
  song.name = name;
  song.track = TRACKS[name];
  song.step = 0;
  song.loop = 0;
  song.next = t + 0.1;
}

// How long sixteenth `i` lasts. With swing the even ones are a little longer and the odd ones shorter.
function stepLen(track, i) {
  const base = 60 / track.bpm / 4 / song.rate;
  return base * (i % 2 === 0 ? 1 + track.swing : 1 - track.swing);
}

// Bass letters: r = root, 3/5/7 = that chord tone, all an octave below the chord; 8 = the root at the chord's octave.
const BASS_TONE = { r: 0, 3: 1, 5: 2, 7: 3 };

// Plays sixteenth `i` of a track at audio time `t`: drums, bass, keys, pad, then the melodies.
function play(track, i, t) {
  const out = song.gain;
  const bar = Math.floor(i / 16);
  const sixteenth = i % 16;
  const chord = track.chords[bar % track.chords.length];
  const stepSecs = stepLen(track, 0);
  // Arrangement: every third pass of a battle theme is a variation. Its first half is a breakdown (quieter drums,
  // no melody, the counter-melody carries it) and its second half plays the melody an octave up.
  const variation = track.counter && song.loop % 3 === 2;
  const breakdown = variation && i < steps(track) / 2;

  // drums: k = kick, s = snare, h = hi-hat
  const drums = track.drums;
  const drumVol = song.layers.drums * (breakdown ? 0.55 : 1);
  if (drumVol > 0.01) {
    const hatVol = (sixteenth % 4 === 2 ? 0.07 : 0.045) * drumVol;
    if (seq(drums.k)[sixteenth] === 'x') kick(t, out, 0.5 * drumVol);
    if (seq(drums.s)[sixteenth] === 'x') snare(t, out, 0.22 * drumVol);
    if (seq(drums.h)[sixteenth] === 'x') noise(t, 0.03, out, hatVol, 'highpass', 7000);
  }

  const bass = seq(track.bass)[sixteenth];
  if (bass !== '.') {
    const note = bass === '8' ? chord[0] : chord[BASS_TONE[bass]] - 12;
    osc(t, 'triangle', hz(note), null, stepSecs * 1.6, out, 0.2);
    osc(t, 'sine', hz(note - 12), null, stepSecs * 1.8, out, 0.16);
  }

  // keys: a running arpeggio, or off-beat chord stabs
  if (track.keys === 'arp' && sixteenth % 2 === 0) {
    keyNote(t, out, chord[(sixteenth / 2) % 4] + 12, stepSecs * 1.5, 0.045);
  } else if (track.keys === 'stab' && sixteenth % 4 === 2) {
    for (const n of chord.slice(1)) keyNote(t, out, n + 12, stepSecs * 0.9, 0.025);
  }

  // pad: one soft chord per bar
  if (sixteenth === 0 && track.pad) for (const n of chord) padNote(t, out, n + 12, stepSecs * 16, track.pad);

  // melody and counter-melody
  if (!breakdown) {
    let lead = track.lead;
    if (variation) lead = { ...lead, wave: 'triangle', oct: lead.oct + 1, vol: Math.max(lead.vol, 0.07) };
    line(lead, i, t, out, track, 1);
  }
  const counterLevel = breakdown ? 1 : song.layers.counter;
  if (track.counter && counterLevel > 0.05) line(track.counter, i, t, out, track, counterLevel);
}

// A melodic part is either written out (notes) or follows the chords: a rhythm of hits, each playing the next chord
// degree from degs, `oct` octaves above the chord voicing (so it can never clash with the harmony).
function line(part, i, t, out, track, level) {
  const bar = Math.floor(i / 16);
  let note;
  let len = 1; // in sixteenths
  if (part.degs) {
    const rhythm = seq(part.rhythm);
    const sixteenth = i % 16;
    if (rhythm[sixteenth] !== 'x') return;
    while (sixteenth + len < 16 && rhythm[sixteenth + len] !== 'x') len++;
    // each bar starts three places further along degs
    const hit = rhythm.slice(0, sixteenth).filter((s) => s === 'x').length + bar * 3;
    note = track.chords[bar % track.chords.length][part.degs[hit % part.degs.length]] + part.oct * 12;
  } else {
    const notes = part.notes;
    const name = notes[i % notes.length];
    if (name === '.' || name === '-') return;
    while (notes[(i + len) % notes.length] === '-' && len < 16) len++;
    note = midi(name) + part.oct * 12;
  }
  const dur = stepLen(track, 0) * len;
  const f = hz(note);
  const wetOut = wet(out, 0.25);
  const tone = ac.createOscillator();
  const g = env(t, wetOut, part.vol * level, 0.012, dur * 0.95 + 0.08);
  tone.type = part.wave;
  tone.frequency.setValueAtTime(f, t);
  // a little delayed vibrato on held notes
  if (len >= 3) {
    const lfo = ac.createOscillator();
    const depth = ac.createGain();
    lfo.frequency.value = 5.5;
    depth.gain.setValueAtTime(0, t);
    depth.gain.linearRampToValueAtTime(f * 0.012, t + dur * 0.6);
    lfo.connect(depth).connect(tone.frequency);
    lfo.start(t);
    lfo.stop(t + dur + 0.2);
  }
  tone.connect(g);
  tone.start(t);
  tone.stop(t + dur + 0.2);
}

// A square-wave key whose filter closes as it fades.
function keyNote(t, out, note, dur, vol) {
  const filter = ac.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(3200, t);
  filter.frequency.exponentialRampToValueAtTime(700, t + dur);
  filter.connect(wet(out, 0.2));
  osc(t, 'square', hz(note), null, dur, filter, vol, 0.004);
}

// One note of the pad: two slightly detuned saws that swell in and out.
function padNote(t, out, note, dur, vol) {
  const filter = ac.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 1100;
  filter.connect(wet(out, 0.5));
  for (const cents of [-6, 6]) {
    const saw = ac.createOscillator();
    const g = ac.createGain();
    saw.type = 'sawtooth';
    saw.frequency.value = hz(note);
    saw.detune.value = cents;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + dur * 0.3);
    g.gain.linearRampToValueAtTime(0.0001, t + dur);
    saw.connect(g).connect(filter);
    saw.start(t);
    saw.stop(t + dur + 0.05);
  }
}

function kick(t, out, vol) {
  osc(t, 'sine', 150, 45, 0.18, out, vol, 0.002, 0.08);
  noise(t, 0.015, out, vol * 0.3, 'lowpass', 2000);
}

function snare(t, out, vol) {
  const wetOut = wet(out, 0.3);
  noise(t, 0.14, wetOut, vol, 'bandpass', 1900, 0.7);
  osc(t, 'triangle', 220, 160, 0.08, wetOut, vol * 0.6);
}

// Ambience: each stage has a quiet bed of its own under the music. Meadow: a breeze and birdsong. Sunset Mesa: wind
// and a far-off hawk. Snowfold Peaks: wind and an icy chime.
// which stage the ambience is for, its bed, and when the next sound is due
const ambient = { id: null, bed: null, next: 0 };

// The bed is looping noise through a filter, with a slow swell. `level` is how loud it sits; windy stages get a
// narrower band and a quicker swell.
const CALM_BED = { filter: 'lowpass', frequency: 520, q: 0.5, level: 0.025, swell: 0.08 };
const BEDS = {
  meadow: CALM_BED,
  mesa: { filter: 'bandpass', frequency: 650, q: 0.8, level: 0.05, swell: 0.13 },
  peaks: { filter: 'bandpass', frequency: 900, q: 0.8, level: 0.04, swell: 0.13 },
};

function startBed(id, t) {
  const bed = BEDS[id] || CALM_BED;
  const src = ac.createBufferSource();
  const filter = ac.createBiquadFilter();
  const fader = ac.createGain();
  const lfo = ac.createOscillator();
  const swell = ac.createGain();
  src.buffer = noiseBuf;
  src.loop = true;
  filter.type = bed.filter;
  filter.frequency.value = bed.frequency;
  filter.Q.value = bed.q;
  fader.gain.setValueAtTime(0.0001, t);
  fader.gain.setTargetAtTime(bed.level, t, 0.8);
  lfo.frequency.value = bed.swell;
  swell.gain.value = bed.level * 0.6;
  lfo.connect(swell).connect(fader.gain);
  src.connect(filter).connect(fader).connect(bus.music);
  src.start(t);
  lfo.start(t);
  return { src, fader, level: bed.level };
}

// Fades the old stage's bed out, then lets go of it.
function stopBed(old, t) {
  old.fader.gain.setTargetAtTime(0.0001, t, 0.4);
  setTimeout(() => {
    try {
      old.src.stop();
    } catch {
      // already stopped
    }
    old.fader.disconnect();
  }, 3000);
}

// Each of these plays one sound and says when the next is due.
function birdsong(t, vol) {
  ambient.next = t + 0.6 + Math.random() * 2.6;
  const chirps = 2 + Math.floor(Math.random() * 3);
  const pitch = 2600 + Math.random() * 1400;
  for (let i = 0; i < chirps; i++) {
    osc(t + i * 0.07, 'sine', pitch, pitch * 1.35, 0.05, bus.music, 0.02 * vol);
  }
}

const ICE_CHIME = [2637, 2960, 3136, 3951, 4699];
function iceChime(t, vol) {
  ambient.next = t + 2.5 + Math.random() * 4;
  for (let i = 0; i < 3; i++) {
    const note = ICE_CHIME[Math.floor(Math.random() * ICE_CHIME.length)];
    osc(t + i * 0.09, 'sine', note, null, 1.6, wet(bus.music, 0.7), 0.012 * vol);
  }
}

function hawk(t, vol) {
  ambient.next = t + 9 + Math.random() * 12;
  const out = wet(bus.music, 0.7);
  osc(t, 'sine', 2100, 1350, 0.7, out, 0.022 * vol, 0.06);
  osc(t + 0.05, 'sine', 4200, 2700, 0.6, out, 0.006 * vol, 0.06);
}

const STAGE_SOUNDS = { meadow: birdsong, peaks: iceChime, mesa: hawk };

function ambience(t) {
  const id = G.stageId;
  const loudness = G.state === 'result' ? 0.4 : 1;
  if (ambient.id !== id) {
    if (ambient.bed) stopBed(ambient.bed, t);
    ambient.id = id;
    ambient.next = t + 1;
    ambient.bed = startBed(id, t);
  }
  ambient.bed.fader.gain.setTargetAtTime(ambient.bed.level * loudness, t, 0.5);
  if (t < ambient.next) return;
  const playSound = STAGE_SOUNDS[id] || hawk;
  playSound(t, loudness * (G.state === 'play' ? 0.7 : 1));
}
