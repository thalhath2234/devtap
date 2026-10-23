// Demo backend for trying devtap: JSON API, gzip, errors, slow route, SSE, WebSocket echo.
const http = require('node:http');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const PORT = Number(process.env.PORT || 3000);
const users = [{ id: 1, name: 'Ada Lovelace', roles: ['admin'], profile: { city: 'London', active: true } }, { id: 2, name: 'Alan Turing', roles: [], profile: { city: 'Wilmslow', active: false } }];

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    console.log(`${req.method} ${req.url}`);
    const url = new URL(req.url, 'http://x');
    const send = (status, data, type = 'application/json') => { res.writeHead(status, { 'content-type': type }); res.end(typeof data === 'string' ? data : JSON.stringify(data)); };
    if (url.pathname === '/api/users' && req.method === 'GET') {
      const json = JSON.stringify({ data: users, page: Number(url.searchParams.get('page') || 1), total: users.length });
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'set-cookie': ['session=abc123; HttpOnly; Path=/', 'theme=dark; Path=/'] });
      return res.end(zlib.gzipSync(json));
    }
    if (url.pathname === '/api/users' && req.method === 'POST') {
      let u; try { u = JSON.parse(body); } catch { console.error('Error: invalid JSON body'); return send(400, { error: 'invalid JSON' }); }
      console.log(JSON.stringify({ level: 30, msg: 'user created', userId: 3, name: u.name }));
      return send(201, { id: 3, ...u });
    }
    if (url.pathname === '/api/crash') { console.error('Error: database connection lost\n    at query (/app/db.js:42:11)'); return send(500, { error: 'internal error' }); }
    if (url.pathname === '/api/slow') return setTimeout(() => send(200, { ok: true, waited: 1500 }), 1500);
    if (url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      let n = 0; const t = setInterval(() => { res.write(`event: tick\ndata: ${JSON.stringify({ n: ++n })}\n\n`); if (n === 3) { clearInterval(t); res.end(); } }, 200);
      return;
    }
    if (url.pathname === '/') return send(200, '<!doctype html><h1>Demo app</h1><p>Hello from the demo server.</p>', 'text/html');
    console.warn(`warn: no route for ${url.pathname}`);
    send(404, { error: 'not found' });
  });
});

server.on('upgrade', (req, socket) => {
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const frame = (op, payload) => { const p = Buffer.from(payload); const h = p.length < 126 ? Buffer.from([0x80 | op, p.length]) : Buffer.from([0x80 | op, 126, p.length >> 8, p.length & 255]); return Buffer.concat([h, p]); };
  socket.write(frame(1, JSON.stringify({ type: 'welcome', at: Date.now() })));
  socket.on('data', (d) => {
    const op = d[0] & 15; let len = d[1] & 127, off = 2; if (len === 126) { len = d.readUInt16BE(2); off = 4; }
    const mask = d.subarray(off, off + 4); const p = Buffer.from(d.subarray(off + 4, off + 4 + len)); for (let i = 0; i < p.length; i++) p[i] ^= mask[i & 3];
    if (op === 8) { socket.end(frame(8, p)); return; }
    console.log(`ws message: ${p}`);
    socket.write(frame(1, JSON.stringify({ type: 'echo', data: JSON.parse(p.toString() || 'null') })));
  });
  socket.on('error', () => {});
});

server.listen(PORT, () => console.log(`demo server listening on http://localhost:${PORT}`));
