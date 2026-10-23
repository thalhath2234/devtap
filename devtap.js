#!/usr/bin/env node
'use strict';
// devtap — a local reverse proxy that records every request/response,
// WebSocket message and server log line, and shows them in a live web UI.
// Zero dependencies: Node 18+.

const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { performance } = require('node:perf_hooks');
const discover = require('./discover');

const HELP = `
devtap: see every request, response and log line of your local server

Usage
  devtap                       pick one of your running servers from a list
  devtap <target> [options]    connect to a server that's already running
  devtap <target> [options] -- <command>
                               start your server through devtap (captures all its output)
  devtap ports                 list servers listening on this machine

  <target>  port, host:port or URL, e.g. 8080, localhost:8080, http://127.0.0.1:5000

Logs (found automatically when possible; these flags choose them yourself)
  -l, --log <file>         follow a log file (repeatable)
      --docker <name>      follow a container's logs
      --journal <unit>     follow a systemd service's logs
      --log-cmd "<cmd>"    run any command and show its output as logs (repeatable)
      --stdin              read logs piped into devtap (on automatically when you pipe)
      --attach             capture what the running server prints to its terminal
                           (uses strace; may ask for your sudo password)
      --pid <n>            with --attach: the process to attach to (default: the one on <target>)
      --no-auto            don't look for logs automatically

Options
  -p, --port <n>       proxy port (default 3689, or the next free one). Send your traffic here.
  -u, --ui <n>         inspector port (default 9090, or the next free one)
  -o, --open           open the inspector in your browser
      --swap           keep your app's port: devtap takes over <target>'s port and starts your
                       server (after --) on a free port, passed to it as $PORT
      --port-env <n>   with --swap: the env var your server reads its port from (default PORT)
      --host <addr>    address the proxy binds to (default 127.0.0.1; 0.0.0.0 to reach it from your phone)
      --max-body <kb>  body bytes kept per request/response (default 2048)
      --keep <n>       items kept in memory (default 5000)
  -q, --quiet          don't echo requests / server output in this terminal
  -h, --help

Examples
  devtap 8080                         traffic, plus logs if devtap can find them
  devtap 8080 --attach                also capture what the server prints to its terminal
  devtap 8080 --docker api
  devtap 8080 --journal myapp
  docker compose logs -f api | devtap 8080
  devtap 8080 -- go run .
  devtap 8080 --swap -- go run .     frontend keeps using :8080; the server moves to a free port
`;

// ---------------------------------------------------------------- options

function die(msg) {
  console.error(`devtap: ${msg}`);
  process.exit(1);
}

