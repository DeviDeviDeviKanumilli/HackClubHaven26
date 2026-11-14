// Knockout's server. The game itself runs in the big-screen browser tab (public/main.js); this serves the pages,
// relays phone input to that tab over WebSockets, and opens an HTTPS tunnel so phones on any network can join.
import http from 'http';
import fs from 'fs';
import os from 'os';
import dns from 'dns';
import path from 'path';
import { spawn, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { bin as cloudflaredBin } from 'cloudflared';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';

const PORT = Number(process.env.PORT) || 4747;
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const MAX_PLAYERS = 40;
const GRACE_MS = 4000; // how long a dropped phone keeps its fighter
const MAX_MESSAGES_PER_SECOND = 150; // a phone sends about 60 while the stick moves

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

function lanIp() {
  const all = Object.values(os.networkInterfaces()).flat();
  return all.find((i) => i.family === 'IPv4' && !i.internal)?.address || 'localhost';
}

let tunnelUrl = null;
const lanUrl = `http://${lanIp()}:${PORT}`;
const joinUrl = () => `${tunnelUrl || lanUrl}/play`;

// Pages and the join details

function sendFile(req, res, pathname) {
  // only files inside public/, and only the kinds of file the game is made of
  const file = path.normalize(path.join(PUBLIC, pathname));
  const type = TYPES[path.extname(file)];
  let stat = null;
  if (type && file.startsWith(PUBLIC + path.sep)) stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat || !stat.isFile()) {
    res.writeHead(404).end('Not found');
    return;
  }
  // fonts never change; everything else is revalidated, and a phone that already has it gets a tiny 304
  const etag = `W/"${stat.size}-${Math.round(stat.mtimeMs)}"`;
  const cache = type === TYPES['.woff2'] ? 'public, max-age=31536000, immutable' : 'no-cache';
  const head = { 'Content-Type': type, 'Cache-Control': cache, ETag: etag };
  if (req.headers['if-none-match'] === etag) res.writeHead(304, head).end();
  else res.writeHead(200, head).end(fs.readFileSync(file));
}

const PAGES = { '/': '/index.html', '/play': '/play.html' };

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  const fresh = { 'Cache-Control': 'no-store' };
  if (pathname === '/info') {
    const info = {
      joinUrl: joinUrl(),
      secure: !!tunnelUrl,
      tunnelPending: wantTunnel && !tunnelUrl && !tunnelFailed,
      tunnelDown: tunnelDown(),
    };
    res.writeHead(200, { 'Content-Type': 'application/json', ...fresh }).end(JSON.stringify(info));
  } else if (pathname === '/qr.svg') {
    const svg = await QRCode.toString(joinUrl(), { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', ...fresh }).end(svg);
  } else {
    sendFile(req, res, PAGES[pathname] || pathname);
  }
});

// The relay: one big screen (the host) and up to MAX_PLAYERS phones

const wss = new WebSocketServer({ server, maxPayload: 2048 });
let host = null;
const phones = new Map(); // pid -> { ws, name, ch, grace }

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}
const toHost = (obj) => send(host, obj);

// Nothing a phone sends is passed on as it came: every field is clamped or checked first.
const cleanAxis = (v) => (Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0);
const cleanCh = (s) => (/^[a-z]{2,12}$/.test(s) ? s : 'mochi');
const cleanName = (s) =>
  String(s || '')
    .replace(/[\u0000-\u001f<>]/g, '')
    .trim()
    .slice(0, 12) || 'Player';

// Counts each socket's messages, a second at a time. Past the cap they are dropped, unless the socket is the host.
function overRateLimit(ws) {
  const now = Date.now();
  if (now - (ws.windowStart || 0) > 1000) {
    ws.windowStart = now;
    ws.count = 0;
  }
  ws.count++;
  return ws.count > MAX_MESSAGES_PER_SECOND && ws.role !== 'host';
}

// Only the machine running the server may be the big screen: a loopback connection that didn't come through the
// tunnel (cloudflared connects from loopback too, but always adds forwarding headers).
function mayBeHost(req) {
  const viaTunnel = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'];
  const loopback = /^(127\.|::1$|::ffff:127\.)/.test(req.socket.remoteAddress || '');
  return (loopback && !viaTunnel) || !!process.env.ALLOW_REMOTE_HOST;
}

