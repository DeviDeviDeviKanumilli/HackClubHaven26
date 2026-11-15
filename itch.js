// npm run itch: builds knockout-itch.zip, the game for itch.io (an HTML game, played in the browser). itch only hosts
// files, so this is the big screen on its own: keyboard, controllers and CPUs. The page is marked offline so it never
// looks for server.js, and the phone page and the music (other people's tracks) stay out.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const OUT = 'dist/itch';
const ZIP = 'knockout-itch.zip';
const LEAVE_OUT = ['play.html', 'play.webmanifest', 'phone.js', 'phone.css', 'assets/music'];

fs.rmSync(OUT, { recursive: true, force: true });
fs.rmSync(ZIP, { force: true });
fs.cpSync('public', OUT, {
  recursive: true,
  filter: (src) => !LEAVE_OUT.some((skip) => src === `public/${skip}`) && !src.endsWith('.DS_Store'),
});
const page = `${OUT}/index.html`;
fs.writeFileSync(
  page,
  fs.readFileSync(page, 'utf8').replace('<html lang="en">', '<html lang="en" data-offline>'),
);
execFileSync('zip', ['-r', '-X', '-q', `../../${ZIP}`, '.'], { cwd: OUT });
console.log(
  `${ZIP}: ${(fs.statSync(ZIP).size / 1e6).toFixed(1)} MB, ${fs.readdirSync(OUT, { recursive: true }).length} files`,
);