function parseTarget(t) {
  if (/^\d+$/.test(t)) t = `http://localhost:${t}`;
  else if (!/^[a-z]+:\/\//i.test(t)) t = `http://${t}`;
  let u;
  try { u = new URL(t); } catch { die(`invalid target "${t}"`); }
  const secure = u.protocol === 'https:';
  const hostname = u.hostname.replace(/^\[|\]$/g, '');
  return {
    href: `${u.protocol}//${u.host}`,
    secure,
    hostname,
    host: u.host,
    port: Number(u.port) || (secure ? 443 : 80),
    local: ['localhost', '127.0.0.1', '::1'].includes(hostname),
  };
}

function parseArgs(argv) {
  const opts = {
    port: 3689, ui: 9090, host: '127.0.0.1', cmd: null, maxBody: 2048 * 1024, keep: 5000, quiet: false,
    logs: [], docker: [], journal: [], logCmds: [], stdin: false, attach: false, pid: null, auto: true, open: false,
    swap: false, portEnv: 'PORT',
    portSet: false, uiSet: false, subcommand: null,
  };
  const dd = argv.indexOf('--');
  if (dd !== -1) { opts.cmd = argv.slice(dd + 1); argv = argv.slice(0, dd); }
  const num = (a, v) => { const n = Number(v); if (!Number.isInteger(n) || n < 0) die(`${a} needs a number, got "${v}"`); return n; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined) die(`${a} needs a value`); return v; };
    switch (a) {
      case '-h': case '--help': console.log(HELP); process.exit(0); break;
      case '-p': case '--port': opts.port = num(a, next()); opts.portSet = true; break;
      case '-u': case '--ui': opts.ui = num(a, next()); opts.uiSet = true; break;
      case '-l': case '--log': opts.logs.push(next()); break;
      case '--docker': opts.docker.push(next()); break;
      case '--journal': opts.journal.push(next()); break;
      case '--log-cmd': opts.logCmds.push(next()); break;
      case '--stdin': opts.stdin = true; break;
      case '--attach': opts.attach = true; break;
      case '--pid': opts.pid = num(a, next()); opts.attach = true; break;
      case '--no-auto': opts.auto = false; break;
      case '-o': case '--open': opts.open = true; break;
      case '--swap': opts.swap = true; break;
      case '--port-env': opts.portEnv = next(); break;
      case '--host': opts.host = next(); break;
      case '--max-body': opts.maxBody = num(a, next()) * 1024; break;
      case '--keep': opts.keep = num(a, next()); break;
      case '-q': case '--quiet': opts.quiet = true; break;
      default:
        if (a.startsWith('-')) die(`unknown option ${a} (see devtap --help)`);
        if (!opts.target && !opts.subcommand && a === 'ports') { opts.subcommand = 'ports'; break; }
        if (opts.target) die(`unexpected argument "${a}"`);
        opts.target = a;
    }
  }
  if (!opts.cmd?.length) opts.cmd = null;
  if (opts.swap && !opts.cmd) die('--swap needs the command that starts your server, e.g. devtap 8080 --swap -- go run .');
  if (opts.swap && opts.portSet) die("--swap uses the target's port for the proxy, so don't pass --port with it");
  // Logs piped in (`docker logs -f api | devtap 8080`) are picked up without --stdin.
  if (!opts.cmd && !process.stdin.isTTY) {
    try { const st = fs.fstatSync(0); if (st.isFIFO() || st.isFile()) opts.stdin = true; } catch {}
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
let target, transport, agent, config;

function setTarget(raw) {
  target = parseTarget(raw);
  transport = target.secure ? https : http;
  agent = new transport.Agent({ keepAlive: true, maxSockets: 256, ...(target.secure && { rejectUnauthorized: false }) });
}

// ---------------------------------------------------------------- store + live feed

const items = new Map(); // id -> entry | log line, in arrival order
const clients = new Set(); // SSE responses
let seq = 0;

function remember(item) {
  items.set(item.id, item);
  while (items.size > opts.keep) items.delete(items.keys().next().value);
}

function broadcast(event, data) {
  if (!clients.size) return;
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

function summary(e) {
  if (e.kind === 'log') return e;
  return {
    id: e.id, kind: e.kind, ts: e.ts, method: e.method, url: e.url,
    status: e.res?.status ?? null,
    duration: e.duration ?? null,
    reqSize: e.messages ? e.wsSent : e._req.size,
    resSize: e.messages ? e.wsReceived : e._res.size,
    type: e.res ? shortType(e.res.headers['content-type']) : null,
    state: e.state, error: e.error ?? null,
    replay: e.reqHeaders['x-devtap-replay'] ? Number(e.reqHeaders['x-devtap-replay']) : null,
    msgCount: e.messages ? e.messages.length : undefined,
  };
}

function detail(e) {
  if (e.kind === 'log') return e;
  const d = {
    ...summary(e),
    httpVersion: e.httpVersion, client: e.client, ttfb: e.ttfb ?? null,
    req: { headers: e.reqHeaders, body: renderBody(e._req, e.reqHeaders) },
    res: e.res ? { ...e.res, body: renderBody(e._res, e.res.headers) } : null,
  };
  if (e.messages) d.messages = e.messages;
  return d;
}

function shortType(ct) {
  if (!ct) return null;
  const t = String(ct).split(';')[0].trim().toLowerCase();
  if (t.includes('json')) return 'json';
  if (t === 'text/html') return 'html';
  if (t === 'text/event-stream') return 'sse';
  if (t.includes('javascript')) return 'js';
  if (t === 'text/css') return 'css';
  if (t.startsWith('image/')) return t.slice(6).replace('svg+xml', 'svg');
  if (t.startsWith('font/')) return 'font';
  if (t.includes('xml')) return 'xml';
  if (t.startsWith('text/')) return 'text';
  return t.split('/')[1] || t;
}

// ---------------------------------------------------------------- body capture + decoding

function capture() {
  return {
    chunks: [], kept: 0, size: 0,
    push(c) {
      this.size += c.length;
      if (this.kept >= opts.maxBody) return;
      const part = this.kept + c.length > opts.maxBody ? c.subarray(0, opts.maxBody - this.kept) : c;
      this.chunks.push(part);
      this.kept += part.length;
    },
  };
}

function decompress(buf, encoding) {
  const Z = zlib.constants;
  for (const enc of encoding.split(',').map((s) => s.trim()).reverse()) {
    if (enc === 'gzip' || enc === 'x-gzip') buf = zlib.gunzipSync(buf, { finishFlush: Z.Z_SYNC_FLUSH });
    else if (enc === 'br') buf = zlib.brotliDecompressSync(buf, { finishFlush: Z.BROTLI_OPERATION_FLUSH });
    else if (enc === 'deflate') {
      try { buf = zlib.inflateSync(buf, { finishFlush: Z.Z_SYNC_FLUSH }); }
      catch { buf = zlib.inflateRawSync(buf, { finishFlush: Z.Z_SYNC_FLUSH }); }
    } else if (enc === 'zstd' && zlib.zstdDecompressSync) buf = zlib.zstdDecompressSync(buf);
    else if (enc && enc !== 'identity') throw new Error(`unsupported encoding "${enc}"`);
  }
  return buf;
}

const TEXT_TYPE = /^(text\/|application\/(json|[\w.+-]*\+json|javascript|ecmascript|xml|[\w.+-]*\+xml|x-www-form-urlencoded|graphql|x-ndjson)|image\/svg)/i;
const BINARY_TYPE = /^(image|audio|video|font)\/|octet-stream|zip|pdf|protobuf|grpc|wasm/i;

function looksLikeText(buf) {
  const n = Math.min(buf.length, 2048);
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0 || b < 7 || (b > 13 && b < 32 && b !== 27)) return false;
  }
  return true;
}

