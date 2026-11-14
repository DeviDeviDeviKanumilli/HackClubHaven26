// The fighter roster: stats, move names and colors. Shared by the big screen and the phone.
// (The ids are the original codenames: mochi is Pip, ember Cinder, boulder Slate, bubbles Wisp, pinwheel Gale.)
//
// size: body scale · speed: run speed · weight: resists knockback · jump: jump velocity · airJumps: jumps in the air
// grav/fall: floatiness · dmg/kb: attack strength · reach: how far normal attacks extend · tempo: attack slowness
// color/alts: paper colors (alts are used when two players pick the same fighter)
// bars: power, speed and weight out of 5, for the phone · kit: the four specials, as shown on the phone
// prettier-ignore
export const CHARS = {
  mochi: {
    name: 'Pip', role: 'All-rounder', blurb: 'Good at everything. The easy first pick.',
    color: '#ff8fae', alts: ['#ff8fae', '#ffc27a', '#c7a6ff', '#8fdcbc'],
    size: 1, speed: 480, weight: 1, jump: 920, airJumps: 1, grav: 1, fall: 940,
    dmg: 1, kb: 1, reach: 1, tempo: 1, bars: [3, 3, 3],
    kit: ['Puff Shot · ranged shot', 'Roll Out · rolling tackle',
          'Bounce Up · rising hit', 'Belly Flop · dive bomb'],
  },
  ember: {
    name: 'Cinder', role: 'Speedster', blurb: 'Fast and slippery. Hits lightly, hits often.',
    color: '#ff9650', alts: ['#ff9650', '#ff6f86', '#ffd447', '#b693ff'],
    size: 0.92, speed: 620, weight: 0.84, jump: 960, airJumps: 1, grav: 1.1, fall: 1040,
    dmg: 0.88, kb: 0.95, reach: 0.95, tempo: 0.78, bars: [2, 5, 2],
    kit: ['Cinder · bouncing fireball', 'Blaze Dash · burning rush',
          'Flare Jump · aim it anywhere', 'Heat Ring · burst around you'],
  },
  boulder: {
    name: 'Slate', role: 'Heavyweight', blurb: 'Slow, hard to launch, and hits like a truck.',
    color: '#9fb0c8', alts: ['#9fb0c8', '#d4b48f', '#8fc4ad', '#c3a3d6'],
    size: 1.25, speed: 380, weight: 1.28, jump: 880, airJumps: 1, grav: 1.1, fall: 1080,
    dmg: 1.2, kb: 1.1, reach: 1, tempo: 1.25, bars: [5, 1, 5],
    kit: ['Haymaker · armored mega punch', 'Shoulder Rush · armored charge',
          'Rock Launch · straight up', 'Quake · ground slam'],
  },
  volt: {
    name: 'Volt', role: 'Trickster', blurb: 'Teleports around the stage and stuns from afar.',
    color: '#ffd84a', alts: ['#ffd84a', '#7fd8ff', '#ff94cf', '#aeea6a'],
    size: 0.9, speed: 570, weight: 0.88, jump: 940, airJumps: 1, grav: 1, fall: 980,
    dmg: 0.95, kb: 1, reach: 0.95, tempo: 0.88, bars: [3, 4, 2],
    kit: ['Zap · stun bolt', 'Arc Dash · teleport strike',
          'Blink · teleport anywhere', 'Thunder · lightning from above'],
  },
  bubbles: {
    name: 'Wisp', role: 'Floater', blurb: 'Five jumps and a slow fall. Almost never out of the air.',
    color: '#7fd3ff', alts: ['#7fd3ff', '#ffaad4', '#a9efbd', '#cdb8ff'],
    size: 1, speed: 420, weight: 0.84, jump: 780, airJumps: 4, grav: 0.66, fall: 600,
    dmg: 1, kb: 1, reach: 1, tempo: 0.95, bars: [2, 2, 1],
    kit: ['Big Bubble · slow floating mine', 'Whirl · spinning multi-hit',
          'Updraft · long float upward', 'Pop · blast that shoves everyone'],
  },
  thorn: {
    name: 'Thorn', role: 'Long reach', blurb: 'Vines hit from far away. Punish with the counter.',
    color: '#86d17f', alts: ['#86d17f', '#e6d064', '#6fd0c0', '#f29b95'],
    size: 1.05, speed: 440, weight: 1.06, jump: 900, airJumps: 1, grav: 1, fall: 960,
    dmg: 1, kb: 1, reach: 1.32, tempo: 1.1, bars: [4, 2, 3],
    kit: ['Needle Burst · three-way spray', 'Vine Lash · long whip, strong tip',
          'Vine Hook · rising spin', 'Bramble Guard · counter a hit'],
  },
  pinwheel: {
    name: 'Gale', role: 'Wind', blurb: 'Hits lightly but shoves hard. Blow them off the edge.',
    color: '#b79cff', alts: ['#b79cff', '#ffb38a', '#8fdcbc', '#ff9fc4'],
    size: 0.96, speed: 520, weight: 0.9, jump: 930, airJumps: 2, grav: 0.9, fall: 880,
    dmg: 0.9, kb: 1, reach: 1, tempo: 0.95, bars: [2, 4, 2],
    kit: ['Gust Shot · wind that shoves', 'Tailwind · flying dash',
          'Updraft · spinning rise', 'Cyclone · blow everyone away'],
  },
};
export const ORDER = ['mochi', 'ember', 'boulder', 'volt', 'bubbles', 'thorn', 'pinwheel'];

// The stages, in the order the lobby cycles through them. Their art is in the sprite sheets.
export const STAGES = {
  meadow: { name: 'Paper Meadow' },
  mesa: { name: 'Sunset Mesa' },
  peaks: { name: 'Snowfold Peaks' },
};
export const STAGE_ORDER = Object.keys(STAGES);

// A fighter's picture: a 'face' (head and shoulders) or a 'poster' (an action pose), cut by the .pic CSS rules from
// the sprite sheets, which hold the fighters in ORDER across and their four colors down. A color that isn't one of
// the fighter's alts shows the first.
export const picStyle = (id, color) =>
  `--i:${ORDER.indexOf(id)};--alt:${Math.max(0, CHARS[id].alts.indexOf(color))}`;
// `label` is what a screen reader says; without one the picture is hidden from it as decoration. `style` adds more
// inline style.
export function picture(kind, id, { color, label, style = '' } = {}) {
  const say = label ? `role="img" aria-label="${label}"` : 'aria-hidden="true"';
  return `<span class="pic ${kind}" style="${picStyle(id, color)};${style}" ${say}></span>`;
}