function becomeHost(ws, req) {
  if (!mayBeHost(req)) {
    send(ws, { t: 'denied', at: `http://localhost:${PORT}` });
    ws.close();
    return;
  }
  ws.role = 'host';
  // a newer tab takes over; the old one is told, so the two don't trade places forever
  if (host && host !== ws) {
    send(host, { t: 'replaced' });
    host.close();
  }
  host = ws;
  for (const [id, phone] of phones) send(ws, { t: 'join', id, name: phone.name, ch: phone.ch });
}

function becomePhone(ws, m) {
  const pid = String(m.pid || '');
  if (!/^[\w-]{6,40}$/.test(pid)) {
    ws.close();
    return;
  }
  // a phone that reconnects takes its old place back, even when the room is full
  const old = phones.get(pid);
  if (!old && phones.size >= MAX_PLAYERS) {
    send(ws, { t: 'full' });
    ws.close();
    return;
  }
  if (old) {
    clearTimeout(old.grace);
    if (old.ws !== ws) old.ws.close();
  }
  ws.role = 'phone';
  ws.pid = pid;
  const phone = { ws, name: cleanName(m.name), ch: cleanCh(m.ch), grace: null };
  phones.set(pid, phone);
  toHost({ t: 'join', id: pid, name: phone.name, ch: phone.ch });
  if (!host) send(ws, { t: 'nohost' });
}

function fromPhone(ws, m) {
  if (m.t === 'i') {
    // b: the four buttons, one bit each
    toHost({ t: 'i', id: ws.pid, x: cleanAxis(m.x), y: cleanAxis(m.y), b: m.b & 15 });
  } else if (m.t === 'ping') {
    send(ws, { t: 'pong', c: Number(m.c) || 0 }); // the phone times the round trip to show its lag
  } else if (m.t === 'ch' && phones.has(ws.pid)) {
    const ch = cleanCh(m.ch);
    phones.get(ws.pid).ch = ch;
    toHost({ t: 'ch', id: ws.pid, ch });
  } else if (m.t === 'ready') {
    toHost({ t: 'ready', id: ws.pid, on: !!m.on });
  }
}

// The big screen talks to one phone at a time ({ t: 'to', id, m }), or takes one out of the game ({ t: 'kick', id }):
// that phone goes back to its join screen, and can come straight back in from there.
function fromHost(m) {
  const phone = phones.get(String(m.id));
  if (!phone) return;
  if (m.t === 'to') {
    send(phone.ws, m.m);
  } else if (m.t === 'kick') {
    clearTimeout(phone.grace);
    phones.delete(String(m.id));
    send(phone.ws, { t: 'out' });
    phone.ws.close();
  }
}

// A phone that drops (a locked screen, a tunnel blip) lets go of its buttons at once, but keeps its fighter for a few
// seconds in case it comes straight back.
function phoneClosed(ws) {
  const phone = phones.get(ws.pid);
  if (!phone || phone.ws !== ws) return;
  toHost({ t: 'i', id: ws.pid, x: 0, y: 0, b: 0 });
  phone.grace = setTimeout(() => {
    if (phones.get(ws.pid) !== phone) return;
    phones.delete(ws.pid);
    toHost({ t: 'leave', id: ws.pid });
  }, GRACE_MS);
}

wss.on('connection', (ws, req) => {
  ws.alive = true;
  ws.on('pong', () => {
    ws.alive = true;
  });
  ws.on('error', () => {});
  ws.on('close', () => {
    if (ws === host) host = null;
    if (ws.role === 'phone') phoneClosed(ws);
  });
  ws.on('message', (raw) => {
    if (overRateLimit(ws)) return;
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (!m || typeof m.t !== 'string') return;
    if (ws.role === 'phone') fromPhone(ws, m);
    else if (ws.role === 'host') fromHost(m);
    else if (m.t === 'host') becomeHost(ws, req);
    else if (m.t === 'join') becomePhone(ws, m);
  });
});

// connections that stop answering pings are dropped
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) ws.terminate();
    ws.alive = false;
    ws.ping();
  }
}, 10000);

// The tunnel: a join link that works from any network