function renderBody(cap, headers) {
  if (!cap || cap.size === 0) return null;
  let buf = Buffer.concat(cap.chunks);
  const encoding = String(headers['content-encoding'] || '').toLowerCase().trim();
  const contentType = String(headers['content-type'] || '');
  const out = { size: cap.size, truncated: cap.size > cap.kept, encoding: encoding || null, contentType: contentType || null };
  if (encoding && encoding !== 'identity') {
    try { buf = decompress(buf, encoding); }
    catch (err) { out.decodeError = `couldn't decode ${encoding}: ${err.message}`; }
  }
  out.decodedSize = buf.length;
  const textual = TEXT_TYPE.test(contentType) || (!BINARY_TYPE.test(contentType) && looksLikeText(buf));
  if (textual && !out.decodeError) out.text = buf.toString('utf8');
  else out.base64 = buf.toString('base64');
  return out;
}

// ---------------------------------------------------------------- terminal output

const tty = process.stdout.isTTY;
const paint = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const fmtMs = (ms) => (ms == null ? '' : ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`);
const fmtBytes = (n) => (n < 1024 ? `${n}B` : n < 1048576 ? `${(n / 1024).toFixed(1)}kB` : `${(n / 1048576).toFixed(1)}MB`);

function printLine(e) {
  if (opts.quiet) return;
  const st = e.res?.status;
  const color = !st ? 31 : st >= 500 ? 31 : st >= 400 ? 33 : st >= 300 ? 36 : 32;
  const label = e.kind === 'ws' ? 'WS' : e.method;
  const url = e.url.length > 90 ? `${e.url.slice(0, 89)}…` : e.url;
  const extra = e.kind === 'ws' ? `${e.messages.length} msgs` : fmtBytes(e._res.size);
  console.log(`${paint(2, '[devtap]')} ${label.padEnd(6)} ${paint(color, st ?? 'ERR')} ${url} ${paint(2, `${fmtMs(e.duration)} ${extra}`)}${e.error ? ' ' + paint(31, e.error) : ''}`);
}

// ---------------------------------------------------------------- HTTP proxy

function newEntry(kind, req) {
  const e = {
    id: ++seq, kind, ts: Date.now(), method: req.method, url: req.url,
    httpVersion: req.httpVersion, client: req.socket.remoteAddress,
    reqHeaders: req.headers, state: 'pending',
  };
  Object.defineProperty(e, '_req', { value: capture(), writable: true });
  Object.defineProperty(e, '_res', { value: capture(), writable: true });
  remember(e);
  return e;
}

function upstreamHeaders(headers) {
  const h = { ...headers };
  if (!target.local) h.host = target.host;
  return h;
}

function reachError(err) {
  if (err.code === 'ECONNREFUSED') return `nothing is listening on ${target.host}`;
  if (err.code === 'ENOTFOUND') return `can't resolve ${target.hostname}`;
  return err.code || err.message;
}

let progressTimers = new Map();
function progress(e) {
  if (progressTimers.has(e.id)) return;
  progressTimers.set(e.id, setTimeout(() => {
    progressTimers.delete(e.id);
    if (e.state === 'pending' || e.state === 'open') broadcast('update', summary(e));
  }, 250));
}

function handleRequest(req, res) {
  const t0 = performance.now();
  const e = newEntry('http', req);
  broadcast('add', summary(e));

  let finished = false;
  const finish = (state, error) => {
    if (finished) return;
    finished = true;
    e.state = state;
    if (error) e.error = error;
    e.duration = performance.now() - t0;
    broadcast('update', summary(e));
    printLine(e);
  };

  const up = transport.request({
    hostname: target.hostname, port: target.port, method: req.method, path: req.url,
    headers: upstreamHeaders(req.headers), agent,
    ...(target.secure && { servername: target.hostname, rejectUnauthorized: false }),
  });

  req.on('data', (c) => e._req.push(c));
  req.pipe(up);

  up.on('response', (ur) => {
    e.ttfb = performance.now() - t0;
    e.res = { status: ur.statusCode, statusText: ur.statusMessage, headers: ur.headers };
    broadcast('update', summary(e));
    res.writeHead(ur.statusCode, ur.statusMessage, ur.rawHeaders);
    ur.on('data', (c) => { e._res.push(c); progress(e); });
    ur.pipe(res);
    ur.on('end', () => finish('done'));
    ur.on('close', () => {
      if (!ur.complete) { res.destroy(); finish('error', 'upstream closed the connection mid-response'); }
    });
  });

  up.on('error', (err) => {
    const msg = reachError(err);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`devtap: could not reach ${target.href}: ${msg}\n`);
    } else res.destroy();
    finish('error', msg);
  });

  res.on('close', () => {
    if (!finished) { up.destroy(); finish('aborted', 'client closed the connection before the response finished'); }
  });
}

// ---------------------------------------------------------------- WebSocket tap

