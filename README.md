# Knockout

A party platform fighter for the whole room. A laptop or TV shows the arena; everyone else scans a QR code and their
phone turns into the controller. No app, 2 to 40 players. You can also play it on one keyboard, or with Xbox-style
controllers, against each other or the CPU.

Seven fighters, three stages, items, stage events (wind, tumbleweeds, snowballs), in a paper cut-out style. The art is
a set of sprite sheets and the sound effects are synthesised in code. The music is a shuffled playlist of
phonk tracks, the mp3s in `public/assets/music/` (add or remove any), and it speeds up as a match heats
up.

## Run it

```sh
npm install
npm start        # opens a Cloudflare tunnel, so phones on any network can join
npm run local    # no tunnel: phones must be on the same Wi-Fi (lowest lag)
```

Open `http://localhost:4747` on the big screen and pick **Phones** or **Keyboard**. Click or press a key once to turn
the sound on (browsers insist).

Anyone with the join link can join while the server runs. Only the machine running the server can be the big screen;
`ALLOW_REMOTE_HOST=1` lifts that.

**Phones get "Error 1033"?** Cloudflare can't reach the tunnel, usually because a VPN came on or the network changed.
It reconnects by itself and the join card says so meanwhile. If it stays down, restart the server for a new link.

## Controls

Hits raise your %. The higher it is, the further you fly. Get knocked off the screen and you lose a life.

| | Phone | Keyboard P1 | Keyboard P2 | Controller |
| --- | --- | --- | --- | --- |
| Move | stick | `A` `D` | `←` `→` | stick or d-pad |
| Jump | push the stick up, or Jump | `W` | `↑` | A |
| Attack | Attack | `F` | `K` | RT (or X) |
| Special | Special | `G` | `L` | LT (or B) |
| Shield | Shield | `H` | `;` | RB (or LB) |

- **Attack** is a different move for each stick direction, on the ground and in the air. Hold it to charge.
- **Special** has four: neutral, side, up (your recovery) and down.
- **Shield + Attack** grabs; push the stick to throw. Shield plus a flick dodges.
- **Combos:** the moment a hit lands you can go straight into a jump, a special or a *different* attack.
- Tap jump for a short hop. Flick down in the air to fast fall. You can jump off walls and grab ledges.

On the big screen: `Enter` starts, `B`/`N` add and remove a CPU, `T` changes stage, `Esc` is the menu (lives, time
limit, items, stage events, CPU level, volume), `M` mutes, `Backspace` goes back to the title. On a controller, Start
is the menu, and the fighter select shows the rest. A controller that drops out keeps its fighter for 15 seconds.

On phones, ⇄ swaps the stick and buttons for left-handers, and ⛶ goes full screen (on an iPhone: Share → Add to Home
Screen, since Safari won't do it for a web page). The number in the corner is your lag.

## Code

```
server.js            static files, the WebSocket relay between phones and the big screen, the tunnel
test.js              the tests (npm test)
public/
  index.html         the big screen (host.css); it all runs in this tab, from main.js
  main.js            boot and the frame loop (120 Hz simulation)
  game.js            state, settings, moves, fighters, combat, bots, stage events, the match flow
  draw.js            the canvas: picks sprites off the sheets and composes each frame
  ui.js              HUD, pause menu, title and keyboard fighter select
  input.js           keyboard, controllers, and phones through the relay
  sound.js           sound effects, the music, controller rumble
  roster.js          the fighters (shared with the phone)
  play.html          the phone (phone.css, phone.js)
  assets/            sprite sheets and sprites.json (where each frame sits), fonts, icons, music/
```

Formatted with Prettier (`npm run format`).

## Tests

`npm test` runs the real game code headless with a fake clock: seeded CPU matches on every stage, a phone joining and
readying up, sudden death, keyboard mode, a 143-step walkthrough of the whole game on a fake controller, and a script
that checks every move and combo. Same seed, same match, so it doubles as a
regression test. `node test.js 4 240 7` plays a single headless game (4 CPUs, 240 s, seed 7); the flags are listed at
the top of test.js.

Handy URL flags for the big screen: `?mode=keys|phones`, `?bots=4`, `&go`, `&seed=7`, `&stage=mesa`, `&ff=20`
(fast-forward), `&until=ko` (stop after an event), `&freeze`. `/play?demo` opens the phone pad without a game.

## Tools

We used LLMs on this. Some of the code was generated, and some of it was autocomplete while writing.