const wantTunnel = !process.env.NO_TUNNEL;
let tunnelFailed = false;
let tunnelProc = null;
// Which of cloudflared's connections to Cloudflare are up. With none (the network changed, a VPN came on) the join
// link answers phones with "Error 1033" until one reconnects, so the big screen warns instead.
const tunnelConns = new Set();
let tunnelDownSince = 0;
const tunnelDown = () => !!tunnelUrl && tunnelConns.size === 0 && Date.now() - tunnelDownSince > 3000;

function findCloudflared() {
  if (fs.existsSync(cloudflaredBin)) return cloudflaredBin;
  try {
    return execSync('command -v cloudflared', { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

// A fresh tunnel hostname takes a few seconds to appear in DNS. A QR code shown before then makes phones cache a
// "not found" answer, so the link is only announced once public DNS can see it (or after 30 s, come what may).
function publishWhenLive(url) {
  const resolver = new dns.Resolver();
  resolver.setServers(['1.1.1.1', '8.8.8.8']);
  const started = Date.now();
  const publish = () => {
    tunnelUrl = url;
    console.log(`  Phones join at:  ${joinUrl()}   (or scan the QR on the big screen)\n`);
  };
  const check = () =>
    resolver.resolve4(new URL(url).hostname, (err, addrs) => {
      if (!err && addrs.length) setTimeout(publish, 1500);
      else if (Date.now() - started > 30000) publish();
      else setTimeout(check, 700);
    });
  check();
}

function startTunnel() {
  const bin = findCloudflared();
  if (!bin) {
    tunnelFailed = true;
    console.log('\n  ! cloudflared not found, so phones can only join from the same Wi-Fi.');
    console.log('    Run `npm install` again, or `brew install cloudflared`.\n');
    return;
  }
  // HTTP/2, not cloudflared's default QUIC: QUIC is UDP, which many VPNs and school or office networks block
  const protocol = process.env.TUNNEL_PROTOCOL || 'http2';
  const args = ['tunnel', '--url', `http://localhost:${PORT}`, '--no-autoupdate', '--protocol', protocol];
  tunnelProc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  // cloudflared says everything in its log: the link it was given, and each connection coming up or going down
  let link = null;
  const onLog = (chunk) => {
    const text = String(chunk);
    const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (match && !link) {
      link = match[0];
      publishWhenLive(link);
    }
    trackConnections(text);
  };
  tunnelProc.stdout.on('data', onLog);
  tunnelProc.stderr.on('data', onLog);
  tunnelProc.on('exit', () => {
    console.log(
      link
        ? '  ! Tunnel closed. Restart the server to get a new join link.'
        : `  ! Tunnel failed to start. Same-Wi-Fi fallback: ${lanUrl}/play\n`,
    );
    tunnelUrl = null;
    tunnelFailed = true;
  });
}

const CONNECTION_UP = /Registered tunnel connection/;
const CONNECTION_DOWN =
  /Connection terminated|Unregistered tunnel connection|Serve tunnel error|Failed to dial/;

// Follows cloudflared's connections in a piece of its log, and says when the join link goes down or comes back.
function trackConnections(text) {
  for (const line of text.split('\n')) {
    const match = line.match(/connIndex=(\d+)/);
    if (!match) continue;
    const conn = match[1];
    const before = tunnelConns.size;
    if (CONNECTION_UP.test(line)) tunnelConns.add(conn);
    else if (CONNECTION_DOWN.test(line)) tunnelConns.delete(conn);
    if (before > 0 && tunnelConns.size === 0) {
      tunnelDownSince = Date.now();
      console.log('  ! Lost the connection to Cloudflare, so the join link is down. Retrying…');
    } else if (before === 0 && tunnelConns.size > 0 && tunnelDownSince) {
      tunnelDownSince = 0;
      console.log('  Join link is back.');
    }
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (tunnelProc) tunnelProc.kill();
    process.exit(0);
  });
}

server.listen(PORT, () => {
  console.log(`\n  KNOCKOUT is running.`);
  console.log(`  Big screen:      http://localhost:${PORT}   <- open this on the laptop/TV`);
  if (wantTunnel) {
    console.log('  Opening a secure link for phones…');
    startTunnel();
  } else {
    console.log(`  Phones join at:  ${lanUrl}/play   (same Wi-Fi)\n`);
  }
});