class FrameParser {
  constructor(onMessage) {
    this.buf = Buffer.alloc(0);
    this.onMessage = onMessage;
    this.frag = null;
    this.dead = false;
  }

  push(chunk) {
    if (this.dead) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const compressed = (b[0] & 0x40) !== 0;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (b.length < 10) return;
        const big = b.readBigUInt64BE(2);
        if (big > 64n * 1024n * 1024n) { this.dead = true; return; } // too big to inspect; keep proxying
        len = Number(big); off = 10;
      }
      let mask = null;
      if (masked) { if (b.length < off + 4) return; mask = b.subarray(off, off + 4); off += 4; }
      if (b.length < off + len) return;
      const payload = Buffer.from(b.subarray(off, off + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = b.subarray(off + len);
      this.frame(fin, opcode, payload, compressed);
    }
  }

  frame(fin, opcode, payload, compressed) {
    if (opcode === 0) {
      if (!this.frag) return;
      this.frag.parts.push(payload);
      if (fin) {
        const f = this.frag;
        this.frag = null;
        this.onMessage(f.opcode, Buffer.concat(f.parts), f.compressed);
      }
      return;
    }
    if (opcode < 8 && !fin) { this.frag = { opcode, parts: [payload], compressed }; return; }
    this.onMessage(opcode, payload, compressed);
  }
}

const OPCODES = { 1: 'text', 2: 'binary', 8: 'close', 9: 'ping', 10: 'pong' };

function handleUpgrade(req, socket, head) {
  const t0 = performance.now();
  const e = newEntry('ws', req);
  e.messages = [];
  e.wsSent = 0;
  e.wsReceived = 0;
  broadcast('add', summary(e));

  let finished = false;
  const finish = (state, error) => {
    if (finished) return;
    finished = true;
    e.state = state;
    if (error) e.error = error;
    e.duration = performance.now() - t0;
    broadcast('update', summary(e));
    printLine(e);
  };

  const addMessage = (dir) => (opcode, payload, compressed) => {
    const m = { dir, ts: Date.now(), type: OPCODES[opcode] || `op${opcode}`, size: payload.length };
    if (dir === 'out') e.wsSent += payload.length; else e.wsReceived += payload.length;
    if (compressed) m.compressed = true;
    let data = payload;
    if (opcode === 8 && payload.length >= 2) {
      m.code = payload.readUInt16BE(0);
      data = payload.subarray(2);
    }
    if (data.length > opts.maxBody) { data = data.subarray(0, opts.maxBody); m.truncated = true; }
    if (opcode === 2 || compressed) m.base64 = data.toString('base64');
    else m.text = data.toString('utf8');
    e.messages.push(m);
    if (e.messages.length > 5000) e.messages.shift();
    broadcast('ws', { id: e.id, msg: m });
    progress(e);
  };

  // Rebuild the handshake. permessage-deflate is stripped so frames stay readable.
  const lines = [`${req.method} ${req.url} HTTP/1.1`];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const k = req.rawHeaders[i];
    const lk = k.toLowerCase();
    if (lk === 'sec-websocket-extensions') continue;
    lines.push(`${k}: ${lk === 'host' && !target.local ? target.host : req.rawHeaders[i + 1]}`);
  }
  const handshake = `${lines.join('\r\n')}\r\n\r\n`;

  const upSock = target.secure
    ? tls.connect({ host: target.hostname, port: target.port, servername: target.hostname, rejectUnauthorized: false })
    : net.connect({ host: target.hostname, port: target.port });
  upSock.write(handshake);
  if (head?.length) upSock.write(head);

  let pending = Buffer.alloc(0);
  const onHead = (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    const idx = pending.indexOf('\r\n\r\n');
    if (idx === -1) return;
    upSock.off('data', onHead);

    const [statusLine, ...headerLines] = pending.subarray(0, idx).toString('latin1').split('\r\n');
    const m = /^HTTP\/\d(?:\.\d)? (\d{3}) ?(.*)$/.exec(statusLine);
    const headers = {};
    for (const l of headerLines) {
      const i = l.indexOf(':');
      if (i <= 0) continue;
      const k = l.slice(0, i).trim().toLowerCase();
      const v = l.slice(i + 1).trim();
      headers[k] = k in headers ? `${headers[k]}, ${v}` : v;
    }
    e.ttfb = performance.now() - t0;
    e.res = { status: m ? Number(m[1]) : 0, statusText: m ? m[2] : '', headers };

    socket.write(pending);
    const rest = pending.subarray(idx + 4);
    if (e.res.status === 101) {
      e.state = 'open';
      const fromServer = new FrameParser(addMessage('in'));
      const fromClient = new FrameParser(addMessage('out'));
      if (rest.length) fromServer.push(rest);
      upSock.on('data', (d) => fromServer.push(d));
      socket.on('data', (d) => fromClient.push(d));
    } else {
      if (rest.length) e._res.push(rest);
      upSock.on('data', (d) => e._res.push(d));
    }
    broadcast('update', summary(e));
    upSock.pipe(socket);
    socket.pipe(upSock);
  };
  upSock.on('data', onHead);

  upSock.on('error', (err) => {
    if (!e.res) socket.end(`HTTP/1.1 502 Bad Gateway\r\ncontent-type: text/plain\r\n\r\ndevtap: could not reach ${target.href}: ${reachError(err)}\n`);
    else socket.destroy();
    finish('error', reachError(err));
  });
  socket.on('error', () => upSock.destroy());
  upSock.on('close', () => { socket.destroy(); finish(e.res?.status === 101 ? 'closed' : e.res ? 'done' : 'error'); });
  socket.on('close', () => { upSock.destroy(); finish(e.res?.status === 101 ? 'closed' : e.res ? 'done' : 'aborted'); });
}

