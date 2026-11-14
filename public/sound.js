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
  startMusic();
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
    excite(0.06 + power * 0.2); // the music picks up with the fighting
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
    excite(1);
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

// The soundtrack: a playlist of phonk tracks, the mp3s in public/assets/music/ (the server lists them at /music). They
// play one after another in a shuffled order, and every match starts on a fresh one. The music follows the match: in
// the lobby it plays a touch slow and muffled, the 3-2-1 countdown opens it up, and in a match it speeds up (pitching
// up, sped-up style) as the fighting heats up, fastest in sudden death. With no tracks the game plays without music.
const MUSIC_TRIM = 0.5; // the tracks are levelled to -14 LUFS; this sits them under the sound effects
const FASTEST = 1.22; // the speed at the height of a match
const SUDDEN_DEATH = 1.3;
const CROSSFADE = 1; // seconds
// list: the track files; order: the shuffled play order; at: where we are in it; src: the track playing;
// loads: decoding tracks by file (only the current and the next are kept)
const music = {
  list: [],
  order: [],
  at: -1,
  src: null,
  tone: null,
  rate: 1,
  cutoff: 0,
  turn: 0,
  loads: new Map(),
  state: '', // the game state last frame, to catch the start of a countdown
};

// Fetches the list and starts the first track. Called once sound is allowed.
async function startMusic() {
  try {
    music.list = await (await fetch('/music')).json();
  } catch {
    return;
  }
  if (!music.list.length) return;
  music.order = music.list.map((_, i) => i);
  for (let i = music.order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [music.order[i], music.order[j]] = [music.order[j], music.order[i]];
  }
  music.tone = ac.createBiquadFilter();
  music.tone.type = 'lowpass';
  music.tone.frequency.value = 1500;
  const trim = ac.createGain();
  trim.gain.value = MUSIC_TRIM;
  music.tone.connect(trim).connect(bus.music);
  nextTrack();
}

// The decoded track at place `at` in the play order (a promise), loading it if it isn't already.
function load(at) {
  const file = music.list[music.order[at % music.order.length]];
  if (!music.loads.has(file)) {
    const decoding = fetch('/assets/music/' + encodeURIComponent(file))
      .then((res) => res.arrayBuffer())
      .then((data) => ac.decodeAudioData(data));
    music.loads.set(file, decoding);
  }
  return music.loads.get(file);
}

// Crossfades to the next track in the order, and starts loading the one after it.
async function nextTrack(failures = 0) {
  const turn = ++music.turn; // a newer call wins if two overlap
  music.at = (music.at + 1) % music.order.length;
  let buffer;
  try {
    buffer = await load(music.at);
  } catch {
    if (turn === music.turn && failures < music.order.length) nextTrack(failures + 1); // unreadable: skip it
    return;
  }
  if (turn !== music.turn) return;
  const t = ac.currentTime;
  if (music.src) {
    const old = music.src;
    old.fade.gain.setTargetAtTime(0.0001, t, CROSSFADE / 4);
    old.stop(t + CROSSFADE * 1.5);
  }
  const src = ac.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = music.rate;
  src.fade = ac.createGain();
  src.fade.gain.setValueAtTime(0.0001, t);
  src.fade.gain.setTargetAtTime(1, t, CROSSFADE / 4);
  src.connect(src.fade).connect(music.tone);
  src.onended = () => {
    if (music.src === src) nextTrack(); // it played to the end
  };
  src.start(t);
  music.src = src;
  // keep only this track and the next one decoded (they're big)
  const keep = [music.at, music.at + 1].map((at) => music.list[music.order[at % music.order.length]]);
  for (const file of music.loads.keys()) if (!keep.includes(file)) music.loads.delete(file);
  load(music.at + 1).catch(() => {});
}

// How hard the match is going, 0..1. `action` jumps with every hit and KO and fades over a few seconds; `energy`
// follows the game's heat or the action, whichever is higher, rising quickly and settling slowly.
const mood = { energy: 0, action: 0, last: 0 };

function feel(heat, t) {
  const dt = Math.min(0.1, Math.max(0, t - mood.last));
  mood.last = t;
  mood.action *= Math.exp(-dt / 2.5);
  let target = 0;
  if (G.state === 'play') target = Math.max(heat, mood.action * 0.7);
  const settle = target > mood.energy ? 0.5 : 4; // seconds
  mood.energy += (target - mood.energy) * (1 - Math.exp(-dt / settle));
}

// Called by the hit and KO sounds.
function excite(amount) {
  mood.action = Math.min(1, mood.action + amount);
}

// The track's speed and filter for this moment: [playback rate, low-pass cutoff in Hz].
function musicTarget() {
  if (G.paused) return [music.rate, 700]; // muffled, holding its speed
  if (G.state === 'countdown') return [1, 1500 * Math.pow(12, Math.min(1, G.stT / 3))]; // opens up to 18 kHz at GO
  if (G.state === 'play') return [G.sudden ? SUDDEN_DEATH : 1 + (FASTEST - 1) * mood.energy, 20000];
  if (G.state === 'result') return [1, 20000];
  return [0.94, 1500];
}

export function updateMusic(heat) {
  if (!live()) return;
  const t = ac.currentTime;
  feel(heat, t);
  ambience(t);
  // every match opens on a fresh track, under the countdown's build-up
  if (G.state === 'countdown' && music.state !== 'countdown' && music.order.length > 1) nextTrack();
  music.state = G.state;
  if (!music.src) return;
  const [rate, cutoff] = musicTarget();
  if (Math.abs(rate - music.rate) > 0.005) {
    music.rate = rate;
    music.src.playbackRate.setTargetAtTime(rate, t, 0.6);
  }
  if (Math.abs(cutoff - music.cutoff) > music.cutoff * 0.02) {
    music.cutoff = cutoff;
    music.tone.frequency.setTargetAtTime(cutoff, t, G.state === 'countdown' ? 0.05 : 0.25);
  }
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