// ---------------------------------------------------------------- logs (child process + files)

const logWatchers = new Set();

function addLog(source, stream, text) {
  const item = { id: ++seq, kind: 'log', ts: Date.now(), source, stream, text };
  remember(item);
  broadcast('add', item);
  for (const watch of logWatchers) watch(item);
}

const ANSI_RE = /\x1b\[[\d;?]*[A-Za-z]/g;

function lineSplitter(onLine) {
  let rest = '';
  return {
    write(chunk) {
      rest += chunk.toString('utf8');
      const lines = rest.split(/\r?\n/);
      rest = lines.pop();
      for (const l of lines) {
        const line = l.includes('\r') ? l.slice(l.lastIndexOf('\r') + 1) : l; // progress bars redraw with \r
        if (line.replace(ANSI_RE, '').trim()) onLine(line);
      }
    },
    flush() { if (rest.trim()) onLine(rest); rest = ''; },
  };
}

const procs = []; // processes devtap started; stopped on exit
let serverProc = null;

function note(msg) {
  addLog('devtap', 'system', msg);
}

function pipeLines(stream, source, name, echo) {
  const split = lineSplitter((line) => addLog(source, name, line));
  stream.on('data', (d) => { if (echo && !opts.quiet) process[name].write(d); split.write(d); });
  stream.on('end', () => split.flush());
}

function startServer() {
  const [cmd, ...args] = opts.cmd;
  const name = path.basename(cmd.split(/\s+/)[0]);
  serverProc = spawn(cmd, args, {
    stdio: ['inherit', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: process.env.FORCE_COLOR ?? '1', ...(opts.swap && { [opts.portEnv]: String(target.port) }) },
    shell: args.length === 0 && /\s/.test(cmd),
    detached: true, // own process group, so stopping devtap also stops what `go run` / `npm run` spawned
  });
  serverProc.group = true;
  procs.push(serverProc);
  pipeLines(serverProc.stdout, name, 'stdout', true);
  pipeLines(serverProc.stderr, name, 'stderr', true);
  serverProc.on('error', (err) => note(`failed to start "${opts.cmd.join(' ')}": ${err.message}`));
  serverProc.on('exit', (code, signal) => {
    note(`${name} exited (${signal || `code ${code}`})`);
    if (!opts.quiet) console.log(paint(2, `[devtap] ${name} exited (${signal || `code ${code}`}); proxy and inspector stay up`));
  });
  note(`started: ${opts.cmd.join(' ')}`);
}

// Run a command whose output is a log stream (docker logs -f, journalctl -f, ...).
function followCommand(label, cmd, args, { shell = false } = {}) {
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], shell, detached: true });
  p.group = true;
  procs.push(p);
  pipeLines(p.stdout, label, 'stdout');
  pipeLines(p.stderr, label, 'stderr');
  p.on('error', (err) => note(`couldn't run ${cmd}: ${err.message}`));
  p.on('exit', (code, signal) => { if (!shuttingDown) note(`${label} log stream ended (${signal || `code ${code}`})`); });
  return p;
}

function followDocker(name) {
  followCommand(name, 'docker', ['logs', '-f', '--tail', '0', name]);
}

function followJournal(unit, user) {
  followCommand(unit.replace(/\.service$/, ''), 'journalctl', [user ? '--user-unit' : '-u', unit, '-f', '-n', '0', '-o', 'cat']);
}

function followStdin() {
  pipeLines(process.stdin, 'stdin', 'stdout');
}

function tailFile(file) {
  const abs = path.resolve(file);
  const name = path.basename(abs);
  let pos = 0;
  try { pos = fs.statSync(abs).size; } catch { note(`waiting for ${abs} to appear`); }
  const split = lineSplitter((line) => addLog(name, 'file', line));
  let reading = false;
  const read = () => {
    if (reading) return;
    fs.stat(abs, (err, st) => {
      if (err) return;
      if (st.size < pos) pos = 0; // truncated / rotated
      if (st.size === pos) return;
      reading = true;
      const s = fs.createReadStream(abs, { start: pos, end: st.size - 1 });
      pos = st.size;
      s.on('data', (d) => split.write(d));
      s.on('close', () => { reading = false; });
    });
  };
  fs.watchFile(abs, { interval: 300 }, read);
}

const INSTALL_STRACE = 'Install it with your package manager (Arch: sudo pacman -S strace · Debian/Ubuntu: sudo apt install strace · Fedora: sudo dnf install strace) and run devtap again.';

// Capture what an already-running process writes to stdout/stderr by tracing its write() calls.
function attach(pid) {
  const info = discover.procInfo(pid);
  if (!info) return { ok: false, msg: `no process with pid ${pid}` };
  if (process.platform !== 'linux') return { ok: false, msg: '--attach only works on Linux' };
  if (!discover.which('strace')) return { ok: false, msg: `--attach needs strace, which isn't installed. ${INSTALL_STRACE}` };
  const args = ['-f', '-qq', '-p', String(pid), '-e', 'trace=write,writev', '-e', 'signal=none', '-s', '65536'];
  const needRoot = process.getuid?.() !== 0 && discover.ptraceScope() > 0;
  if (needRoot && !opts.quiet) console.log(paint(33, `  Attaching to ${info.name} (pid ${pid}) needs root on this machine, so sudo may ask for your password.`));
  const p = spawn(needRoot ? 'sudo' : 'strace', needRoot ? ['strace', ...args] : args, { stdio: [needRoot ? 'inherit' : 'ignore', 'ignore', 'pipe'] });
  procs.push(p);
  const out = { 1: lineSplitter((l) => addLog(info.name, 'stdout', l)), 2: lineSplitter((l) => addLog(info.name, 'stderr', l)) };
  const trace = lineSplitter((line) => {
    const w = discover.parseStraceLine(line);
    if (w) out[w.fd].write(w.data);
    else if (/^(strace|sudo): /.test(line)) { note(line); if (!opts.quiet) console.log(paint(33, `  ${line}`)); }
  });
  p.stderr.on('data', (d) => trace.write(d));
  p.on('error', (err) => note(`couldn't start strace: ${err.message}`));
  p.on('exit', (code) => { if (!shuttingDown) note(`stopped capturing ${info.name}'s output${code ? ` (strace exited with code ${code})` : ''}`); });
  note(`capturing everything ${info.name} (pid ${pid}) prints`);
  return { ok: true, msg: `${info.name} (pid ${pid}) terminal output, via strace` };
}

function restartHint(proc, launcher) {
  return `devtap ${target.port} -- ${launcher ? launcher.cmd : proc.cmd}`;
}

// Returns lines for the startup banner: [{ ok, text }]
function setupLogs() {
  const lines = [];
  if (opts.cmd) { startServer(); lines.push({ ok: true, text: `output of ${opts.cmd.join(' ')}` }); }
  for (const f of opts.logs) { tailFile(f); lines.push({ ok: true, text: `file ${path.resolve(f)}` }); }
  for (const c of opts.docker) { followDocker(c); lines.push({ ok: true, text: `docker logs ${c}` }); }
  for (const u of opts.journal) {
    const unit = u.endsWith('.service') ? u : `${u}.service`;
    followJournal(unit, false);
    lines.push({ ok: true, text: `journalctl -u ${unit}` });
  }
  for (const c of opts.logCmds) { followCommand(c.split(/\s+/)[0], c, [], { shell: true }); lines.push({ ok: true, text: `output of ${c}` }); }
  if (opts.stdin) { followStdin(); lines.push({ ok: true, text: 'piped input (stdin)' }); }

  const chosen = lines.length > 0;
  const canInspect = target.local && process.platform !== 'win32';
  const found = canInspect && (opts.attach || (opts.auto && !chosen)) ? discover.logSourceFor(target.port) : null;

  if (opts.attach) {
    const pid = opts.pid ?? found?.proc?.pid;
    if (!pid) lines.push({ ok: false, text: `--attach: couldn't find a process of yours listening on :${target.port}. Pass one with --pid <n>.` });
    else { const r = attach(pid); lines.push({ ok: r.ok, text: r.msg }); }
    return lines;
  }
  if (chosen || !found) return lines;

  switch (found.kind) {
    case 'docker':
      followDocker(found.container.name);
      lines.push({ ok: true, text: `docker logs ${found.container.name}  ${paint(2, `(auto: container publishes :${target.port})`)}` });
      break;
    case 'journal':
      followJournal(found.unit.name, found.unit.user);
      lines.push({ ok: true, text: `journalctl ${found.unit.user ? '--user-unit' : '-u'} ${found.unit.name}  ${paint(2, '(auto: runs as a systemd service)')}` });
      break;
    case 'files':
      for (const f of found.files) { tailFile(f); lines.push({ ok: true, text: `file ${f}  ${paint(2, `(auto: where ${found.proc.name} writes its output)`)}` }); }
      break;
    case 'unreadable': {
      const where = found.outs.some((o) => o.type === 'terminal') ? 'prints to a terminal' : 'writes to a pipe';
      lines.push({ ok: false, text: `${found.proc.name} (pid ${found.proc.pid}) ${where}, which devtap can't read from outside. To get its logs, either:` });
      lines.push({ ok: null, text: `devtap ${target.port} --attach        ${paint(2, 'capture it live, no restart (uses strace + sudo)')}` });
      lines.push({ ok: null, text: `${restartHint(found.proc, found.launcher)}  ${paint(2, 'restart it through devtap')}` });
      note(`${found.proc.name} (pid ${found.proc.pid}) ${where}; run devtap with --attach to capture its output`);
      break;
    }
    case 'nothing':
      lines.push({ ok: false, text: `nothing is listening on :${target.port} yet. devtap will forward requests once something is.` });
      break;
    case 'foreign':
      lines.push({ ok: false, text: `:${target.port} belongs to another user's process (root?), so devtap can't see its output. Use -l, --docker or --journal.` });
      break;
  }
  return lines;
}

// ---------------------------------------------------------------- inspector UI server

const UI_PATH = path.join(__dirname, 'ui.html');
const proxyHost = ['0.0.0.0', '::'].includes(opts.host) ? '127.0.0.1' : opts.host;

function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

function replay(e) {
  return new Promise((resolve, reject) => {
    const r = http.request({
      host: proxyHost, port: opts.port, method: e.method, path: e.url,
      headers: { ...e.reqHeaders, 'x-devtap-replay': String(e.reqHeaders['x-devtap-replay'] || e.id) },
    });
    r.on('response', (rr) => { rr.resume(); resolve(); });
    r.on('error', reject);
    r.end(Buffer.concat(e._req.chunks));
  });
}

function handleUi(req, res) {
  const { pathname } = new URL(req.url, 'http://ui');
  let m;
  if (pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(fs.readFileSync(UI_PATH));
  }
  if (pathname === '/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(`event: init\ndata: ${JSON.stringify({ config, items: [...items.values()].map(summary) })}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if ((m = /^\/api\/entry\/(\d+)$/.exec(pathname))) {
    const e = items.get(Number(m[1]));
    return e ? json(res, 200, detail(e)) : json(res, 404, { error: 'not found (evicted or cleared)' });
  }
  if (req.method === 'POST' && (m = /^\/api\/replay\/(\d+)$/.exec(pathname))) {
    const e = items.get(Number(m[1]));
    if (!e || e.kind !== 'http') return json(res, 404, { error: 'not found' });
    if (e._req.size > e._req.kept) return json(res, 400, { error: 'request body was truncated; cannot replay' });
    return replay(e).then(() => json(res, 200, { ok: true }), (err) => json(res, 502, { error: err.message }));
  }
  if (req.method === 'POST' && pathname === '/api/clear') {
    items.clear();
    broadcast('clear', {});
    return json(res, 200, { ok: true });
  }
  json(res, 404, { error: 'not found' });
}

// ---------------------------------------------------------------- boot

function listenAuto(server, port, host, explicit, what) {
  return new Promise((resolve) => {
    const attempt = (p, tries) => {
      if (target.local && p === target.port && !explicit) return attempt(p + 1, tries + 1);
      // A failed listen() keeps its callback, so wire both events by hand and remove them each try.
      const onListening = () => { server.off('error', onError); resolve(p); };
      const onError = (err) => {
        server.off('listening', onListening);
        if (err.code === 'EADDRINUSE' && !explicit && tries < 30) return attempt(p + 1, tries + 1);
        if (err.code === 'EADDRINUSE') die(`port ${p} (${what}) is already in use. Pick another with ${what === 'proxy' ? '--port' : '--ui'} <n>`);
        die(err.message);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(p, host);
    };
    attempt(port, 0);
  });
}

function serverRows() {
  const containers = discover.dockerContainers();
  const rows = [];
  for (const l of discover.listeners()) {
    const c = containers.find((x) => x.published.some((p) => p.host === l.port));
    if (c) rows.push({ port: l.port, what: `docker: ${c.name}`, detail: c.image });
    else if (l.pid) rows.push({ port: l.port, what: `${l.name} (pid ${l.pid})`, detail: l.cmd });
  }
  return rows.filter((r) => !/^devtap\b/.test(r.detail) && !r.detail.includes('devtap.js'));
}

function printRows(rows, numbered) {
  const w = Math.max(...rows.map((r) => r.what.length));
  rows.forEach((r, i) => {
    const detail = r.detail.length > 70 ? `${r.detail.slice(0, 69)}…` : r.detail;
    console.log(`  ${numbered ? paint(36, `${String(i + 1).padStart(2)})`) + ' ' : ''}${paint(1, String(r.port).padEnd(6))} ${r.what.padEnd(w)}  ${paint(2, detail)}`);
  });
}

function listPorts() {
  const rows = serverRows();
  if (!rows.length) return console.log('No servers of yours are listening right now.');
  console.log('');
  printRows(rows, false);
  console.log(`\n  Connect with: ${paint(1, 'devtap <port>')}\n`);
}

async function pickTarget() {
  const rows = serverRows();
  if (!rows.length) die('no running servers found. Start one, or pass a port: devtap 8080 (see devtap --help)');
  if (!process.stdin.isTTY) { listPorts(); die('pass the port to connect to, e.g. devtap 8080'); }
  console.log(`\n  ${paint('1;36', 'devtap')}  Which server do you want to inspect?\n`);
  printRows(rows, true);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  for (;;) {
    const answer = (await new Promise((r) => rl.question(`\n  Number or port ${paint(2, '[1]')}: `, r))).trim();
    const n = answer === '' ? 1 : Number(answer);
    const row = rows[n - 1] || rows.find((r) => r.port === n);
    if (row) { rl.close(); return String(row.port); }
    console.log(paint(33, `  "${answer}" isn't in the list.`));
  }
}

function openBrowser(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch {}
}

function portFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, () => probe.close(() => resolve(true))); // all interfaces, like most servers bind
  });
}

async function freePort(from, avoid) {
  for (let p = from; p < from + 200; p++) if (!avoid.includes(p) && await portFree(p)) return p;
  die(`couldn't find a free port above ${from} for your server`);
}

// --swap: tell the user quickly if their server ignored $PORT and tried to take the proxy's port.
function watchSwap(appPort) {
  let done = false;
  const warn = (msg) => {
    if (done) return;
    done = true;
    note(msg);
    console.log(paint(33, `\n  ${msg}\n`));
  };
  const bindFailed = (item) => {
    if (item.source !== 'devtap' && /address already in use|EADDRINUSE|bind: .*in use/i.test(item.text)) {
      warn(`Your server couldn't bind a port. It probably ignores $${opts.portEnv} and tried to take :${appPort}, which devtap now owns. Make it read the port from $${opts.portEnv} (see README), or pass the env var it uses with --port-env.`);
    }
  };
  logWatchers.add(bindFailed);
  const started = Date.now();
  const timer = setInterval(() => {
    const up = discover.listeners().some((l) => l.port === target.port);
    if (up || done) { clearInterval(timer); logWatchers.delete(bindFailed); if (up && !done) note(`your server is up on :${target.port}`); return; }
    if (Date.now() - started > 60_000) {
      clearInterval(timer);
      warn(`Nothing is listening on :${target.port} after a minute. If your server doesn't read $${opts.portEnv}, it won't move there; pass the env var it uses with --port-env.`);
    }
  }, 1000);
  timer.unref();
}

async function main() {
  if (opts.subcommand === 'ports') return listPorts();
  setTarget(opts.target ?? await pickTarget());
  const appPort = target.port;
  if (opts.swap) {
    if (!target.local) die('--swap only works for a server on this machine');
    opts.port = appPort;
    opts.portSet = true;
    if (!(await portFree(appPort))) die(`something is already running on :${appPort}. Stop it first: with --swap, devtap takes that port and starts your server on another one.`);
  }

  const proxy = http.createServer(handleRequest);
  proxy.on('upgrade', handleUpgrade);
  proxy.keepAliveTimeout = 65_000;
  const ui = http.createServer(handleUi);

  opts.port = await listenAuto(proxy, opts.port, opts.host, opts.portSet, 'proxy');
  config = {
    target: target.href,
    proxy: `http://${['127.0.0.1', '0.0.0.0', '::'].includes(opts.host) ? 'localhost' : opts.host}:${opts.port}`,
    command: opts.cmd ? opts.cmd.join(' ') : null,
    maxBody: opts.maxBody,
    logSources: [],
  };
  opts.ui = await listenAuto(ui, opts.ui, '127.0.0.1', opts.uiSet, 'ui');
  if (opts.swap) {
    setTarget(`localhost:${await freePort(appPort + 1, [opts.ui])}`);
    config.target = target.href;
    watchSwap(appPort);
  }
  setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 15_000).unref();

  const owner = target.local ? discover.listeners().find((l) => l.port === target.port && l.pid) : null;
  const logLines = setupLogs();
  config.logSources = logLines.filter((l) => l.ok).map((l) => l.text.replace(/\x1b\[[\d;]*m/g, ''));
  const uiUrl = `http://localhost:${opts.ui}`;
  const mark = (ok) => (ok === true ? paint(32, '✓') : ok === false ? paint(33, '!') : ' ');

  console.log(`
  ${paint('1;36', 'devtap')}  ${paint(2, 'connected to')} ${target.href}${owner ? paint(2, `  (${owner.name}, pid ${owner.pid})`) : ''}

  ${paint(1, 'Use your app at')}   ${paint(32, config.proxy)}   ${paint(2, opts.swap ? `← same as before; your server now runs on :${target.port} (${opts.portEnv}=${target.port})` : `← send requests here instead of :${target.port}`)}
  ${paint(1, 'Inspector')}         ${paint(36, uiUrl)}
  ${paint(1, 'Logs')}              ${logLines.length ? logLines.map((l, i) => `${i ? '                    ' : ''}${mark(l.ok)} ${l.text}`).join('\n') : paint(2, 'none (see devtap --help for -l, --docker, --journal, --attach)')}
`);
  if (opts.open) openBrowser(uiUrl);
}

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const alive = procs.filter((p) => p.exitCode === null && p.signalCode === null);
  const signal = (p, sig) => {
    try { if (p.group) return process.kill(-p.pid, sig); } catch {}
    try { p.kill(sig); } catch {}
  };
  for (const p of alive) signal(p, 'SIGINT');
  if (!alive.length) process.exit(0);
  setTimeout(() => { for (const p of alive) signal(p, 'SIGKILL'); process.exit(0); }, 3000).unref();
  Promise.all(alive.map((p) => new Promise((r) => p.once('exit', r)))).then(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main();
